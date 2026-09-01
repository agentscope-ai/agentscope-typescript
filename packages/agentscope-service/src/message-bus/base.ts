/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { MessageBusKeys } from './keys';
import type { RunTriggerKind } from './keys';

export type BusPayload = Record<string, unknown>;
export type BusEntry = readonly [entryId: string, payload: BusPayload];

export interface MessageBusLock {
    readonly key: string;
    release(): Promise<void>;
}

export interface SubscribeOptions {
    onReady?: () => void;
    signal?: AbortSignal;
}

/** Generic live transport contract for queues, logs, broadcasts, locks, and registries. */
export abstract class MessageBus {
    async open(): Promise<this> {
        return this;
    }

    async close(): Promise<void> {}

    abstract queuePush(
        key: string,
        payload: BusPayload,
        options?: { ttlSeconds?: number }
    ): Promise<string>;
    abstract queueDrain(key: string, maxCount?: number): Promise<BusEntry[]>;
    abstract queueDelete(key: string): Promise<void>;

    abstract logAppend(
        key: string,
        payload: BusPayload,
        options?: { ttlSeconds?: number; maxLength?: number }
    ): Promise<string>;
    abstract logRead(key: string, since?: string, maxCount?: number): Promise<BusEntry[]>;
    abstract logTrim(key: string, beforeId?: string): Promise<void>;

    abstract publish(key: string, payload: BusPayload): Promise<void>;
    abstract subscribe(key: string, options?: SubscribeOptions): AsyncIterable<BusPayload>;

    abstract acquireLock(key: string, options?: { ttlSeconds?: number }): Promise<MessageBusLock>;
    abstract isLocked(key: string): Promise<boolean>;
    abstract tryLock(key: string, options?: { ttlSeconds?: number }): Promise<boolean>;
    abstract unlock(key: string): Promise<void>;

    abstract registrySet(
        namespace: string,
        field: string,
        value: string,
        options?: { ttlSeconds?: number }
    ): Promise<void>;
    abstract registryDelete(namespace: string, field: string): Promise<void>;
    abstract registryExists(namespace: string, field: string): Promise<boolean>;
    abstract registryGetAll(namespace: string): Promise<Record<string, string>>;
    abstract registryGet(namespace: string, field: string): Promise<string | null>;
    abstract registryDrop(namespace: string): Promise<void>;

    /** Execute a callback while holding a bus lock. */
    async withLock<T>(
        key: string,
        work: () => Promise<T>,
        options?: { ttlSeconds?: number }
    ): Promise<T> {
        const lock = await this.acquireLock(key, options);
        try {
            return await work();
        } finally {
            await lock.release();
        }
    }

