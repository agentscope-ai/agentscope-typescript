/* eslint-disable jsdoc/require-jsdoc */

import {
    createMsg,
    DataBlock,
    TextBlock,
    ToolCallBlock,
    URLSource,
} from '@agentscope-ai/agentscope/message';
import { AgentState, parseAgentState } from '@agentscope-ai/agentscope/state';

import {
    ChannelConfirmationResultEvent,
    ChannelEvent,
    ChannelGateway,
    resolveChannelRoute,
    type ChannelContentBlock,
} from '../src/channel';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import {
    AgentRecordSchema,
    ChannelRecordSchema,
    InMemoryStorage,
    SessionConfigSchema,
    type ChannelRecord,
} from '../src/storage';
import type { WorkspaceManagerBase } from '../src/workspace-manager';

const model = {
    type: 'openai_chat',
    credential_id: 'cred-1',
    model: 'gpt-4',
    parameters: {},
};

function record(options: { userId?: string; agentId?: string; enabled?: boolean } = {}) {
    return ChannelRecordSchema.parse({
        id: 'chan-1',
        channel_type: 'feishu',
        user_id: options.userId ?? 'user-1',
        enabled: options.enabled ?? true,
        credentials: {},
        routing: { bindings: [{ match_value: '*', agent_id: options.agentId ?? 'agent-x' }] },
        session: {
            chat_model_config: model,
            permission_mode: 'accept_edits',
        },
    });
}

function workspaceManager() {
    return {
        assignWorkspaceId: async (options: { userId: string; sessionId: string }) =>
            `workspace:${options.userId}:${options.sessionId}`,
    } as unknown as WorkspaceManagerBase;
}

async function fixture(channel = record()) {
    const storage = new InMemoryStorage();
    await storage.upsertChannel(channel, `bot:${channel.id}`);
    const bus = new InMemoryMessageBus();
    return {
        storage,
        bus,
        gateway: new ChannelGateway(storage, bus, workspaceManager()),
    };
}

function messageEvent(content: ChannelContentBlock[] = [TextBlock({ text: 'hello' })]) {
    return new ChannelEvent({
        channelId: 'chan-1',
        channelUserId: 'ou-alice',
        channelUserName: 'Alice',
        chatId: 'oc-group',
        chatName: 'Product',
        content,
    });
}

describe('Python channel gateway message parity', () => {
    test('buffers media-only events and drains them into the next text message', async () => {
        const { gateway } = await fixture();
        const image = (name: string) =>
            DataBlock({
                source: URLSource({
                    url: `https://example.com/${name}`,
                    media_type: 'image/png',
                }),
            });
        await expect(gateway.aggregateMedia(messageEvent([image('a.png')]))).resolves.toBeNull();
        await gateway.aggregateMedia(messageEvent([image('b.png')]));
        const content = await gateway.aggregateMedia(messageEvent());
        expect(content?.map(block => block.type)).toEqual(['data', 'data', 'text']);
    });

    test('creates a deterministic channel session and enqueues a genuine user turn', async () => {
        const channel = record();
        const { storage, bus, gateway } = await fixture(channel);
        const inbound = messageEvent();
        const [, sessionId] = resolveChannelRoute(inbound, channel);

        await gateway.process(inbound);

        const wakeups = await bus.queueDrain(MessageBusKeys.wakeupQueue());
        expect(wakeups).toHaveLength(1);
        expect(wakeups[0][1]).toMatchObject({
            user_id: 'user-1',
            session_id: sessionId,
            agent_id: 'agent-x',
            kind: MessageBusKeys.WAKEUP_KIND_MESSAGE,
            input: {
                role: 'user',
                name: 'ou-alice',
                content: [expect.objectContaining({ type: 'text', text: 'hello' })],
            },
        });
        const session = await storage.getSession('user-1', 'agent-x', sessionId);
        expect(session).toMatchObject({
            source: 'channel',
            source_chat_id: 'oc-group',
            source_chat_name: 'Product',
            source_channel_id: 'chan-1',
            config: {
                workspace_id: `workspace:user-1:${sessionId}`,
                name: 'Feishu/Product',
            },
        });
        expect(parseAgentState(session!.state).permissionContext.mode).toBe('accept_edits');
        expect(await bus.registryGetAll(MessageBusKeys.channelSeenChats('chan-1'))).toEqual({
            'oc-group': '1',
        });
    });

    test('injects a hint instead of starting another run when the session is locked', async () => {
        const channel = record();
        const { bus, gateway } = await fixture(channel);
        const inbound = messageEvent();
        const [, sessionId] = resolveChannelRoute(inbound, channel);
        const lock = await bus.acquireLock(MessageBusKeys.sessionLock(sessionId));
        try {
            await gateway.process(inbound);
        } finally {
            await lock.release();
        }
        expect(await bus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);
        const inbox = await bus.queueDrain(MessageBusKeys.inbox(sessionId));
        expect(inbox[0][1]).toMatchObject({
            type: 'hint',
            hint: [expect.objectContaining({ text: 'hello' })],
            source: '{"label":"channel","sublabel":"Alice"}',
        });
    });

    test('ignores missing, disabled, and media-only channel events', async () => {
        const missingStorage = new InMemoryStorage();
        const missingBus = new InMemoryMessageBus();
        const missing = new ChannelGateway(missingStorage, missingBus, workspaceManager());
        await expect(missing.process(messageEvent())).resolves.toBeUndefined();
        expect(await missingBus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);

        const disabled = await fixture(record({ enabled: false }));
        await disabled.gateway.process(messageEvent());
        expect(await disabled.bus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);

        const media = await fixture();
        await media.gateway.process(
            messageEvent([
                DataBlock({
                    source: URLSource({
                        url: 'https://example.com/a.png',
                        media_type: 'image/png',
                    }),
                }),
            ])
        );
        expect(await media.bus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);
    });

    test('session naming includes the user only for per-chat-user scope', () => {
        const channel = record();
        expect(ChannelGateway.sessionName(channel, messageEvent(), 'per_chat')).toBe(
            'Feishu/Product'
        );
        expect(ChannelGateway.sessionName(channel, messageEvent(), 'per_chat_user')).toBe(
            'Feishu/Product/Alice'
        );
        expect(
            ChannelGateway.sessionName(
                channel,
                new ChannelEvent({
                    channelId: 'c',
                    channelUserId: 'u',
                    chatId: 'private-chat',
                }),
                'per_chat'
            )
        ).toBe('Feishu/private-chat');
    });
});

