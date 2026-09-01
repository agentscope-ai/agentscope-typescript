/* eslint-disable jsdoc/require-jsdoc */

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { UserMsg } from '@agentscope-ai/agentscope/message';
import { ReplyFinishedReason } from '@agentscope-ai/agentscope/type';

import { ChatRunRegistry, WakeupDispatcher, type WakeupInput } from '../src/manager';
import { InMemoryMessageBus } from '../src/message-bus';
import type { StorageBase } from '../src/storage';

class FakeChatService {
    readonly calls: Array<{
        userId: string;
        sessionId: string;
        agentId: string;
        input: WakeupInput;
        signal: AbortSignal;
    }> = [];

    async run(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        input: WakeupInput;
        signal: AbortSignal;
    }): Promise<void> {
        this.calls.push(options);
    }
}

function fakeStorage(exists = true): StorageBase {
    return {
        async getSession() {
            return exists ? ({ id: 'session' } as never) : null;
        },
    } as unknown as StorageBase;
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for wakeup dispatch.');
}

describe('WakeupDispatcher', () => {
    test('a wakeup signal drains and spawns a chat run', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry());
        await dispatcher.open();

        await bus.enqueueWakeup('user', 'session', 'agent');

        await waitFor(() => chat.calls.length === 1);
        expect(chat.calls[0]).toMatchObject({
            userId: 'user',
            sessionId: 'session',
            agentId: 'agent',
            input: null,
        });
        await dispatcher.close();
    });

    test('the initial drain picks up triggers queued before startup', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        await bus.enqueueWakeup('user', 'pending', 'agent');
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry());

        await dispatcher.open();

        await waitFor(() => chat.calls.length === 1);
        expect(chat.calls[0].sessionId).toBe('pending');
        await dispatcher.close();
    });

    test('a busy session is requeued until its distributed lock is free', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry(), {
            retryBackoffMs: 2,
        });
        const lock = await bus.acquireLock('agentscope:session:lock:busy');
        await dispatcher.open();
        await bus.enqueueWakeup('user', 'busy', 'agent');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(chat.calls).toHaveLength(0);

        await lock.release();

        await waitFor(() => chat.calls.length === 1);
        await dispatcher.close();
    });

    test('malformed entries and missing carried input are dropped', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        await bus.queuePush('agentscope:wakeups', { session_id: 'missing-owner' });
        await bus.enqueueInput('user', 'session', 'agent', { kind: 'resume' });
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry());

        await dispatcher.open();

        expect(chat.calls).toHaveLength(0);
        await dispatcher.close();
    });

    test('a deleted session emits an error end event instead of spawning', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        await bus.enqueueWakeup('user', 'deleted', 'agent');
        const dispatcher = new WakeupDispatcher(
            bus,
            fakeStorage(false),
            chat,
            new ChatRunRegistry()
        );

        await dispatcher.open();

        expect(chat.calls).toHaveLength(0);
        const events = await bus.sessionReadEvents('deleted');
        expect(events.map(([, event]) => event)).toEqual([
            expect.objectContaining({
                type: EventType.REPLY_END,
                session_id: 'deleted',
                finished_reason: ReplyFinishedReason.ERROR,
                error: { type: 'internal', message: 'Session no longer exists.' },
            }),
        ]);
        await dispatcher.close();
    });

    test('resume and message triggers are parsed into concrete input objects', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry());
        await bus.enqueueInput('user', 'resume', 'agent', {
            kind: 'resume',
            input: createEvent({
                type: EventType.USER_INTERRUPT,
                reply_id: 'reply',
            }) as never,
        });
        await bus.enqueueInput('user', 'message', 'agent', {
            kind: 'message',
            input: UserMsg({ name: 'user', content: 'hello' }) as never,
        });

        await dispatcher.open();

        await waitFor(() => chat.calls.length === 2);
        expect(chat.calls[0].input).toMatchObject({
            type: EventType.USER_INTERRUPT,
            reply_id: 'reply',
        });
        expect(chat.calls[1].input).toMatchObject({ role: 'user', name: 'user' });
        await dispatcher.close();
    });

    test('a local spawn race requeues rather than dropping the trigger', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        const registry = new ChatRunRegistry();
        let release = (): void => {};
        registry.spawn(
            () =>
                new Promise<void>(resolve => {
                    release = resolve;
                }),
            { sessionId: 'racing' }
        );
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, registry, {
            retryBackoffMs: 2,
        });
        await dispatcher.open();
        await bus.enqueueWakeup('user', 'racing', 'agent');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(chat.calls).toHaveLength(0);
        await Promise.resolve();
        release();

        await waitFor(() => chat.calls.length === 1);
        await dispatcher.close();
    });

    test('shutdown cancels pending retry timers', async () => {
        const bus = new InMemoryMessageBus();
        const chat = new FakeChatService();
        const lock = await bus.acquireLock('agentscope:session:lock:busy');
        const dispatcher = new WakeupDispatcher(bus, fakeStorage(), chat, new ChatRunRegistry(), {
            retryBackoffMs: 10_000,
        });
        await dispatcher.open();
        await bus.enqueueWakeup('user', 'busy', 'agent');
        await new Promise(resolve => setTimeout(resolve, 2));

        await expect(dispatcher.close()).resolves.toBeUndefined();

        await lock.release();
        expect(chat.calls).toHaveLength(0);
    });
});
