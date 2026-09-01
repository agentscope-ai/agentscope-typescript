/* eslint-disable jsdoc/require-jsdoc */

import { EventType } from '@agentscope-ai/agentscope/event';

import { publishSessionEvent } from '../src/bus-ops';
import { openReplyStream } from '../src/channel';
import { InMemoryMessageBus, type BusEntry } from '../src/message-bus';

const start = { type: EventType.REPLY_START };
const end = { type: EventType.REPLY_END };

async function drain(bus: InMemoryMessageBus, sessionId = 's-1'): Promise<string[]> {
    const stream = await openReplyStream(bus, sessionId);
    const types: string[] = [];
    for await (const event of stream) types.push(String(event.type ?? ''));
    return types;
}

class SeamBus extends InMemoryMessageBus {
    private seamPublished = false;

    override async logRead(key: string, since?: string, maxCount?: number): Promise<BusEntry[]> {
        if (!this.seamPublished) {
            this.seamPublished = true;
            await publishSessionEvent(this, 's-1', start);
        }
        return super.logRead(key, since, maxCount);
    }
}

describe('Python channel reply stream parity', () => {
    test('replays events published before subscribing', async () => {
        const bus = new InMemoryMessageBus();
        await publishSessionEvent(bus, 's-1', start);
        await publishSessionEvent(bus, 's-1', end);
        await expect(drain(bus)).resolves.toEqual([EventType.REPLY_START, EventType.REPLY_END]);
    });

    test('delivers events published while streaming', async () => {
        const bus = new InMemoryMessageBus();
        const result = drain(bus);
        await new Promise(resolve => setTimeout(resolve, 5));
        await publishSessionEvent(bus, 's-1', start);
        await publishSessionEvent(bus, 's-1', end);
        await expect(result).resolves.toEqual([EventType.REPLY_START, EventType.REPLY_END]);
    });

    test('deduplicates the replay/live seam but preserves distinct entries', async () => {
        const bus = new SeamBus();
        await publishSessionEvent(bus, 's-1', start);
        const result = drain(bus);
        await new Promise(resolve => setTimeout(resolve, 5));
        await publishSessionEvent(bus, 's-1', end);
        await expect(result).resolves.toEqual([
            EventType.REPLY_START,
            EventType.REPLY_START,
            EventType.REPLY_END,
        ]);
    });

    test('stops at reply end and leaves later events for the next reply', async () => {
        const bus = new InMemoryMessageBus();
        await publishSessionEvent(bus, 's-1', start);
        await publishSessionEvent(bus, 's-1', end);
        await publishSessionEvent(bus, 's-1', start);
        await expect(drain(bus)).resolves.toEqual([EventType.REPLY_START, EventType.REPLY_END]);
    });

    test.each([EventType.REQUIRE_USER_CONFIRM, EventType.REQUIRE_EXTERNAL_EXECUTION])(
        'terminates when a run parks on %s',
        async terminal => {
            const bus = new InMemoryMessageBus();
            await publishSessionEvent(bus, 's-1', start);
            await publishSessionEvent(bus, 's-1', { type: terminal });
            await expect(drain(bus)).resolves.toEqual([EventType.REPLY_START, terminal]);
        }
    );

    test('can be cancelled while waiting for live events', async () => {
        const bus = new InMemoryMessageBus();
        const controller = new AbortController();
        const stream = await openReplyStream(bus, 's-1', controller.signal);
        const next = stream.next();
        controller.abort(new Error('stop'));
        await expect(next).rejects.toThrow('stop');
    });
});
