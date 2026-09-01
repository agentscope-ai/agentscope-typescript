/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { EventType } from '@agentscope-ai/agentscope/event';

import type { BusPayload, MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';

export const CHANNEL_SUBSCRIBE_TIMEOUT_MS = 5_000;

const terminalEvents = new Set<string>([
    EventType.REPLY_END,
    EventType.REQUIRE_USER_CONFIRM,
    EventType.REQUIRE_EXTERNAL_EXECUTION,
]);

class AsyncQueue<T> {
    private readonly buffered: T[] = [];
    private readonly waiters: Array<{
        resolve: (value: T) => void;
        reject: (reason: unknown) => void;
    }> = [];
    private failure: unknown;

    push(value: T): void {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.buffered.push(value);
    }

    fail(error: unknown): void {
        this.failure = error;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }

    async take(signal: AbortSignal): Promise<T> {
        const buffered = this.buffered.shift();
        if (buffered !== undefined) return buffered;
        if (this.failure !== undefined) throw this.failure;
        if (signal.aborted) throw signal.reason;
        return new Promise<T>((resolve, reject) => {
            let waiter!: (typeof this.waiters)[number];
            const abort = (): void => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(signal.reason);
            };
            waiter = {
                resolve: value => {
                    signal.removeEventListener('abort', abort);
                    resolve(value);
                },
                reject: error => {
                    signal.removeEventListener('abort', abort);
                    reject(error);
                },
            };
            this.waiters.push(waiter);
            signal.addEventListener('abort', abort, { once: true });
        });
    }
}

function waitUntilReady(ready: Promise<void>, controller: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timeout);
            reject(controller.signal.reason);
        };
        const timeout = setTimeout(() => {
            const error = new Error('Timed out opening the channel reply subscription.');
            controller.abort(error);
            reject(error);
        }, CHANNEL_SUBSCRIBE_TIMEOUT_MS);
        controller.signal.addEventListener('abort', abort, { once: true });
        ready.then(
            () => {
                clearTimeout(timeout);
                controller.signal.removeEventListener('abort', abort);
                resolve();
            },
            error => {
                clearTimeout(timeout);
                controller.signal.removeEventListener('abort', abort);
                reject(error);
            }
        );
        if (controller.signal.aborted) abort();
    });
}

/** Open a live subscription, then return a replay-to-live gap-free event reader. */
export async function openReplyStream(
    bus: MessageBus,
    sessionId: string,
    signal?: AbortSignal
): Promise<AsyncGenerator<BusPayload, void, void>> {
    const eventKey = MessageBusKeys.sessionEvents(sessionId);
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);

    let markReady!: () => void;
    const ready = new Promise<void>(resolve => {
        markReady = resolve;
    });
    const queue = new AsyncQueue<BusPayload>();
    const feeder = (async () => {
        try {
            for await (const event of bus.subscribe(eventKey, {
                onReady: markReady,
                signal: controller.signal,
            })) {
                queue.push(event);
            }
            if (!controller.signal.aborted) {
                queue.fail(new Error('The channel reply subscription ended unexpectedly.'));
            }
        } catch (error) {
            if (!controller.signal.aborted) queue.fail(error);
        }
    })();

    try {
        await waitUntilReady(ready, controller);
    } catch (error) {
        controller.abort(error);
        await feeder;
        signal?.removeEventListener('abort', abort);
        throw error;
    }

    async function* read(): AsyncGenerator<BusPayload, void, void> {
        const seen = new Set<string>();
        try {
            for (const [entryId, event] of await bus.logRead(
                eventKey,
                undefined,
                MessageBusKeys.SESSION_REPLAY_MAX_LEN
            )) {
                seen.add(String(entryId));
                yield event;
                if (terminalEvents.has(String(event.type ?? ''))) return;
            }
            while (true) {
                const event = await queue.take(controller.signal);
                const entryId = event._entry_id;
                if (entryId !== null && entryId !== undefined) {
                    const normalized = String(entryId);
                    if (seen.has(normalized)) continue;
                    seen.add(normalized);
                }
                yield event;
                if (terminalEvents.has(String(event.type ?? ''))) return;
            }
        } finally {
            controller.abort();
            await feeder;
            signal?.removeEventListener('abort', abort);
        }
    }
    return read();
}

export const open_reply_stream = openReplyStream;
