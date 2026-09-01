/* eslint-disable jsdoc/require-jsdoc */

import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { WorkspaceManagerBase } from './base';

export interface PrewarmConfig {
    size?: number;
    maxCreating?: number;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve = (_value: T): void => {};
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

/** Pre-built single-use workspace buffer shared by remote managers. */
export abstract class PrewarmedWorkspaceManager<
    TWorkspace extends WorkspaceBase,
> extends WorkspaceManagerBase<TWorkspace> {
    private config: Required<PrewarmConfig>;
    private readonly slots: Array<Deferred<TWorkspace | null>> = [];
    private readonly tasks = new Set<Promise<void>>();
    private readonly built = new Set<TWorkspace>();
    private activeCreates = 0;
    private readonly createWaiters: Array<() => void> = [];

    constructor(
        options: {
            isolation?: 'per_session' | 'per_agent' | 'per_user';
            prewarm?: PrewarmConfig;
        } = {}
    ) {
        super({ isolation: options.isolation });
        const size = options.prewarm?.size ?? 0;
        const maxCreating = options.prewarm?.maxCreating ?? 4;
        if (!Number.isInteger(size) || size < 0) {
            throw new Error('prewarm.size must be a non-negative integer.');
        }
        if (!Number.isInteger(maxCreating) || maxCreating <= 0) {
            throw new Error('prewarm.maxCreating must be a positive integer.');
        }
        this.config = { size, maxCreating };
    }

    protected startPrewarm(): void {
        this.refill();
    }

    protected async stopPrewarm(): Promise<void> {
        this.config = { ...this.config, size: 0 };
        await Promise.allSettled([...this.tasks]);
        this.slots.splice(0);
        const unclaimed = [...this.built];
        this.built.clear();
        await Promise.allSettled(unclaimed.map(workspace => this.disposePrewarmed(workspace)));
    }

    protected abstract createPrewarmed(): Promise<TWorkspace>;
    protected abstract adoptPrewarmed(workspace: TWorkspace): Promise<void>;

    protected async disposePrewarmed(workspace: TWorkspace): Promise<void> {
        await workspace.close();
    }

    protected override async mintWorkspaceId(signal?: AbortSignal): Promise<string> {
        if (this.config.size === 0) return super.mintWorkspaceId(signal);
        const slot = this.slots.shift();
        this.refill();
        if (!slot) return super.mintWorkspaceId(signal);

        let workspace: TWorkspace | null;
        try {
            workspace = await this.waitForSlot(slot.promise, signal);
        } catch (error) {
            if (signal?.aborted) {
                void slot.promise.then(async built => {
                    if (!built) return;
                    this.built.delete(built);
                    await this.disposePrewarmed(built);
                });
            }
            throw error;
        }
        if (!workspace) return super.mintWorkspaceId(signal);
        try {
            await this.adoptPrewarmed(workspace);
        } catch (error) {
            this.built.delete(workspace);
            await this.disposePrewarmed(workspace);
            throw error;
        }
        this.built.delete(workspace);
        return workspace.workspaceId;
    }

    private refill(): void {
        while (this.slots.length < this.config.size) {
            const slot = deferred<TWorkspace | null>();
            this.slots.push(slot);
            const task = this.fillSlot(slot);
            this.tasks.add(task);
            void task.finally(() => this.tasks.delete(task));
        }
    }

    private async fillSlot(slot: Deferred<TWorkspace | null>): Promise<void> {
        let workspace: TWorkspace;
        try {
            workspace = await this.withCreatePermit(() => this.createPrewarmed());
            this.built.add(workspace);
        } catch {
            const index = this.slots.indexOf(slot);
            if (index >= 0) this.slots.splice(index, 1);
            slot.resolve(null);
            return;
        }
        slot.resolve(workspace);
    }

    private async withCreatePermit<T>(work: () => Promise<T>): Promise<T> {
        if (this.activeCreates >= this.config.maxCreating) {
            await new Promise<void>(resolve => this.createWaiters.push(resolve));
        }
        this.activeCreates += 1;
        try {
            return await work();
        } finally {
            this.activeCreates -= 1;
            this.createWaiters.shift()?.();
        }
    }

    private async waitForSlot<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return promise;
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        let abort = (): void => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
        });
        try {
            return await Promise.race([promise, aborted]);
        } finally {
            signal.removeEventListener('abort', abort);
        }
    }
}
