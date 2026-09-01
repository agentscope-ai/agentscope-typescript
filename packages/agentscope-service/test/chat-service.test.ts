/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from '@agentscope-ai/agentscope/agent';
import { EventType } from '@agentscope-ai/agentscope/event';
import { AssistantMsg, TextBlock, ToolCallBlock, UserMsg } from '@agentscope-ai/agentscope/message';
import {
    ChatModelBase,
    ChatResponse,
    type ChatResponseBlock,
} from '@agentscope-ai/agentscope/model';
import { AgentState } from '@agentscope-ai/agentscope/state';
import type { ToolChoice, ToolSchema } from '@agentscope-ai/agentscope/type';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { DenyAllResourceAccessPolicy } from '../src/access';
import { BackgroundTaskManager, SchedulerManager } from '../src/manager';
import type { BusPayload } from '../src/message-bus';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import { ChatService, type ChatServiceOptions, ResourceAccessService } from '../src/service';
import { AgentRecordSchema, InMemoryStorage, TeamRecordSchema } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class RecordingBus extends InMemoryMessageBus {
    readonly events: Array<{ sessionId: string; event: BusPayload }> = [];

    override async sessionPublishEvent(sessionId: string, event: BusPayload): Promise<string> {
        this.events.push({ sessionId, event: structuredClone(event) });
        return super.sessionPublishEvent(sessionId, event);
    }
}

class StaticModel extends ChatModelBase {
    constructor(private readonly response: ChatResponseBlock[] | Error) {
        super({ modelName: 'static', stream: false });
    }

    protected async _callAPI(): Promise<ChatResponse> {
        if (this.response instanceof Error) throw this.response;
        return new ChatResponse({ content: structuredClone(this.response), isLast: true });
    }

    _formatToolChoice(_toolChoice: ToolChoice): unknown {
        return undefined;
    }

    _formatToolSchemas(_tools: ToolSchema[]): unknown[] {
        return [];
    }
}

class StubWorkspaceManager extends WorkspaceManagerBase {
    readonly workspace = {
        workdir: '/workspace',
        listTools: async () => [],
        listSkills: async () => [],
        listMcps: async () => [],
        purgeSession: async () => undefined,
        purgeAgent: async () => undefined,
    } as unknown as WorkspaceBase;

    async getWorkspace(): Promise<WorkspaceBase> {
        return this.workspace;
    }
    async close(): Promise<void> {}
    async closeAll(): Promise<void> {}
}

async function fixture(
    model: StaticModel | null = new StaticModel([TextBlock({ text: 'Hello' })]),
    options: {
        source?: 'user' | 'schedule' | 'channel';
        sourceChannelId?: string;
        sourceChatId?: string;
        sourceChatName?: string;
        chat?: ChatServiceOptions;
    } = {}
) {
    const storage = new InMemoryStorage();
    const bus = new RecordingBus();
    const workspaceManager = new StubWorkspaceManager();
    const agent = AgentRecordSchema.parse({
        id: 'agent',
        user_id: 'u',
        data: {
            name: 'Assistant',
            system_prompt: 'Be helpful.',
            context_config: {},
            react_config: {},
        },
    });
    await storage.upsertAgent('u', agent);
    const session = await storage.upsertSession({
        userId: 'u',
        agentId: agent.id,
        sessionId: 'session',
        source: options.source,
        sourceChannelId: options.sourceChannelId,
        sourceChatId: options.sourceChatId,
        sourceChatName: options.sourceChatName,
        config: {
            workspace_id: 'workspace',
            name: 'session',
            cwd: null,
            chat_model_config: model
                ? {
                      type: 'test',
                      credential_id: 'credential',
                      model: 'static',
                      parameters: {},
                  }
                : null,
            fallback_chat_model_config: null,
            tts_model_config: null,
            knowledge_config: null,
        },
        state: new AgentState().toJSON(),
    });
    const access = new ResourceAccessService(storage, new DenyAllResourceAccessPolicy());
    const service = new ChatService(
        storage,
        workspaceManager,
        new SchedulerManager(storage, bus, workspaceManager),
        new BackgroundTaskManager(bus),
        bus,
        access,
        {
            ...options.chat,
            modelResolver: options.chat?.modelResolver ?? (async () => model!),
        }
    );
    return { storage, bus, agent, session, service };
}

