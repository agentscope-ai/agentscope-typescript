/* eslint-disable jsdoc/require-jsdoc */

import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import { z } from 'zod';

import {
    ChannelBase,
    ChannelEvent,
    ChannelGateway,
    ChannelHeartbeat,
    ChannelLifecycleDispatcher,
    ChannelStatus,
    ChannelTypeRegistry,
    runChannelWorker,
    type ChannelEmitter,
} from '../src/channel';
import { InMemoryMessageBus, MessageBusKeys, type BusPayload } from '../src/message-bus';
import { ChannelRecordSchema, InMemoryStorage } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class ListeningChannel extends ChannelBase {
    static readonly channelType = 'fake';
    static readonly displayName = 'Fake';
    static readonly platformBotIdField = 'bot_id';
    static readonly credentialsSchema = z.object({ bot_id: z.string() });
    static readonly configSchema = z.object({});
    static instances: ListeningChannel[] = [];

    readonly channelId: string;
    readonly botId: string;
    override readonly status = new ChannelStatus();
    stopped = false;

    constructor(
        channelId: string,
        credentials: Record<string, unknown>,
        _config: Record<string, unknown>
    ) {
        super();
        this.channelId = channelId;
        this.botId = String(credentials.bot_id);
        ListeningChannel.instances.push(this);
    }

    async startListening(_emit: ChannelEmitter, signal?: AbortSignal): Promise<void> {
        this.status.state = 'connected';
        try {
            if (!signal?.aborted) {
                await new Promise<void>(resolve =>
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                );
            }
        } finally {
            this.stopped = true;
            this.status.state = 'stopped';
        }
    }

    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}
}

function channelRecord(botId = 'bot-1', enabled = true) {
    return ChannelRecordSchema.parse({
        id: 'chan-1',
        channel_type: 'fake',
        user_id: 'owner-1',
        enabled,
        credentials: { bot_id: botId },
        routing: { bindings: [{ match_value: '*', agent_id: 'agent-x' }] },
        session: { chat_model_config: { type: 'x' } },
    });
}

function inertWorkspaceManager() {
    return {
        assignWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceManagerBase;
}

async function dispatcherFixture() {
    ListeningChannel.instances = [];
    const storage = new InMemoryStorage();
    await storage.upsertChannel(channelRecord(), 'bot-1');
    const bus = new InMemoryMessageBus();
    const gateway = new ChannelGateway(storage, bus, inertWorkspaceManager());
    const dispatcher = new ChannelLifecycleDispatcher(
        storage,
        bus,
        new ChannelTypeRegistry([ListeningChannel]),
        gateway,
        { nodeId: 'worker-a', refreshMilliseconds: 10_000 }
    );
    return { storage, bus, gateway, dispatcher };
}

describe('channel lifecycle dispatcher', () => {
    test('starts enabled channels, publishes heartbeat, and withdraws on close', async () => {
        const { bus, dispatcher } = await dispatcherFixture();
        await dispatcher.open();
        expect(dispatcher.instanceCount).toBe(1);
        expect(ListeningChannel.instances[0].status.state).toBe('connected');

        await dispatcher.publishStatus(100);
        const raw = await bus.registryGet(MessageBusKeys.channelLiveness('chan-1'), 'worker-a');
        expect(ChannelHeartbeat.parse(raw!)).toMatchObject({
            status: { state: 'connected' },
            reportedAt: 100,
        });

        await dispatcher.close();
        expect(ListeningChannel.instances[0].stopped).toBe(true);
        expect(dispatcher.instanceCount).toBe(0);
        expect(
            await bus.registryGet(MessageBusKeys.channelLiveness('chan-1'), 'worker-a')
        ).toBeNull();
    });

    test('restarts changed records and stops disabled records', async () => {
        const { storage, dispatcher } = await dispatcherFixture();
        await dispatcher.open();
        const first = ListeningChannel.instances[0];
        await new Promise(resolve => setTimeout(resolve, 2));
        await storage.upsertChannel(channelRecord('bot-2'), 'bot-2');
        await dispatcher.reconcile();
        expect(first.stopped).toBe(true);
        expect(ListeningChannel.instances.at(-1)).toMatchObject({ botId: 'bot-2' });

        await new Promise(resolve => setTimeout(resolve, 2));
        await storage.upsertChannel(channelRecord('bot-2', false), 'bot-2');
        await dispatcher.reconcile();
        expect(dispatcher.instanceCount).toBe(0);
        await dispatcher.close();
    });

    test('lifecycle notifications trigger reconciliation', async () => {
        const { storage, bus, dispatcher } = await dispatcherFixture();
        await dispatcher.open();
        await new Promise(resolve => setTimeout(resolve, 2));
        await storage.upsertChannel(channelRecord('bot-2'), 'bot-2');
        await bus.publish(MessageBusKeys.channelLifecycle(), {});
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(ListeningChannel.instances.at(-1)).toMatchObject({ botId: 'bot-2' });
        await dispatcher.close();
    });

    test('dispatch only forwards events for a locally running channel', async () => {
        const { storage, bus } = await dispatcherFixture();
        const process = jest.fn(async () => {});
        const gateway = { process } as unknown as ChannelGateway;
        const dispatcher = new ChannelLifecycleDispatcher(
            storage,
            bus,
            new ChannelTypeRegistry([ListeningChannel]),
            gateway,
            { nodeId: 'worker-a' }
        );
        const event = new ChannelEvent({ channelId: 'chan-1', channelUserId: 'u', chatId: 'c' });
        await dispatcher.dispatch(event, 'chan-1');
        expect(process).not.toHaveBeenCalled();
        await dispatcher.open();
        await dispatcher.dispatch(event, 'chan-1');
        expect(process).toHaveBeenCalledWith(event);
        await dispatcher.close();
    });
});

class TrackedStorage extends InMemoryStorage {
    opened = false;
    closed = false;
    override async open(): Promise<this> {
        this.opened = true;
        return this;
    }
    override async close(): Promise<void> {
        this.closed = true;
    }
}

class TrackedBus extends InMemoryMessageBus {
    opened = false;
    closed = false;
    override async open(): Promise<this> {
        this.opened = true;
        return this;
    }
    override async close(): Promise<void> {
        this.closed = true;
        await super.close();
    }
}

class TrackedWorkspaceManager extends WorkspaceManagerBase {
    opened = false;
    closed = false;
    bound = false;
    override bindStorage(storage: InMemoryStorage): void {
        this.bound = true;
        super.bindStorage(storage);
    }
    override async open(): Promise<this> {
        this.opened = true;
        return this;
    }
    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('unused');
    }
    async close(): Promise<void> {}
    async closeAll(): Promise<void> {
        this.closed = true;
    }
}

describe('standalone channel worker lifecycle', () => {
    test('opens, binds, stays up, and releases every backend on abort', async () => {
        const storage = new TrackedStorage();
        const bus = new TrackedBus();
        const workspaces = new TrackedWorkspaceManager();
        const controller = new AbortController();
        const worker = runChannelWorker({
            storage,
            messageBus: bus,
            workspaceManager: workspaces,
            channels: [],
            signal: controller.signal,
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect({
            storage: storage.opened,
            bus: bus.opened,
            workspaces: workspaces.opened,
            bound: workspaces.bound,
        }).toEqual({ storage: true, bus: true, workspaces: true, bound: true });

        controller.abort();
        await worker;
        expect({ storage: storage.closed, bus: bus.closed, workspaces: workspaces.closed }).toEqual(
            {
                storage: true,
                bus: true,
                workspaces: true,
            }
        );
    });
});
