/* eslint-disable jsdoc/require-jsdoc */

import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import type { IndexWorker } from './index-worker';

/** Subscribe-then-drain dispatcher for durable index tasks. */
export class IndexTaskConsumer {
    private controller: AbortController | null = null;
    private loopTask: Promise<void> | null = null;
    private readonly inflight = new Set<Promise<void>>();

    constructor(
        private readonly messageBus: MessageBus,
        private readonly worker: IndexWorker,
        private readonly maxBatch = 32
    ) {}

    async start(): Promise<this> {
        if (this.loopTask) return this;
        this.controller = new AbortController();
        let ready!: () => void;
        const readyPromise = new Promise<void>(resolve => {
            ready = resolve;
        });
        this.loopTask = this.loop(this.controller.signal, ready);
        await readyPromise;
        await this.drainAndDispatch();
        return this;
    }

    async stop(): Promise<void> {
        this.controller?.abort();
        await this.loopTask;
        this.controller = null;
        this.loopTask = null;
        await Promise.allSettled(this.inflight);
        this.inflight.clear();
    }

    async drainAndDispatch(): Promise<void> {
        let entries;
        try {
            entries = await this.messageBus.queueDrain(
                MessageBusKeys.indexTasksQueue(),
                this.maxBatch
            );
        } catch {
            return;
        }
        for (const [, payload] of entries) {
            if (
                typeof payload.user_id !== 'string' ||
                typeof payload.knowledge_base_id !== 'string' ||
                typeof payload.document_id !== 'string'
            ) {
                continue;
            }
            const task = this.worker
                .process(payload.user_id, payload.knowledge_base_id, payload.document_id)
                .finally(() => this.inflight.delete(task));
            this.inflight.add(task);
        }
    }

    private async loop(signal: AbortSignal, ready: () => void): Promise<void> {
        try {
            for await (const _signal of this.messageBus.subscribe(
                MessageBusKeys.indexTasksSignal(),
                { signal, onReady: ready }
            )) {
                await this.drainAndDispatch();
            }
        } catch (error) {
            if (!signal.aborted) throw error;
        } finally {
            ready();
        }
    }
}
