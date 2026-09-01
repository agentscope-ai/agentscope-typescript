/* eslint-disable jsdoc/require-jsdoc */

import { EventType } from '@agentscope-ai/agentscope/event';
import { z } from 'zod';

import { publishSessionEvent } from '../src/bus-ops';
import {
    ChannelBase,
    ChannelClients,
    ChannelEvent,
    ChannelTypeRegistry,
    type ChannelEmitter,
} from '../src/channel';
import { InMemoryMessageBus, type BusPayload } from '../src/message-bus';
import { ChannelRecordSchema, type ChannelRecord, type StorageBase } from '../src/storage';

class FakeChannel extends ChannelBase {
    static readonly channelType: string = 'fake';
    static readonly displayName = 'Fake';
    static readonly platformBotIdField = 'bot_id';
    static readonly credentialsSchema = z.object({ bot_id: z.string() });
    static readonly configSchema = z.object({});

    readonly channelId: string;
    readonly botId: string;
    listened = false;
    closed = false;
    sentTo = '';
    returned = false;
    responseStarted!: () => void;
    readonly responseStartedPromise = new Promise<void>(resolve => {
        this.responseStarted = resolve;
    });

    constructor(
        channelId: string,
        credentials: Record<string, unknown>,
        _config: Record<string, unknown>
    ) {
        super();
        this.channelId = channelId;
        this.botId = String(credentials.bot_id);
    }

    async startListening(_emit: ChannelEmitter, signal?: AbortSignal): Promise<void> {
        this.listened = true;
        if (!signal?.aborted) {
            await new Promise<void>(resolve =>
                signal?.addEventListener('abort', () => resolve(), { once: true })
            );
        }
    }

    override async close(): Promise<void> {
        this.closed = true;
    }

    async sendResponse(event: ChannelEvent, events: AsyncIterable<BusPayload>): Promise<void> {
        this.sentTo = event.chatId;
        this.responseStarted();
        for await (const _event of events) {
            // Drain until the reply is terminal or the delivery is cancelled.
        }
        this.returned = true;
    }
}

class MutableChannelStorage {
    constructor(public record: ChannelRecord | null) {}
    async getChannel(_channelId: string): Promise<ChannelRecord | null> {
        return this.record ? structuredClone(this.record) : null;
    }
}

function record(botId = 'bot-1', enabled = true, updatedAt = '2026-01-01T00:00:00Z') {
    return ChannelRecordSchema.parse({
        id: 'chan-1',
        channel_type: 'fake',
        user_id: 'owner-1',
        enabled,
        credentials: { bot_id: botId },
        routing: { bindings: [{ match_value: '*', agent_id: 'agent-x' }] },
        session: { chat_model_config: { type: 'x' } },
        created_at: updatedAt,
        updated_at: updatedAt,
    });
}

function clients(storage: MutableChannelStorage, bus = new InMemoryMessageBus()) {
    return new ChannelClients(
        storage as unknown as StorageBase,
        bus,
        new ChannelTypeRegistry([FakeChannel])
    );
}