async function addParkedSession(
    storage: InMemoryStorage,
    channel: ChannelRecord,
    sessionId: string,
    agentId = 'agent-x'
) {
    const agent = AgentRecordSchema.parse({
        id: agentId,
        user_id: channel.user_id,
        data: { name: 'Friday', context_config: {}, react_config: {} },
    });
    await storage.upsertAgent(channel.user_id, agent);
    const state = new AgentState({
        context: [
            createMsg({
                name: 'Friday',
                role: 'assistant',
                content: [
                    ToolCallBlock({
                        id: 'call-abc',
                        name: 'Bash',
                        input: '{}',
                        state: 'asking',
                    }),
                ],
            }),
        ],
    });
    state.replyId = 'reply-1';
    await storage.upsertSession({
        userId: channel.user_id,
        agentId,
        sessionId,
        source: 'channel',
        sourceChannelId: channel.id,
        sourceChatId: 'group:cid-1',
        config: SessionConfigSchema.parse({ workspace_id: 'ws-1' }),
        state: state.toJSON(),
    });
}

describe('Python channel decision routing parity', () => {
    test('uses a card-pinned target and enqueues the authoritative tool call', async () => {
        const channel = record();
        const { storage, bus, gateway } = await fixture(channel);
        await addParkedSession(storage, channel, 'parked');

        await gateway.process(
            new ChannelConfirmationResultEvent({
                channelId: channel.id,
                chatId: 'group:cid-1',
                channelUserId: 'clicker',
                agentId: 'agent-x',
                sessionId: 'parked',
                toolCallId: 'call-abc',
                approved: true,
            })
        );

        const wakeups = await bus.queueDrain(MessageBusKeys.wakeupQueue());
        expect(wakeups[0][1]).toMatchObject({
            user_id: 'user-1',
            session_id: 'parked',
            agent_id: 'agent-x',
            kind: MessageBusKeys.WAKEUP_KIND_RESUME,
            input: {
                type: 'USER_CONFIRM_RESULT',
                reply_id: 'reply-1',
                confirm_results: [
                    {
                        confirmed: true,
                        rules: null,
                        tool_call: { id: 'call-abc', name: 'Bash', state: 'asking' },
                    },
                ],
            },
        });
    });

    test('falls back from a bad routing guess to the waiting session in that chat', async () => {
        const channel = record({ agentId: 'routing-guess' });
        const { storage, bus, gateway } = await fixture(channel);
        await addParkedSession(storage, channel, 'the-parked-session', 'agent-x');

        await gateway.process(
            new ChannelConfirmationResultEvent({
                channelId: channel.id,
                chatId: 'group:cid-1',
                channelUserId: '300905',
                toolCallId: 'call-abc',
                approved: false,
                actor: '300905',
            })
        );

        expect((await bus.queueDrain(MessageBusKeys.wakeupQueue()))[0][1]).toMatchObject({
            session_id: 'the-parked-session',
            agent_id: 'agent-x',
            input: { confirm_results: [{ confirmed: false }] },
        });
    });

    test('stale and disabled decisions are idempotent no-ops', async () => {
        const disabled = await fixture(record({ enabled: false }));
        await disabled.gateway.process(
            new ChannelConfirmationResultEvent({
                channelId: 'chan-1',
                chatId: 'chat',
                channelUserId: 'u',
                toolCallId: 'missing',
                approved: true,
            })
        );
        expect(await disabled.bus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);

        const active = await fixture();
        await active.gateway.process(
            new ChannelConfirmationResultEvent({
                channelId: 'chan-1',
                chatId: 'chat',
                channelUserId: 'u',
                toolCallId: 'missing',
                approved: true,
            })
        );
        expect(await active.bus.queueDrain(MessageBusKeys.wakeupQueue())).toEqual([]);
    });
});
