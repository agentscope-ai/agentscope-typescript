/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

import type { BusPayload, MessageBus } from './message-bus';
import { MessageBusKeys } from './message-bus';

/** Push an inbox payload and wake the session when no run is consuming it. */
export async function deliverToInbox(
    bus: MessageBus,
    options: {
        userId: string;
        sessionId: string;
        agentId: string;
        payload: BusPayload;
    }
): Promise<void> {
    const consumer = await bus.withLock(
        MessageBusKeys.inboxLock(options.sessionId),
        async () => {
            await bus.queuePush(MessageBusKeys.inbox(options.sessionId), options.payload);
            return bus.registryGet(
                MessageBusKeys.inboxConsumer(options.sessionId),
                MessageBusKeys.INBOX_CONSUMER_FIELD
            );
        },
        { ttlSeconds: MessageBusKeys.INBOX_LOCK_TTL_SECS }
    );

    if (consumer === null) {
        await bus.enqueueWakeup(options.userId, options.sessionId, options.agentId);
    }
}

/** Mark a session run as the active consumer for inbox payloads. */
export async function registerInboxConsumer(bus: MessageBus, sessionId: string): Promise<void> {
    await bus.registrySet(
        MessageBusKeys.inboxConsumer(sessionId),
        MessageBusKeys.INBOX_CONSUMER_FIELD,
        '1',
        { ttlSeconds: MessageBusKeys.SESSION_RUN_TTL_SECS }
    );
}

/** Preserve and report pending inbox payloads, or release an empty consumer lease. */
export async function hasPendingInboxOrRelease(
    bus: MessageBus,
    sessionId: string
): Promise<boolean> {
    return bus.withLock(
        MessageBusKeys.inboxLock(sessionId),
        async () => {
            const inbox = MessageBusKeys.inbox(sessionId);
            const payloads: BusPayload[] = [];
            while (true) {
                const batch = await bus.queueDrain(inbox, 100);
                if (batch.length === 0) break;
                payloads.push(...batch.map(([, payload]) => payload));
            }

            if (payloads.length === 0) {
                await bus.registryDelete(
                    MessageBusKeys.inboxConsumer(sessionId),
                    MessageBusKeys.INBOX_CONSUMER_FIELD
                );
                return false;
            }

            for (const payload of payloads) await bus.queuePush(inbox, payload);
            return true;
        },
        { ttlSeconds: MessageBusKeys.INBOX_LOCK_TTL_SECS }
    );
}

/** Release a failed run's consumer lease and wake it again when work remains. */
export async function abandonInboxConsumer(
    bus: MessageBus,
    options: { userId: string; sessionId: string; agentId: string }
): Promise<void> {
    if (!(await hasPendingInboxOrRelease(bus, options.sessionId))) return;
    await bus.registryDelete(
        MessageBusKeys.inboxConsumer(options.sessionId),
        MessageBusKeys.INBOX_CONSUMER_FIELD
    );
    await bus.enqueueWakeup(options.userId, options.sessionId, options.agentId);
}