describe('Python connection-free channel client parity', () => {
    test('builds and caches without opening the long connection', async () => {
        const manager = clients(new MutableChannelStorage(record()));
        const first = (await manager.get('chan-1')) as FakeChannel;
        const second = await manager.get('chan-1');
        expect(first).toBe(second);
        expect(first).toMatchObject({ botId: 'bot-1', listened: false });
    });

    test('rotates credentials while leaving borrowed instances usable', async () => {
        const storage = new MutableChannelStorage(record());
        const manager = clients(storage);
        const first = (await manager.get('chan-1')) as FakeChannel;
        storage.record = record('bot-2', true, '2099-01-01T00:00:00Z');
        const second = (await manager.get('chan-1')) as FakeChannel;
        expect(second).not.toBe(first);
        expect(second.botId).toBe('bot-2');
        expect(first.closed).toBe(false);

        storage.record = record('bot-2', false, '2099-01-02T00:00:00Z');
        await expect(manager.get('chan-1')).resolves.toBeNull();
        expect(first.closed).toBe(false);
        await manager.close();
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(true);
    });

    test('returns null for missing, disabled, unregistered, or invalid channels', async () => {
        await expect(clients(new MutableChannelStorage(null)).get('chan-1')).resolves.toBeNull();
        await expect(
            clients(new MutableChannelStorage(record('bot', false))).get('chan-1')
        ).resolves.toBeNull();
        const unregistered = new ChannelClients(
            new MutableChannelStorage(record()) as unknown as StorageBase,
            new InMemoryMessageBus(),
            new ChannelTypeRegistry()
        );
        await expect(unregistered.get('chan-1')).resolves.toBeNull();
        const invalid = new MutableChannelStorage(record());
        invalid.record!.credentials = {};
        await expect(clients(invalid).get('chan-1')).resolves.toBeNull();
    });

    test('starts delivery in the background and targets the source chat', async () => {
        const bus = new InMemoryMessageBus();
        const manager = clients(new MutableChannelStorage(record()), bus);
        await manager.deliver({
            sessionId: 's-1',
            channelId: 'chan-1',
            chatId: 'chat-1',
            agentId: 'agent-x',
        });
        const channel = (await manager.get('chan-1')) as FakeChannel;
        await channel.responseStartedPromise;
        expect(channel.sentTo).toBe('chat-1');
        expect(channel.returned).toBe(false);
        expect(manager.deliveryCount).toBe(1);

        await publishSessionEvent(bus, 's-1', { type: EventType.REPLY_END });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(channel.returned).toBe(true);
        expect(manager.deliveryCount).toBe(0);
        await manager.close();
    });

    test('shutdown cancels an in-flight delivery before closing clients', async () => {
        const manager = clients(new MutableChannelStorage(record()));
        await manager.deliver({
            sessionId: 's-1',
            channelId: 'chan-1',
            chatId: 'chat-1',
            agentId: 'agent-x',
        });
        const channel = (await manager.get('chan-1')) as FakeChannel;
        await channel.responseStartedPromise;
        await manager.close();
        expect(manager.deliveryCount).toBe(0);
        expect(channel.returned).toBe(false);
        expect(channel.closed).toBe(true);
    });

    test('a disabled channel starts no delivery', async () => {
        const manager = clients(new MutableChannelStorage(record('bot', false)));
        await manager.deliver({
            sessionId: 's-1',
            channelId: 'chan-1',
            chatId: 'chat-1',
            agentId: 'agent-x',
        });
        expect(manager.deliveryCount).toBe(0);
    });
});

describe('channel type registry', () => {
    test('validates construction, exposes schemas, and extracts bot identity', () => {
        const registry = new ChannelTypeRegistry([FakeChannel]);
        expect(registry.enabled).toBe(true);
        expect(registry.hasType('fake')).toBe(true);
        expect(registry.createChannel('fake', 'c', { bot_id: 'bot' }, {})).toBeInstanceOf(
            FakeChannel
        );
        expect(registry.extractPlatformBotId('fake', { bot_id: 'bot' })).toBe('bot');
        expect(JSON.parse(JSON.stringify(registry.listTypes()[0]))).toMatchObject({
            channel_type: 'fake',
            display_name: 'Fake',
            platform_bot_id_field: 'bot_id',
            credentials_schema: { type: 'object' },
        });
        expect(() => registry.createChannel('fake', 'c', {}, {})).toThrow();
        expect(() => registry.extractPlatformBotId('fake', {})).toThrow();
    });

    test('rejects classes without a channel type', () => {
        class InvalidChannel extends FakeChannel {
            static override readonly channelType = '';
        }
        expect(() => new ChannelTypeRegistry([InvalidChannel])).toThrow(/channelType/);
    });
});
