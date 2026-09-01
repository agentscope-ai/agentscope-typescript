/* eslint-disable jsdoc/require-jsdoc */

import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { WorkspaceManagerBase, type IsolationPolicy } from './base';
import { PrewarmedWorkspaceManager, type PrewarmConfig } from './prewarm';

interface CacheEntry<TWorkspace> {
    workspace: TWorkspace;
    lastAccess: number;
}

class AsyncMutex {
    private tail = Promise.resolve();

    async run<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release = (): void => {};
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }
}

class WorkspaceCache<TWorkspace extends WorkspaceBase> {
    private readonly entries = new Map<string, CacheEntry<TWorkspace>>();
    private readonly mutex = new AsyncMutex();

    async getOrCreate(workspaceId: string, create: () => Promise<TWorkspace>): Promise<TWorkspace> {
        return this.mutex.run(async () => {
            const cached = this.entries.get(workspaceId);
            if (cached) {
                cached.lastAccess = Date.now();
                return cached.workspace;
            }
            const workspace = await create();
            this.entries.set(workspaceId, { workspace, lastAccess: Date.now() });
            return workspace;
        });
    }

    async adopt(workspace: TWorkspace): Promise<void> {
        await this.mutex.run(async () => {
            this.entries.set(workspace.workspaceId, {
                workspace,
                lastAccess: Date.now(),
            });
        });
    }

    async remove(workspaceId: string): Promise<TWorkspace | null> {
        return this.mutex.run(async () => {
            const entry = this.entries.get(workspaceId);
            this.entries.delete(workspaceId);
            return entry?.workspace ?? null;
        });
    }

    async removeAll(): Promise<TWorkspace[]> {
        return this.mutex.run(async () => {
            const workspaces = [...this.entries.values()].map(entry => entry.workspace);
            this.entries.clear();
            return workspaces;
        });
    }

    async removeExpired(now: number, ttlMs: number): Promise<TWorkspace[]> {
        return this.mutex.run(async () => {
            const expired: TWorkspace[] = [];
            for (const [workspaceId, entry] of this.entries) {
                if (now - entry.lastAccess > ttlMs) {
                    this.entries.delete(workspaceId);
                    expired.push(entry.workspace);
                }
            }
            return expired;
        });
    }
}

export interface CachedWorkspaceManagerOptions {
    isolation?: IsolationPolicy;
    ttlMs?: number;
    sweepIntervalMs?: number;
}

interface BuildWorkspaceOptions {
    workspaceId: string;
    userId: string;
    agentId: string;
}

interface CacheOwner<TWorkspace extends WorkspaceBase> {
    readonly cache: WorkspaceCache<TWorkspace>;
    readonly ttlMs: number;
    readonly sweepIntervalMs: number;
    sweepTimer: ReturnType<typeof setInterval> | null;
}

/** Shared coalesced cache and TTL lifecycle for non-prewarmed managers. */
export abstract class CachedWorkspaceManager<TWorkspace extends WorkspaceBase>
    extends WorkspaceManagerBase<TWorkspace>
    implements CacheOwner<TWorkspace>
{
    readonly ttlMs: number;
    readonly sweepIntervalMs: number;
    readonly cache = new WorkspaceCache<TWorkspace>();
    sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: CachedWorkspaceManagerOptions = {}) {
        super({ isolation: options.isolation });
        this.ttlMs = options.ttlMs ?? 3_600_000;
        this.sweepIntervalMs = options.sweepIntervalMs ?? 300_000;
        validateCacheDurations(this.ttlMs, this.sweepIntervalMs);
    }

    async getWorkspace(
        userId: string,
        agentId: string,
        sessionId: string,
        workspaceId?: string | null
    ): Promise<TWorkspace> {
        const binding =
            workspaceId || (await this.assignWorkspaceId({ userId, agentId, sessionId }));
        return this.cache.getOrCreate(binding, () =>
            this.buildWorkspace({ workspaceId: binding, userId, agentId })
        );
    }

    async open(): Promise<this> {
        startSweeper(this);
        return this;
    }

    async closeManager(): Promise<void> {
        stopSweeper(this);
        await this.closeAll();
    }

    async close(workspaceId: string): Promise<void> {
        const workspace = await this.cache.remove(workspaceId);
        if (workspace) await safeClose(workspace);
    }

    async closeAll(): Promise<void> {
        await Promise.allSettled((await this.cache.removeAll()).map(safeClose));
    }

    async sweepOnce(): Promise<void> {
        await Promise.allSettled(
            (await this.cache.removeExpired(Date.now(), this.ttlMs)).map(safeClose)
        );
    }

    protected abstract buildWorkspace(options: BuildWorkspaceOptions): Promise<TWorkspace>;
}

