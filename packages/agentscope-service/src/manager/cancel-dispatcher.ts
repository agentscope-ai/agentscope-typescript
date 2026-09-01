/* eslint-disable jsdoc/require-jsdoc */

import type { MessageBus } from '../message-bus';
import type { BackgroundTaskManager } from './background-task-manager';
import type { ChatRunRegistry } from './chat-run-registry';

/** Three-channel cross-process cancel and interrupt dispatcher. */
export class CancelDispatcher {
    private controller: AbortController | null = null;
    private loops: Promise<void>[] = [];

    constructor(
        private readonly messageBus: MessageBus,
        private readonly registry: ChatRunRegistry,
        private readonly backgroundTasks: BackgroundTaskManager
    ) {}

    async open(): Promise<this> {
        if (this.controller) return this;
        this.controller = new AbortController();
        const ready = [deferred(), deferred(), deferred()];
        this.loops = [
            this.consume(
                this.messageBus.sessionSubscribeCancel({
                    onReady: ready[0].resolve,
                    signal: this.controller.signal,
                }),
                sessionId => this.cancelSession(sessionId),
                this.controller.signal,
                ready[0].resolve
            ),
            this.consume(
                this.messageBus.taskSubscribeCancel({
                    onReady: ready[1].resolve,
                    signal: this.controller.signal,
                }),
                taskId => this.backgroundTasks.cancelTask(taskId),
                this.controller.signal,
                ready[1].resolve
            ),
            this.consume(
                this.messageBus.sessionSubscribeInterrupt({
                    onReady: ready[2].resolve,
                    signal: this.controller.signal,
                }),
                sessionId => this.interruptSession(sessionId),
                this.controller.signal,
                ready[2].resolve
            ),
        ];
        await Promise.all(ready.map(item => item.promise));
        return this;
    }

    async close(): Promise<void> {
        this.controller?.abort();
        await Promise.allSettled(this.loops);
        this.controller = null;
        this.loops = [];
    }

    cancelSession(sessionId: string): void {
        this.registry.get(sessionId)?.cancel();
        this.backgroundTasks.cancelSessionTasks(sessionId);
    }

    interruptSession(sessionId: string): void {
        this.registry.get(sessionId)?.cancel();
    }

    private async consume<T>(
        source: AsyncIterable<T>,
        consume: (value: T) => unknown,
        signal: AbortSignal,
        ready: () => void
    ): Promise<void> {
        const iterator = source[Symbol.asyncIterator]();
        try {
            while (!signal.aborted) {
                const next = await nextOrAbort(iterator, signal);
                if (!next || next.done) return;
                consume(next.value);
            }
        } catch {
            if (!signal.aborted) throw new Error('Cancel dispatcher subscription failed.');
        } finally {
            ready();
            await iterator.return?.();
        }
    }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve = (): void => {};
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function nextOrAbort<T>(
    iterator: AsyncIterator<T>,
    signal: AbortSignal
): Promise<IteratorResult<T> | null> {
    if (signal.aborted) return null;
    let abort = (): void => {};
    const aborted = new Promise<null>(resolve => {
        abort = () => resolve(null);
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([iterator.next(), aborted]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}