describe('ChatService', () => {
    test('runs one locked turn, persists both messages and publishes the reply lifecycle', async () => {
        const { storage, bus, service } = await fixture();
        const input = UserMsg({ name: 'user', content: 'Hi' });
        await service.run({ userId: 'u', sessionId: 'session', agentId: 'agent', input });
        const page = await storage.listMessages('u', 'session', { limit: 10 });
        expect(page.messages).toHaveLength(2);
        expect(page.messages[0]).toEqual(input);
        expect(page.messages[1]).toMatchObject({
            role: 'assistant',
            name: 'Assistant',
            finished_reason: 'completed',
            content: [
                expect.objectContaining({ type: 'hint' }),
                expect.objectContaining({ type: 'text', text: 'Hello' }),
            ],
        });
        expect(bus.events.map(item => item.event.type)).toEqual(
            expect.arrayContaining([EventType.REPLY_START, EventType.REPLY_END])
        );
        expect(await bus.sessionIsRunning('session')).toBe(false);
        expect(
            await bus.registryExists(
                MessageBusKeys.inboxConsumer('session'),
                MessageBusKeys.INBOX_CONSUMER_FIELD
            )
        ).toBe(false);
        const persisted = await storage.getSession('u', 'agent', 'session');
        expect(persisted?.state.permission_context.working_directories).toEqual({
            '/workspace': { path: '/workspace', source: 'session' },
        });
    });

    test('synthesizes and persists a setup-error reply when no model is configured', async () => {
        const { storage, bus, service } = await fixture(null);
        await service.run({ userId: 'u', sessionId: 'session', agentId: 'agent' });
        const page = await storage.listMessages('u', 'session', { limit: 10 });
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toMatchObject({
            role: 'assistant',
            finished_reason: 'error',
            error: { type: 'invalid_request' },
        });
        expect(bus.events.map(item => item.event.type)).toEqual([
            EventType.REPLY_START,
            EventType.REPLY_END,
        ]);
    });

    test('closes and persists a reply when the model fails after REPLY_START', async () => {
        const { storage, service } = await fixture(new StaticModel(new Error('provider failed')));
        await service.run({
            userId: 'u',
            sessionId: 'session',
            agentId: 'agent',
            input: UserMsg({ name: 'user', content: 'Hi' }),
        });
        const page = await storage.listMessages('u', 'session', { limit: 10 });
        expect(page.messages.at(-1)).toMatchObject({
            role: 'assistant',
            finished_reason: 'error',
            error: { type: 'unknown' },
        });
    });

    test('queues an idle interrupt as a durable resume event', async () => {
        const { bus, service, session } = await fixture();
        await service.interrupt('u', 'session', 'agent');
        expect(await bus.dequeueWakeups()).toEqual([
            expect.objectContaining({
                user_id: 'u',
                session_id: 'session',
                agent_id: 'agent',
                kind: 'resume',
                input: expect.objectContaining({
                    type: EventType.USER_INTERRUPT,
                    reply_id: session.state.reply_context.reply_id,
                }),
            }),
        ]);
    });

    test('detects parked wakeups without consuming their queued inbox', async () => {
        const model = new StaticModel([TextBlock({ text: 'unused' })]);
        const state = new AgentState();
        state.context.push(
            AssistantMsg({
                id: state.replyId,
                name: 'Assistant',
                content: [
                    ToolCallBlock({
                        id: 'call',
                        name: 'External',
                        input: '{}',
                        state: 'submitted',
                    }),
                ],
            })
        );
        const agent = new Agent({
            name: 'Assistant',
            systemPrompt: 'Test.',
            model,
            state,
        });
        expect(ChatService.skipParkedWakeup(agent, null)).toBe(true);
    });

    test('loads persisted state only after each waiter acquires the session lock', async () => {
        const observedContextLengths: number[] = [];
        const initial = new StaticModel([TextBlock({ text: 'Done.' })]);
        const { storage, service } = await fixture(initial, {
            chat: {
                modelResolver: async () => {
                    observedContextLengths.push(
                        (await storage.getSession('u', 'agent', 'session'))?.state.context.length ??
                            -1
                    );
                    return new StaticModel([TextBlock({ text: 'Done.' })]);
                },
            },
        });
        await Promise.all([
            service.run({
                userId: 'u',
                sessionId: 'session',
                agentId: 'agent',
                input: UserMsg({ name: 'user', content: 'First' }),
            }),
            service.run({
                userId: 'u',
                sessionId: 'session',
                agentId: 'agent',
                input: UserMsg({ name: 'user', content: 'Second' }),
            }),
        ]);
        expect(observedContextLengths).toEqual([0, 2]);
        expect((await storage.listMessages('u', 'session', { limit: 10 })).messages).toHaveLength(
            4
        );
    });

    test('passes workspace only to modern middleware factories', async () => {
        const modernCalls: unknown[][] = [];
        const modern = async (...args: unknown[]) => {
            modernCalls.push(args);
            return [];
        };
        const modernFixture = await fixture(undefined, {
            chat: { extraAgentMiddlewares: modern },
        });
        await modernFixture.service.run({
            userId: 'u',
            sessionId: 'session',
            agentId: 'agent',
        });
        expect(modernCalls[0]).toHaveLength(4);

        const legacyCalls: unknown[][] = [];
        const legacy = async (_userId: string, _agentId: string, _sessionId: string) => {
            legacyCalls.push([_userId, _agentId, _sessionId]);
            return [];
        };
        const legacyFixture = await fixture(undefined, {
            chat: { extraAgentMiddlewares: legacy },
        });
        await legacyFixture.service.run({
            userId: 'u',
            sessionId: 'session',
            agentId: 'agent',
        });
        expect(legacyCalls).toEqual([['u', 'agent', 'session']]);
    });

    test('starts channel delivery only for channel-originated sessions', async () => {
        const deliveries: unknown[] = [];
        const channelClients = {
            get: async () => ({
                displayName: 'TestChat',
                listTools: async () => [],
                chatKind: async () => 'group' as const,
                chatName: async () => 'Room',
            }),
            deliver: async (delivery: unknown) => {
                deliveries.push(delivery);
            },
        };
        const { service } = await fixture(undefined, {
            source: 'channel',
            sourceChannelId: 'channel',
            sourceChatId: 'chat',
            sourceChatName: 'Room',
            chat: { channelClients },
        });
        await service.run({ userId: 'u', sessionId: 'session', agentId: 'agent' });
        expect(deliveries).toEqual([
            { sessionId: 'session', channelId: 'channel', chatId: 'chat', agentId: 'agent' },
        ]);
    });

    test('notifies a worker leader when assembly fails', async () => {
        const { storage, bus, service } = await fixture(null);
        const worker = AgentRecordSchema.parse({
            id: 'worker',
            user_id: 'u',
            source: 'team',
            data: { name: 'worker', context_config: {}, react_config: {} },
        });
        await storage.upsertAgent('u', worker);
        const workerSession = await storage.upsertSession({
            userId: 'u',
            agentId: worker.id,
            sessionId: 'worker-session',
            config: {
                workspace_id: 'workspace',
                name: 'worker',
                cwd: null,
                chat_model_config: null,
                fallback_chat_model_config: null,
                tts_model_config: null,
                knowledge_config: null,
            },
            state: new AgentState().toJSON(),
        });
        const team = TeamRecordSchema.parse({
            id: 'team',
            user_id: 'u',
            session_id: 'session',
            leader_agent_id: 'agent',
            data: {
                name: 'Team',
                members: [
                    {
                        owner_id: 'u',
                        agent_id: worker.id,
                        session_id: workerSession.id,
                        role: 'created',
                    },
                ],
            },
        });
        await storage.upsertTeam('u', team);
        await storage.setSessionTeamId('u', 'session', team.id);
        await storage.setSessionTeamId('u', workerSession.id, team.id);
        await service.run({
            userId: 'u',
            sessionId: workerSession.id,
            agentId: worker.id,
        });
        expect(await bus.queueDrain(MessageBusKeys.inbox('session'))).toEqual([
            [
                expect.any(String),
                expect.objectContaining({
                    type: 'hint',
                    hint: expect.stringContaining("Team member 'worker' hit an error"),
                }),
            ],
        ]);
    });
});
