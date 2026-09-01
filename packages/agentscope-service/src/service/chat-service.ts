/* eslint-disable jsdoc/require-jsdoc */

import { Agent, ModelConfig, type AgentOptions } from '@agentscope-ai/agentscope/agent';
import {
    createEvent,
    EventType,
    ReplyFinishedReason,
    type AgentEvent,
    type ExternalExecutionResultEvent,
    type UserConfirmResultEvent,
    type UserInterruptEvent,
} from '@agentscope-ai/agentscope/event';
import { appendEvent, AssistantMsg, HintBlock, type Msg } from '@agentscope-ai/agentscope/message';
import {
    RAGMiddleware,
    TTSMiddleware,
    type MiddlewareBase,
} from '@agentscope-ai/agentscope/middleware';
import { parseAgentState } from '@agentscope-ai/agentscope/state';
import type { ToolBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import {
    abandonInboxConsumer,
    hasPendingInboxOrRelease,
    registerInboxConsumer,
    deliverToInbox,
} from '../bus-ops';
import type { BackgroundTaskManager, SchedulerManager } from '../manager';
import type { BusPayload, MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import {
    InboxMiddleware,
    StateChangeMiddleware,
    TeamMemberLoopMiddleware,
    ToolOffloadMiddleware,
} from '../middleware';
import type { KnowledgeBaseManagerBase } from '../rag';
import type { AgentRecord, SessionRecord, StorageBase, TeamRecord } from '../storage';
import type { SubAgentTemplate } from '../tool';
import type { WorkspaceManagerBase } from '../workspace-manager';
import { classifyError, classifySetupError } from './errors';
import { getModel, getTTSModel } from './model-service';
import type { ResourceAccessService } from './resource-access-service';
import { SessionProjection, SubagentHitlProjector } from './session-projection';
import { getToolkit, type AgentToolFactory } from './toolkit-service';

export type ChatInput =
    | Msg
    | Msg[]
    | UserConfirmResultEvent
    | ExternalExecutionResultEvent
    | UserInterruptEvent
    | null;

export interface EventProjector {
    maybeProject(
        userId: string,
        session: SessionRecord,
        agent: AgentRecord,
        event: AgentEvent,
        projection: SessionProjection
    ): Promise<void>;
}

export type AgentMiddlewareFactory = (
    userId: string,
    agentId: string,
    sessionId: string,
    workspace?: WorkspaceBase
) => Promise<MiddlewareBase[]>;

export interface ChannelClient {
    readonly displayName: string;
    listTools(workspace: WorkspaceBase): Promise<ToolBase[]>;
    chatKind(chatId: string): Promise<'group' | 'private' | string | null>;
    chatName(chatId: string): Promise<string | null>;
}

export interface ChannelClientsLike {
    get(channelId: string): Promise<ChannelClient | null>;
    deliver(options: {
        sessionId: string;
        channelId: string;
        chatId: string;
        agentId: string;
    }): Promise<void>;
}

export interface ChatServiceOptions {
    knowledgeBaseManager?: KnowledgeBaseManagerBase | null;
    extraAgentMiddlewares?: AgentMiddlewareFactory | null;
    extraAgentTools?: AgentToolFactory | null;
    customSubagentTemplates?: Record<string, SubAgentTemplate> | null;
    agentClass?: new (options: AgentOptions) => Agent;
    extraProjectors?: EventProjector[];
    channelClients?: ChannelClientsLike | null;
    modelResolver?: typeof getModel;
    ttsModelResolver?: typeof getTTSModel;
}

type TeamContext =
    | { role: 'leader' }
    | {
          role: 'worker';
          leaderSessionId: string;
          leaderAgentId: string;
          leaderName: string;
      };

/** The single service path for locked agent execution, fan-out and persistence. */
export class ChatService {
    private readonly projection: SessionProjection;
    private readonly projectors: EventProjector[];
    private readonly options: Required<
        Pick<ChatServiceOptions, 'modelResolver' | 'ttsModelResolver' | 'agentClass'>
    > &
        ChatServiceOptions;

    constructor(
        private readonly storage: StorageBase,
        private readonly workspaceManager: WorkspaceManagerBase,
        private readonly schedulerManager: SchedulerManager,
        private readonly backgroundTaskManager: BackgroundTaskManager,
        private readonly messageBus: MessageBus,
        private readonly access: ResourceAccessService,
        options: ChatServiceOptions = {}
    ) {
        this.options = {
            ...options,
            modelResolver: options.modelResolver ?? getModel,
            ttsModelResolver: options.ttsModelResolver ?? getTTSModel,
            agentClass: options.agentClass ?? Agent,
        };
        this.projection = new SessionProjection(messageBus);
        this.projectors = [new SubagentHitlProjector(storage), ...(options.extraProjectors ?? [])];
    }

    async run(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        input?: ChatInput;
        signal?: AbortSignal;
    }): Promise<void> {
        try {
            await this.runImpl({ ...options, input: options.input ?? null });
        } catch {
            // Matches Python: trigger tasks must survive one failed fire.
        }
    }

    async interrupt(userId: string, sessionId: string, agentId: string): Promise<void> {
        const session = await this.storage.getSession(userId, agentId, sessionId);
        if (!session) throw new Error(`Session '${sessionId}' not found.`);
        if (await this.messageBus.sessionIsRunning(sessionId)) {
            await this.messageBus.sessionPublishInterrupt(sessionId);
            return;
        }
        await this.messageBus.enqueueInput(userId, sessionId, agentId, {
            kind: MessageBusKeys.WAKEUP_KIND_RESUME,
            input: {
                ...createEvent({
                    type: EventType.USER_INTERRUPT,
                    reply_id: session.state.reply_context.reply_id,
                }),
            },
        });
    }

    static skipParkedWakeup(agent: Agent, input: ChatInput): boolean {
        if (input !== null || agent.state.context.length === 0) return false;
        const last = agent.state.context.at(-1)!;
        if (last.role !== 'assistant' || last.name !== agent.name) return false;
        return last.content.some(
            block =>
                block.type === 'tool_call' &&
                (block.state === 'asking' || block.state === 'submitted')
        );
    }

    private async runImpl(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        input: ChatInput;
        signal?: AbortSignal;
    }): Promise<void> {
        await this.messageBus.withLock(
            MessageBusKeys.sessionLock(options.sessionId),
            () => this.runLocked(options),
            { ttlSeconds: MessageBusKeys.SESSION_RUN_TTL_SECS }
        );
    }

    private async runLocked(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        input: ChatInput;
        signal?: AbortSignal;
    }): Promise<void> {
        let teamContext: TeamContext | null = null;
        let workerName = options.agentId;
        let assembled:
            | {
                  agent: Agent;
                  agentRecord: AgentRecord;
                  sessionRecord: SessionRecord;
                  channel: ChannelClient | null;
              }
            | undefined;
        try {
            const agentRecord = await this.access.resolveAgent(options.userId, options.agentId);
            const sessionRecord = await this.storage.getSession(
                options.userId,
                options.agentId,
                options.sessionId
            );
            if (!sessionRecord) {
                throw statusError(
                    404,
                    `Session '${options.sessionId}' not found for agent '${options.agentId}'.`
                );
            }
            workerName = agentRecord.data.name;
            teamContext = await this.resolveTeamContext(options.userId, sessionRecord);
            const workspace = await this.workspaceManager.getWorkspace(
                options.userId,
                options.agentId,
                options.sessionId,
                sessionRecord.config.workspace_id
            );
            const state = parseAgentState(sessionRecord.state);
            state.sessionId = options.sessionId;
            if (
                workspace.workdir &&
                !state.permissionContext.working_directories[workspace.workdir]
            ) {
                state.permissionContext.working_directories[workspace.workdir] = {
                    path: workspace.workdir,
                    source: 'session',
                };
            }
            const channel = await this.resolveChannel(sessionRecord);
            const channelTools = channel ? await channel.listTools(workspace) : [];
            const middlewares = await this.buildMiddlewares(
                options,
                sessionRecord,
                workspace,
                teamContext
            );
            const toolkit = await getToolkit({
                storage: this.storage,
                workspace,
                workspaceManager: this.workspaceManager,
                schedulerManager: this.schedulerManager,
                backgroundTaskManager: this.backgroundTaskManager,
                messageBus: this.messageBus,
                middlewares,
                userId: options.userId,
                agentRecord,
                sessionRecord,
                resourceAccessService: this.access,
                extraFactory: this.options.extraAgentTools,
                subAgentTemplates: this.options.customSubagentTemplates,
                teamRole: teamContext?.role,
                channelTools,
            });
            const modelConfig = sessionRecord.config.chat_model_config;
            if (!modelConfig) {
                throw statusError(404, `No model configuration found for agent ${options.agentId}`);
            }
            const model = await this.options.modelResolver(
                options.userId,
                modelConfig,
                this.access
            );
            const fallback = sessionRecord.config.fallback_chat_model_config
                ? await this.options.modelResolver(
                      options.userId,
                      sessionRecord.config.fallback_chat_model_config,
                      this.access
                  )
                : null;
            const attachment = await this.systemAttachment(
                options.sessionId,
                sessionRecord,
                channel,
                channelTools
            );
            const AgentClass = this.options.agentClass;
            const agent = new AgentClass({
                name: agentRecord.data.name,
                systemPrompt: `${agentRecord.data.system_prompt}\n\n${attachment}`,
                model,
                toolkit,
                modelConfig: new ModelConfig({ fallbackModel: fallback }),
                contextConfig: normalizeContextConfig(agentRecord.data.context_config),
                reactConfig: normalizeReactConfig(agentRecord.data.react_config),
                state,
                middlewares,
                offloader: workspace,
            });
            if (ChatService.skipParkedWakeup(agent, options.input)) return;
            assembled = { agent, agentRecord, sessionRecord, channel };
        } catch (error) {
            await this.reportFailure(
                options.userId,
                options.sessionId,
                options.agentId,
                error,
                teamContext,
                workerName
            );
            return;
        }
        await this.execute(options, assembled, teamContext, workerName);
    }

    private async execute(
        options: {
            userId: string;
            sessionId: string;
            agentId: string;
            input: ChatInput;
            signal?: AbortSignal;
        },
        assembled: {
            agent: Agent;
            agentRecord: AgentRecord;
            sessionRecord: SessionRecord;
            channel: ChannelClient | null;
        },
        teamContext: TeamContext | null,
        workerName: string
    ): Promise<void> {
        const { agent, agentRecord, sessionRecord } = assembled;
        if (
            sessionRecord.source === 'channel' &&
            sessionRecord.source_channel_id &&
            sessionRecord.source_chat_id &&
            this.options.channelClients
        ) {
            await this.options.channelClients.deliver({
                sessionId: options.sessionId,
                channelId: sessionRecord.source_channel_id,
                chatId: sessionRecord.source_chat_id,
                agentId: options.agentId,
            });
        }
        const replies: Msg[] = [];
        let current: Msg | null = null;
        let released = false;
        let input = options.input;
        await registerInboxConsumer(this.messageBus, options.sessionId);
        try {
            while (true) {
                current = null;
                try {
                    current = await this.runOneTurn(
                        options,
                        input,
                        agent,
                        agentRecord,
                        sessionRecord
                    );
                } catch (error) {
                    const turnError = error instanceof TurnExecutionError ? error : null;
                    current = turnError?.reply ?? current;
                    const cause = turnError?.cause ?? error;
                    if (current === null) {
                        await this.reportFailure(
                            options.userId,
                            options.sessionId,
                            options.agentId,
                            cause,
                            teamContext,
                            workerName
                        );
                    } else {
                        await this.closeFailedReply(options.sessionId, current, cause);
                    }
                    if (current) replies.push(current);
                    break;
                }
                if (current) replies.push(current);
                if (!(await hasPendingInboxOrRelease(this.messageBus, options.sessionId))) {
                    released = true;
                    break;
                }
                input = null;
            }
        } finally {
            if (!released) {
                await abandonInboxConsumer(this.messageBus, {
                    userId: options.userId,
                    sessionId: options.sessionId,
                    agentId: options.agentId,
                });
            }
            if (current && replies.at(-1) !== current) replies.push(current);
            try {
                for (const reply of replies) {
                    await this.storage.upsertMessage(options.userId, options.sessionId, reply);
                }
                await this.storage.updateSessionState(
                    options.userId,
                    options.agentId,
                    options.sessionId,
                    agent.state.toJSON()
                );
                await this.messageBus.logTrim(MessageBusKeys.sessionEvents(options.sessionId));
            } finally {
                for (const reply of replies) {
                    if (
                        reply.finished_reason === ReplyFinishedReason.ERROR ||
                        reply.finished_reason === ReplyFinishedReason.INTERRUPTED
                    ) {
                        await this.notifyLeaderOfFailure(
                            options.userId,
                            teamContext,
                            workerName,
                            reply.finished_reason,
                            reply.error?.message ?? 'The turn stopped before it finished.'
                        );
                    }
                }
            }
        }
    }

    private async runOneTurn(
        options: { userId: string; sessionId: string; agentId: string; signal?: AbortSignal },
        input: ChatInput,
        agent: Agent,
        agentRecord: AgentRecord,
        sessionRecord: SessionRecord
    ): Promise<Msg | null> {
        let reply: Msg | null = null;
        try {
            if (isNewReplyInput(input)) {
                for (const message of normalizeMessages(input)) {
                    await this.storage.upsertMessage(options.userId, options.sessionId, message);
                }
            } else {
                reply = await this.storage.getMessage(
                    options.userId,
                    options.sessionId,
                    agent.state.replyId
                );
                if (reply && input) appendEvent(reply, input);
                if (
                    input?.type === EventType.USER_CONFIRM_RESULT ||
                    input?.type === EventType.EXTERNAL_EXECUTION_RESULT
                ) {
                    await this.publish(options.sessionId, input);
                }
                await this.publish(
                    options.sessionId,
                    createEvent({
                        type: EventType.REPLY_START,
                        session_id: options.sessionId,
                        reply_id: agent.state.replyId,
                        name: agentRecord.data.name,
                    })
                );
            }
            for await (const event of agent.replyStream({
                inputs: input,
                signal: options.signal,
            })) {
                if (event.type === EventType.REPLY_START) {
                    reply = AssistantMsg({ id: event.reply_id, name: event.name, content: [] });
                } else if (reply) {
                    appendEvent(reply, event);
                }
                await this.publish(options.sessionId, event);
                await this.projectEvent(options.userId, sessionRecord, agentRecord, event);
            }
        } catch (error) {
            throw new TurnExecutionError(error, reply);
        }
        return reply;
    }

    private async buildMiddlewares(
        options: { userId: string; sessionId: string; agentId: string },
        session: SessionRecord,
        workspace: WorkspaceBase,
        teamContext: TeamContext | null
    ): Promise<MiddlewareBase[]> {
        const middlewares: MiddlewareBase[] = [
            new InboxMiddleware(this.messageBus),
            new StateChangeMiddleware(this.messageBus, options.sessionId),
            new ToolOffloadMiddleware(
                this.backgroundTaskManager,
                this.messageBus,
                options.userId,
                options.agentId
            ),
        ];
        if (teamContext?.role === 'worker') {
            middlewares.push(new TeamMemberLoopMiddleware(teamContext.leaderName));
        }
        if (this.options.extraAgentMiddlewares) {
            const factory = this.options.extraAgentMiddlewares;
            const extras =
                factory.length === 3
                    ? await factory(options.userId, options.agentId, options.sessionId)
                    : await factory(options.userId, options.agentId, options.sessionId, workspace);
            middlewares.push(...extras);
        }
        if (session.config.tts_model_config) {
            middlewares.push(
                new TTSMiddleware(
                    await this.options.ttsModelResolver(
                        options.userId,
                        session.config.tts_model_config,
                        this.access
                    )
                )
            );
        }
        const knowledge = session.config.knowledge_config;
        if (knowledge?.knowledge_base_ids.length && this.options.knowledgeBaseManager) {
            const handles = [];
            for (const knowledgeBaseId of knowledge.knowledge_base_ids) {
                try {
                    const record = await this.access.resolveKnowledgeBase(
                        options.userId,
                        knowledgeBaseId
                    );
                    handles.push(
                        await this.options.knowledgeBaseManager.getKnowledge(
                            record.user_id,
                            knowledgeBaseId
                        )
                    );
                } catch {
                    // Deleted, unshared and misconfigured KBs do not block the remaining turn.
                }
            }
            if (handles.length) {
                middlewares.push(
                    new RAGMiddleware({
                        knowledge_bases: handles,
                        parameters: knowledge.parameters,
                    })
                );
            }
        }
        return middlewares;
    }

    private async resolveTeamContext(
        userId: string,
        session: SessionRecord
    ): Promise<TeamContext | null> {
        if (!session.team_id) return null;
        const team = await this.storage.getTeam(userId, session.team_id);
        if (!team) return null;
        if (team.session_id === session.id) return { role: 'leader' };
        const leader = await resolveTeamLeader(this.storage, userId, team);
        if (!leader) throw statusError(409, `Team '${team.id}' has no resolvable leader.`);
        return {
            role: 'worker',
            leaderSessionId: leader.session.id,
            leaderAgentId: leader.agent.id,
            leaderName: leader.agent.data.name,
        };
    }

    private async resolveChannel(session: SessionRecord): Promise<ChannelClient | null> {
        if (!session.source_channel_id || !this.options.channelClients) return null;
        return this.options.channelClients.get(session.source_channel_id);
    }

    private async systemAttachment(
        sessionId: string,
        session: SessionRecord,
        channel: ChannelClient | null,
        channelTools: ToolBase[]
    ): Promise<string> {
        let attachment = `You're within a session (id=${sessionId}).`;
        if (channel) {
            const chatId = session.source_chat_id ?? '';
            const kind = await channel.chatKind(chatId);
            const name = session.source_chat_name ?? (await channel.chatName(chatId));
            attachment +=
                ` This session is bound to a chat${name ? ` named "${name}"` : ''} (id ` +
                `'${chatId}') on the ${channel.displayName} platform: the messages, images and ` +
                'files people send there are relayed to you here, and your replies are ' +
                'delivered back to that same chat.';
            if (kind === 'group') {
                attachment +=
                    ' It is a group chat, so messages may come from several different people; ' +
                    'each incoming user turn is labelled with its sender.';
            } else if (kind === 'private') {
                attachment += ' It is a one-to-one private chat with a single user.';
            }
            if (channelTools.length) {
                attachment +=
                    ` You also have these ${channel.displayName} tools available: ` +
                    `${channelTools.map(tool => tool.name).join(', ')}. Pass this chat's id as ` +
                    'their target to act on this chat.';
            }
        }
        return `<system-notification>${attachment}</system-notification>`;
    }

    private async reportFailure(
        userId: string,
        sessionId: string,
        agentId: string,
        error: unknown,
        teamContext: TeamContext | null,
        workerName: string
    ): Promise<void> {
        try {
            const replyId = crypto.randomUUID().replaceAll('-', '');
            const start = createEvent({
                type: EventType.REPLY_START,
                session_id: sessionId,
                reply_id: replyId,
                name: agentId,
            });
            const end = createEvent({
                type: EventType.REPLY_END,
                session_id: sessionId,
                reply_id: replyId,
                finished_reason: ReplyFinishedReason.ERROR,
                error: classifySetupError(error),
            });
            const reply = AssistantMsg({ id: replyId, name: agentId, content: [] });
            appendEvent(reply, start);
            appendEvent(reply, end);
            await this.publish(sessionId, start);
            await this.publish(sessionId, end);
            await this.storage.upsertMessage(userId, sessionId, reply);
        } catch {
            // Best-effort reporting on an already-failed path.
        }
        await this.notifyLeaderOfFailure(
            userId,
            teamContext,
            workerName,
            ReplyFinishedReason.ERROR,
            classifySetupError(error).message
        );
    }

    private async closeFailedReply(sessionId: string, reply: Msg, error: unknown): Promise<void> {
        if (reply.finished_reason) return;
        const event = createEvent({
            type: EventType.REPLY_END,
            session_id: sessionId,
            reply_id: reply.id,
            finished_reason: ReplyFinishedReason.ERROR,
            error: classifyError(error),
        });
        appendEvent(reply, event);
        await this.publish(sessionId, event);
    }

    private async notifyLeaderOfFailure(
        userId: string,
        teamContext: TeamContext | null,
        workerName: string,
        reason: ReplyFinishedReason,
        detail: string
    ): Promise<void> {
        if (teamContext?.role !== 'worker') return;
        let message: string;
        if (reason === ReplyFinishedReason.INTERRUPTED) {
            message =
                `Team member '${workerName}' was interrupted mid-task and has stopped. Someone ` +
                'cancelled that run deliberately. Do not silently re-dispatch it: ask the user ' +
                'what should happen to the task, or ask the member how far it got.';
        } else {
            const sentence = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
            message =
                `Team member '${workerName}' hit an error while running, so it never called ` +
                `TeamSay to report. Error: ${sentence} Judge whether to retry or raise it with ` +
                'the user; assume no usable output unless the member reported partial results.';
        }
        try {
            await deliverToInbox(this.messageBus, {
                userId,
                sessionId: teamContext.leaderSessionId,
                agentId: teamContext.leaderAgentId,
                payload: {
                    ...HintBlock({
                        hint: `<system-reminder>${message}</system-reminder>`,
                        source: JSON.stringify({ label: 'System', sublabel: 'Reminder' }),
                    }),
                },
            });
        } catch {
            // Leader notification is best-effort and cannot replace the original failure.
        }
    }

    private async projectEvent(
        userId: string,
        session: SessionRecord,
        agent: AgentRecord,
        event: AgentEvent
    ): Promise<void> {
        for (const projector of this.projectors) {
            try {
                await projector.maybeProject(userId, session, agent, event, this.projection);
            } catch {
                // Projectors are independent observers and cannot terminate a run.
            }
        }
    }

    private publish(sessionId: string, event: AgentEvent): Promise<string> {
        return this.messageBus.sessionPublishEvent(sessionId, {
            ...(event as unknown as BusPayload),
        });
    }
}

