/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import {
    ChannelBase,
    ChannelHeartbeat,
    ChannelStatus,
    ChannelTypeRegistry,
    LIVENESS_TTL_SECONDS,
    type ChannelEmitter,
    type ChannelEvent,
} from '../src/channel';
import { InMemoryMessageBus, MessageBusKeys, type BusPayload } from '../src/message-bus';
import { ChannelService } from '../src/service';
import { InMemoryStorage, RoutingConfigSchema, SessionSettingsSchema } from '../src/storage';

class ServiceChannel extends ChannelBase {
    static readonly channelType = 'fake';
    static readonly displayName = 'Fake';
    static readonly platformBotIdField = 'bot_id';
    static readonly credentialsSchema = z.object({ bot_id: z.string() });
    static readonly configSchema = z.object({});
    readonly channelId: string;
    constructor(channelId: string) {
        super();
        this.channelId = channelId;
    }
    async startListening(_emit: ChannelEmitter): Promise<void> {}
    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}
}

function createInput(botId = 'bot-1') {
    return {
        userId: 'user-1',
        channelType: 'fake',
        credentials: { bot_id: botId },
        platformConfig: {},
        routing: RoutingConfigSchema.parse({
            bindings: [{ match_value: '*', agent_id: 'agent-x' }],
        }),
        session: SessionSettingsSchema.parse({
            chat_model_config: { type: 'x' },
        }),
    };
}

function serviceFixture() {
    const storage = new InMemoryStorage();
    const bus = new InMemoryMessageBus();
    const service = new ChannelService(storage, bus, new ChannelTypeRegistry([ServiceChannel]));
    return { storage, bus, service };
}

describe('channel service CRUD', () => {
    test('creates and notifies, rejecting a duplicate platform bot', async () => {
        const { bus, service } = serviceFixture();
        const publish = jest.spyOn(bus, 'publish');
        const record = await service.create({ ...createInput(), name: 'Primary' });
        expect(record).toMatchObject({
            channel_type: 'fake',
            user_id: 'user-1',
            name: 'Primary',
            enabled: true,
        });
        expect(publish).toHaveBeenCalledWith(MessageBusKeys.channelLifecycle(), {
            channel_id: record.id,
        });
        await expect(service.create(createInput())).rejects.toMatchObject({ statusCode: 409 });
    });

    test('updates allowed fields while credentials and type remain immutable', async () => {
        const { service } = serviceFixture();
        const record = await service.create(createInput());
        const updated = await service.update(record.id, {
            name: 'Renamed',
            enabled: false,
            credentials: { bot_id: 'hijack' },
            channel_type: 'other',
        });
        expect(updated).toMatchObject({
            name: 'Renamed',
            enabled: false,
            credentials: { bot_id: 'bot-1' },
            channel_type: 'fake',
        });
        expect(await service.setEnabled(record.id, true)).toMatchObject({ enabled: true });
    });

    test('deletes and reports missing records with 404', async () => {
        const { storage, service } = serviceFixture();
        const record = await service.create(createInput());
        await service.delete(record.id);
        await expect(storage.getChannel(record.id)).resolves.toBeNull();
        await expect(service.delete(record.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('lists passively observed chat ids in sorted order', async () => {
        const { bus, service } = serviceFixture();
        await bus.registrySet(MessageBusKeys.channelSeenChats('c'), 'z', '1');
        await bus.registrySet(MessageBusKeys.channelSeenChats('c'), 'a', '1');
        await expect(service.listSeenChatIds('c')).resolves.toEqual(['a', 'z']);
    });
});

describe('Python channel cluster status parity', () => {
    async function beat(
        bus: InMemoryMessageBus,
        nodeId: string,
        state: string,
        reportedAt: number,
        channelId = 'chan-1'
    ) {
        await bus.registrySet(
            MessageBusKeys.channelLiveness(channelId),
            nodeId,
            JSON.stringify(new ChannelHeartbeat(new ChannelStatus(state), reportedAt)),
            { ttlSeconds: LIVENESS_TTL_SECONDS }
        );
    }

    test('enabled channels without a heartbeat are connecting', async () => {
        const { service } = serviceFixture();
        const record = await service.create(createInput());
        await expect(service.getStatus(record.id, 100)).resolves.toMatchObject({
            state: 'connecting',
        });
        await service.setEnabled(record.id, false);
        await expect(service.getStatus(record.id, 100)).resolves.toMatchObject({
            state: 'stopped',
        });
    });

    test('reports a fresh holder from another node', async () => {
        const { bus, service } = serviceFixture();
        await beat(bus, 'worker-a', 'connected', 100);
        await expect(service.getStatus('chan-1', 101)).resolves.toMatchObject({
            state: 'connected',
        });
    });

    test('ignores ghost reports left by restarted nodes', async () => {
        const { bus, service } = serviceFixture();
        await beat(bus, 'worker-old', 'connected', 100 - LIVENESS_TTL_SECONDS - 1);
        await beat(bus, 'worker-new', 'connecting', 100);
        await expect(service.getStatus('chan-1', 100)).resolves.toMatchObject({
            state: 'connecting',
        });
    });

    test('only stale reports fall back to the enabled flag', async () => {
        const { bus, service } = serviceFixture();
        const record = await service.create(createInput());
        await beat(bus, 'worker-old', 'connected', 100 - LIVENESS_TTL_SECONDS - 1, record.id);
        await expect(service.getStatus(record.id, 100)).resolves.toMatchObject({
            state: 'connecting',
        });
    });

    test('connected wins over a retrying node', async () => {
        const { bus, service } = serviceFixture();
        await beat(bus, 'worker-a', 'retrying', 100);
        await beat(bus, 'worker-b', 'connected', 100);
        await expect(service.getStatus('chan-1', 100)).resolves.toMatchObject({
            state: 'connected',
        });
    });
});
