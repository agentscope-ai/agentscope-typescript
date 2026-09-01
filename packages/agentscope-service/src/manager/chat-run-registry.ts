/* eslint-disable jsdoc/require-jsdoc */

import { ManagedTask, type AbortableWork } from './task';

export interface SpawnChatRunOptions {
    sessionId: string;
    name?: string;
}

/** Per-process registry of active chat runs, keyed by session id. */
export class ChatRunRegistry {
    private readonly tasks = new Map<string, ManagedTask>();

    spawn(work: AbortableWork<void>, options: SpawnChatRunOptions): ManagedTask {
        const existing = this.tasks.get(options.sessionId);
        if (existing && !existing.settled) {
            throw new Error(
                `Session ${JSON.stringify(options.sessionId)} already has an active chat run ` +
                    'in this process.'
            );
        }
        const task = new ManagedTask(work, options.name ?? `chat-run:${options.sessionId}`);
        this.tasks.set(options.sessionId, task);
        const cleanup = (): void => {
            if (this.tasks.get(options.sessionId) === task) this.tasks.delete(options.sessionId);
        };
        void task.promise.then(cleanup, cleanup);
        return task;
    }

    get(sessionId: string): ManagedTask | null {
        return this.tasks.get(sessionId) ?? null;
    }

    async open(): Promise<this> {
        return this;
    }

    async close(): Promise<void> {
        const tasks = [...this.tasks.values()];
        for (const task of tasks) task.cancel();
        await Promise.allSettled(tasks.map(task => task.promise));
        this.tasks.clear();
    }
}