function isNewReplyInput(input: ChatInput): input is Msg | Msg[] | null {
    return input === null || Array.isArray(input) || isMessage(input);
}

function normalizeMessages(input: Msg | Msg[] | null): Msg[] {
    if (input === null) return [];
    return Array.isArray(input) ? input : [input];
}

function isMessage(input: Exclude<ChatInput, Msg[] | null>): input is Msg {
    return 'role' in input && 'content' in input;
}

async function resolveTeamLeader(storage: StorageBase, userId: string, team: TeamRecord) {
    const session = await storage.getSession(userId, '', team.session_id);
    if (!session) return null;
    const agent = await storage.getAgent(userId, team.leader_agent_id ?? session.agent_id);
    return agent ? { session, agent } : null;
}

function normalizeContextConfig(
    config: Record<string, unknown>
): Partial<AgentOptions['contextConfig']> {
    return renameKnown(config, {
        trigger_ratio: 'triggerRatio',
        reserve_ratio: 'reserveRatio',
        context_buffer_ratio: 'contextBufferRatio',
        compression_prompt: 'compressionPrompt',
        summary_template: 'summaryTemplate',
        summary_schema: 'summarySchema',
        tool_result_limit: 'toolResultLimit',
        compression_fallback_to_truncation: 'compressionFallbackToTruncation',
        compression_tool_enabled: 'compressionToolEnabled',
        max_image_num: 'maxImageNum',
    });
}

function normalizeReactConfig(
    config: Record<string, unknown>
): Partial<AgentOptions['reactConfig']> {
    return renameKnown(config, {
        max_iters: 'maxIters',
        structured_output_grace_iters: 'structuredOutputGraceIters',
        stop_on_reject: 'stopOnReject',
        interruption_message: 'interruptionMessage',
        interruption_raise_cancelled_error: 'interruptionRaiseCancelledError',
    });
}

function renameKnown(
    source: Record<string, unknown>,
    names: Record<string, string>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(source).map(([key, value]) => [names[key] ?? key, value])
    );
}

function statusError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

class TurnExecutionError extends Error {
    constructor(
        readonly cause: unknown,
        readonly reply: Msg | null
    ) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'TurnExecutionError';
    }
}