    /** Execute one session run and trim its replay log before unlocking. */
    async sessionRun<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
        return this.withLock(
            MessageBusKeys.sessionLock(sessionId),
            async () => {
                try {
                    return await work();
                } finally {
                    await this.logTrim(MessageBusKeys.sessionEvents(sessionId));
                }
            },
            { ttlSeconds: MessageBusKeys.SESSION_RUN_TTL_SECS }
        );
    }

    async sessionIsRunning(sessionId: string): Promise<boolean> {
        return this.isLocked(MessageBusKeys.sessionLock(sessionId));
    }

    async sessionPublishEvent(sessionId: string, event: BusPayload): Promise<string> {
        const key = MessageBusKeys.sessionEvents(sessionId);
        const entryId = await this.logAppend(key, event, {
            maxLength: MessageBusKeys.SESSION_REPLAY_MAX_LEN,
        });
        await this.publish(key, { ...event, _entry_id: entryId });
        return entryId;
    }

    async sessionReadEvents(
        sessionId: string,
        since?: string,
        maxCount = 1_000
    ): Promise<BusEntry[]> {
        return this.logRead(MessageBusKeys.sessionEvents(sessionId), since, maxCount);
    }

    async *sessionSubscribeEvents(
        sessionId: string,
        options?: SubscribeOptions
    ): AsyncIterable<BusPayload> {
        for await (const payload of this.subscribe(
            MessageBusKeys.sessionEvents(sessionId),
            options
        )) {
            const { _entry_id: _entryId, ...event } = payload;
            yield event;
        }
    }

    async sessionPublishCancel(sessionId: string): Promise<void> {
        await this.publish(MessageBusKeys.sessionCancelChannel(), { session_id: sessionId });
    }

    async *sessionSubscribeCancel(options?: SubscribeOptions): AsyncIterable<string> {
        for await (const payload of this.subscribe(
            MessageBusKeys.sessionCancelChannel(),
            options
        )) {
            if (typeof payload.session_id === 'string') yield payload.session_id;
        }
    }

    async sessionPublishInterrupt(sessionId: string): Promise<void> {
        await this.publish(MessageBusKeys.sessionInterruptChannel(), { session_id: sessionId });
    }

    async *sessionSubscribeInterrupt(options?: SubscribeOptions): AsyncIterable<string> {
        for await (const payload of this.subscribe(
            MessageBusKeys.sessionInterruptChannel(),
            options
        )) {
            if (typeof payload.session_id === 'string') yield payload.session_id;
        }
    }

    async sessionPurge(sessionId: string): Promise<void> {
        await Promise.all([
            this.logTrim(MessageBusKeys.sessionEvents(sessionId)),
            this.queueDelete(MessageBusKeys.inbox(sessionId)),
            this.registryDrop(MessageBusKeys.bgTasks(sessionId)),
        ]);
    }

    async inboxPush(
        sessionId: string,
        message: BusPayload,
        options?: { ttlSeconds?: number }
    ): Promise<string> {
        return this.queuePush(MessageBusKeys.inbox(sessionId), message, options);
    }

    async inboxDrain(sessionId: string, maxCount = 100): Promise<BusEntry[]> {
        return this.queueDrain(MessageBusKeys.inbox(sessionId), maxCount);
    }

    async enqueueWakeup(userId: string, sessionId: string, agentId: string): Promise<void> {
        await this.enqueueInput(userId, sessionId, agentId, {
            kind: MessageBusKeys.WAKEUP_KIND_WAKE,
        });
    }

    async enqueueInput(
        userId: string,
        sessionId: string,
        agentId: string,
        options: { kind: RunTriggerKind; input?: BusPayload | null }
    ): Promise<void> {
        await this.queuePush(MessageBusKeys.wakeupQueue(), {
            user_id: userId,
            session_id: sessionId,
            agent_id: agentId,
            kind: options.kind,
            input: options.input ?? null,
        });
        await this.publish(MessageBusKeys.wakeupSignal(), {});
    }

    async dequeueWakeups(maxCount = 64): Promise<BusPayload[]> {
        return (await this.queueDrain(MessageBusKeys.wakeupQueue(), maxCount)).map(
            ([, payload]) => payload
        );
    }

    subscribeWakeupSignal(options?: SubscribeOptions): AsyncIterable<BusPayload> {
        return this.subscribe(MessageBusKeys.wakeupSignal(), options);
    }

    async backgroundTaskRegister(
        sessionId: string,
        taskId: string,
        metadata: string
    ): Promise<void> {
        await this.registrySet(MessageBusKeys.bgTasks(sessionId), taskId, metadata, {
            ttlSeconds: MessageBusKeys.BG_TASKS_TTL_SECS,
        });
    }

    async backgroundTaskUnregister(sessionId: string, taskId: string): Promise<void> {
        await this.registryDelete(MessageBusKeys.bgTasks(sessionId), taskId);
    }

    async backgroundTaskExists(sessionId: string, taskId: string): Promise<boolean> {
        return this.registryExists(MessageBusKeys.bgTasks(sessionId), taskId);
    }

    async backgroundTaskList(sessionId: string): Promise<Record<string, string>> {
        return this.registryGetAll(MessageBusKeys.bgTasks(sessionId));
    }

    async backgroundTaskPurge(sessionId: string): Promise<void> {
        await this.registryDrop(MessageBusKeys.bgTasks(sessionId));
    }

    async taskPublishCancel(taskId: string): Promise<void> {
        await this.publish(MessageBusKeys.taskCancelChannel(), { task_id: taskId });
    }

    async *taskSubscribeCancel(options?: SubscribeOptions): AsyncIterable<string> {
        for await (const payload of this.subscribe(MessageBusKeys.taskCancelChannel(), options)) {
            if (typeof payload.task_id === 'string') yield payload.task_id;
        }
    }
}