export interface CachedPrewarmedWorkspaceManagerOptions extends CachedWorkspaceManagerOptions {
    prewarm?: PrewarmConfig;
}

/** Shared coalesced cache, TTL, and buffer lifecycle for prewarmed managers. */
export abstract class CachedPrewarmedWorkspaceManager<TWorkspace extends WorkspaceBase>
    extends PrewarmedWorkspaceManager<TWorkspace>
    implements CacheOwner<TWorkspace>
{
    readonly ttlMs: number;
    readonly sweepIntervalMs: number;
    readonly cache = new WorkspaceCache<TWorkspace>();
    sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: CachedPrewarmedWorkspaceManagerOptions = {}) {
        super({ isolation: options.isolation, prewarm: options.prewarm });
        this.ttlMs = options.ttlMs ?? 3_600_000;
        this.sweepIntervalMs = options.sweepIntervalMs ?? 300_000;
        validateCacheDurations(this.ttlMs, this.sweepIntervalMs);
    }

    async getWorkspace(
        userId: string,
        agentId: string,
        sessionId: string,
        workspaceId?: string | null
    ): Promise<TWorkspace> {
        const binding =
            workspaceId || (await this.assignWorkspaceId({ userId, agentId, sessionId }));
        return this.cache.getOrCreate(binding, () =>
            this.buildWorkspace({ workspaceId: binding, userId, agentId })
        );
    }

    async open(): Promise<this> {
        this.startPrewarm();
        startSweeper(this);
        return this;
    }

    async closeManager(): Promise<void> {
        stopSweeper(this);
        await this.stopPrewarm();
        await this.closeAll();
    }

    async close(workspaceId: string): Promise<void> {
        const workspace = await this.cache.remove(workspaceId);
        if (workspace) await safeClose(workspace);
    }

    async closeAll(): Promise<void> {
        await Promise.allSettled((await this.cache.removeAll()).map(safeClose));
    }

    async sweepOnce(): Promise<void> {
        await Promise.allSettled(
            (await this.cache.removeExpired(Date.now(), this.ttlMs)).map(safeClose)
        );
    }

    protected async adoptPrewarmed(workspace: TWorkspace): Promise<void> {
        await this.cache.adopt(workspace);
    }

    protected abstract buildWorkspace(options: BuildWorkspaceOptions): Promise<TWorkspace>;
}

async function safeClose(workspace: WorkspaceBase): Promise<void> {
    try {
        await workspace.close();
    } catch {
        // Eviction and shutdown cleanup are best-effort.
    }
}

function validateCacheDurations(ttlMs: number, sweepIntervalMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
        throw new Error('ttlMs must be a non-negative finite number.');
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
        throw new Error('sweepIntervalMs must be a positive finite number.');
    }
}

function startSweeper(owner: CacheOwner<WorkspaceBase>): void {
    if (owner.sweepTimer) return;
    owner.sweepTimer = setInterval(() => {
        void owner.cache
            .removeExpired(Date.now(), owner.ttlMs)
            .then(workspaces => Promise.allSettled(workspaces.map(safeClose)));
    }, owner.sweepIntervalMs);
    owner.sweepTimer.unref?.();
}

function stopSweeper(owner: CacheOwner<WorkspaceBase>): void {
    if (owner.sweepTimer) clearInterval(owner.sweepTimer);
    owner.sweepTimer = null;
}
