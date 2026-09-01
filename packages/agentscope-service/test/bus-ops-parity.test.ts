import { createEvent, EventType } from '@agentscope-ai/agentscope/event';

import { enqueueRunTrigger, publishSessionEvent } from '../src/bus-ops';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';

describe('business-level message bus operations', () => {
    test('publishes replay entries and emits typed run triggers', async () => {
        const bus = new InMemoryMessageBus();
        const entryId = await publishSessionEvent(bus, 'session', { type: 'event', value: 1 });
        expect(await bus.sessionReadEvents('session')).toEqual([
            [entryId, { type: 'event', value: 1 }],
        ]);

        const input = createEvent({ type: EventType.USER_INTERRUPT, reply_id: 'reply' });
        await enqueueRunTrigger(bus, {
            userId: 'user',
            sessionId: 'session',
            agentId: 'agent',
            kind: MessageBusKeys.WAKEUP_KIND_RESUME,
            input,
        });
        expect(await bus.dequeueWakeups()).toEqual([
            {
                user_id: 'user',
                session_id: 'session',
                agent_id: 'agent',
                kind: 'resume',
                input,
            },
        ]);
    });
});
