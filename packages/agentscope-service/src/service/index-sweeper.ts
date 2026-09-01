/* eslint-disable jsdoc/require-jsdoc */

import { enqueueIndexTask } from '../bus-ops';
import type { MessageBus } from '../message-bus';
import type { StorageBase } from '../storage';

/** Periodically re-enqueue expired leases and orphaned pending documents. */
export class IndexSweeper {
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly intervalMs = 60_000,
        private readonly pendingGraceMs = 5 * 60_000
    ) {}

    async start(): Promise<void> {
        if (this.timer) return;
        await this.sweepOnce();
        this.timer = setInterval(() => {
            void this.sweepOnce().catch(() => undefined);
        }, this.intervalMs);
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    async sweepOnce(now = new Date()): Promise<number> {
        const [expired, pending] = await Promise.all([
            this.storage.listKnowledgeDocumentsWithExpiredLease(now),
            this.storage.listKnowledgeDocumentsPendingSince(
                new Date(now.getTime() - this.pendingGraceMs)
            ),
        ]);
        const seen = new Set<string>();
        for (const record of [...expired, ...pending]) {
            if (seen.has(record.id)) continue;
            seen.add(record.id);
            try {
                await enqueueIndexTask(this.messageBus, {
                    userId: record.user_id,
                    knowledgeBaseId: record.knowledge_base_id,
                    documentId: record.id,
                });
            } catch {
                // A single publish failure must not prevent later records from being recovered.
            }
        }
        return seen.size;
    }
}
