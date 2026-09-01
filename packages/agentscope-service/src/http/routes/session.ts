import { createEvent, EventType, parseAgentEvent } from '@agentscope-ai/agentscope/event';
import { parseMsg } from '@agentscope-ai/agentscope/message';
import { createPermissionContext, PermissionMode } from '@agentscope-ai/agentscope/permission';
import { AgentState, ToolContext } from '@agentscope-ai/agentscope/state';
import { z } from 'zod';

import { enqueueRunTrigger } from '../../bus-ops';
import { MessageBusKeys } from '../../message-bus';
import {
    SessionProjection,
    SessionService,
    SessionStatus,
    SubagentHitlProjector,
    type AgentView,
    type ChatInput,
} from '../../service';
import {
    ScheduleRecordSchema,
    SessionConfigSchema,
    type SessionRecord,
    type TeamRecord,
} from '../../storage';
import { HTTPError } from '../errors';
import { emptyResponse, iterableResponse, jsonResponse } from '../response';
import type { AgentScopeHTTPRouter, HTTPContext } from '../router';
import {
    AgentQuerySchema,
    ChatRequestSchema,
    CreateScheduleRequestSchema,
    CreateSessionRequestSchema,
    MessageQuerySchema,
    UpdateScheduleRequestSchema,
    UpdateSessionRequestSchema,
} from '../schemas';

/**
 * Register session, chat, schedule, and session-event SSE routes.
 * @param router
 */
export function registerSessionRoutes(router: AgentScopeHTTPRouter): void {
    registerSessionCRUD(router);
    registerChatRoute(router);
    registerScheduleRoutes(router);
}

/**
 *
 * @param router
 */
function registerSessionCRUD(router: AgentScopeHTTPRouter): void {
    router.get('/sessions/', async context => {
        const userId = context.userId();
        const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
            typeof AgentQuerySchema
        >;
        await context.app.services.resourceAccess.resolveAgent(userId, agentId);
        const views = [];
        for (const session of await context.app.storage.listSessions(userId, agentId)) {
            const running = await context.app.messageBus.sessionIsRunning(session.id);
            views.push({
                session: trimSession(session),
                is_running: running,
                status: running
                    ? SessionStatus.RUNNING
                    : SessionService.deriveParkedStatus(session.state.context),
                team: session.team_id
                    ? await buildTeamDetail(context, userId, session.team_id)
                    : null,
            });
        }
        return jsonResponse({ sessions: views, total: views.length });
    });
    router.post('/sessions/', async context => {
        const userId = context.userId();
        const body = (await context.json(CreateSessionRequestSchema)) as z.output<
            typeof CreateSessionRequestSchema
        >;
        await context.app.services.resourceAccess.resolveAgent(userId, body.agent_id);
        await validateSessionReferences(context, userId, body);
        const provisionalId = crypto.randomUUID().replaceAll('-', '');
        const workspaceId =
            body.workspace_id ??
            (await context.app.workspaceManager.assignWorkspaceId({
                userId,
                agentId: body.agent_id,
                sessionId: provisionalId,
            }));
        const config = SessionConfigSchema.parse({
            workspace_id: workspaceId,
            ...(body.name == null ? {} : { name: body.name }),
            chat_model_config: body.chat_model_config ?? null,
            fallback_chat_model_config: body.fallback_chat_model_config ?? null,
            tts_model_config: body.tts_model_config ?? null,
            knowledge_config: body.knowledge_config ?? null,
        });
        const existing = (await context.app.storage.listSessions(userId, body.agent_id)).find(
            session => session.config.workspace_id === workspaceId
        );
        const session = await context.app.storage.upsertSession({
            userId,
            agentId: body.agent_id,
            sessionId: existing?.id,
            config,
        });
        return jsonResponse({ session_id: session.id }, 201);
    });
    router.delete('/sessions/{session_id}', async context => {
        const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
            typeof AgentQuerySchema
        >;
        const deleted = await context.app.services.session.deleteSession(
            context.userId(),
            agentId,
            context.params.session_id
        );
        if (!deleted) throw new HTTPError(404, `Session '${context.params.session_id}' not found.`);
        return emptyResponse();
    });
    router.post('/sessions/{session_id}/interrupt', async context => {
        const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
            typeof AgentQuerySchema
        >;
        try {
            await context.app.services.chat.interrupt(
                context.userId(),
                context.params.session_id,
                agentId
            );
        } catch (error) {
            throw new HTTPError(404, error instanceof Error ? error.message : String(error));
        }
        return jsonResponse({ session_id: context.params.session_id }, 202);
    });
    router.patch('/sessions/{session_id}', async context => {
        const userId = context.userId();
        const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
            typeof AgentQuerySchema
        >;
        const body = (await context.json(UpdateSessionRequestSchema)) as z.output<
            typeof UpdateSessionRequestSchema
        >;
        const existing = await context.app.storage.getSession(
            userId,
            agentId,
            context.params.session_id
        );
        if (!existing)
            throw new HTTPError(404, `Session '${context.params.session_id}' not found.`);
        if (await context.app.messageBus.sessionIsRunning(existing.id)) {
            throw new HTTPError(
                409,
                'Cannot modify session configuration while the session is running.'
            );
        }
        await validateSessionReferences(context, userId, body);
        const { permission_mode: permissionMode, ...configBody } = body;
        const config = SessionConfigSchema.parse({ ...existing.config, ...configBody });
        let state = existing.state;
        if (permissionMode !== undefined) {
            state = new AgentState({
                ...existing.state,
                permissionContext: createPermissionContext(permissionMode as PermissionMode),
            }).toJSON();
        }
        const updated = await context.app.storage.upsertSession({
            userId,
            agentId,
            sessionId: existing.id,
            config,
            state,
        });
        return jsonResponse(updated);
    });
    router.get('/sessions/{session_id}/messages', async context => {
        const userId = context.userId();
        const query = context.query(MessageQuerySchema) as z.output<typeof MessageQuerySchema>;
        const existing = await context.app.storage.getSession(
            userId,
            query.agent_id,
            context.params.session_id
        );
        if (!existing)
            throw new HTTPError(404, `Session '${context.params.session_id}' not found.`);
        const page = await context.app.storage.listMessages(userId, existing.id, {
            limit: query.limit,
            before: query.before,
        });
        return jsonResponse({
            messages: page.messages,
            is_running: await context.app.messageBus.sessionIsRunning(existing.id),
            has_more: page.hasMore,
        });
    });
    router.get('/sessions/{session_id}/status', async context => {
        const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
            typeof AgentQuerySchema
        >;
        const status = await context.app.services.session.getSessionStatus(
            context.userId(),
            agentId,
            context.params.session_id
        );
        if (status === null)
            throw new HTTPError(404, `Session '${context.params.session_id}' not found.`);
        return jsonResponse({ session_id: context.params.session_id, status });
    });
    router.get('/sessions/{session_id}/stream', async context => streamSession(context));
}

/**
 *
 * @param router
 */
function registerChatRoute(router: AgentScopeHTTPRouter): void {
    router.post('/chat/', async context => {
        const userId = context.userId();
        const body = (await context.json(ChatRequestSchema)) as z.output<typeof ChatRequestSchema>;
        const input = parseChatInput(body.input);
        if (
            input &&
            !Array.isArray(input) &&
            'type' in input &&
            (input.type === EventType.USER_CONFIRM_RESULT ||
                input.type === EventType.EXTERNAL_EXECUTION_RESULT)
        ) {
            let sessionId = body.session_id;
            let agentId = body.agent_id;
            const target = await SubagentHitlProjector.resolve(
                new SessionProjection(context.app.messageBus),
                body.session_id,
                input.reply_id
            );
            if (target) {
                if (typeof target.worker_session_id === 'string')
                    sessionId = target.worker_session_id;
                if (typeof target.worker_agent_id === 'string') agentId = target.worker_agent_id;
            }
            await enqueueRunTrigger(context.app.messageBus, {
                userId,
                sessionId,
                agentId,
                kind: MessageBusKeys.WAKEUP_KIND_RESUME,
                input,
            });
            return jsonResponse({ status: 'started', session_id: sessionId });
        }
        try {
            context.app.managers.chatRuns.spawn(
                signal =>
                    context.app.services.chat.run({
                        userId,
                        sessionId: body.session_id,
                        agentId: body.agent_id,
                        input,
                        signal,
                    }),
                { sessionId: body.session_id }
            );
        } catch (error) {
            throw new HTTPError(409, error instanceof Error ? error.message : String(error));
        }
        return jsonResponse({ status: 'started', session_id: body.session_id });
    });
}

/**
 *
 * @param router
 */
function registerScheduleRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/schedule/', async context => {
        const schedules = await context.app.storage.listSchedules(context.userId());
        return jsonResponse({ schedules, total: schedules.length });
    });
    router.post('/schedule/', async context => {
        const userId = context.userId();
        const body = (await context.json(CreateScheduleRequestSchema)) as z.output<
            typeof CreateScheduleRequestSchema
        >;
        await context.app.services.resourceAccess.resolveAgent(userId, body.agent_id);
        await context.app.services.resourceAccess.getResource(
            userId,
            'credential',
            body.chat_model_config.credential_id
        );
        const record = ScheduleRecordSchema.parse({
            user_id: userId,
            agent_id: body.agent_id,
            data: { ...body, source: 'USER', started_at: new Date().toISOString() },
        });
        validateSchedule(context, record);
        await context.app.storage.upsertSchedule(userId, record);
        await context.app.managers.scheduler.notifyChanged(record.id);
        return jsonResponse({ schedule_id: record.id }, 201);
    });
    router.patch('/schedule/{schedule_id}', async context => {
        const userId = context.userId();
        const body = (await context.json(UpdateScheduleRequestSchema)) as z.output<
            typeof UpdateScheduleRequestSchema
        >;
        const existing = await context.app.storage.getSchedule(userId, context.params.schedule_id);
        if (!existing)
            throw new HTTPError(404, `Schedule '${context.params.schedule_id}' not found.`);
        const record = ScheduleRecordSchema.parse({
            ...existing,
            data: { ...existing.data, ...body },
            updated_at: new Date().toISOString(),
        });
        validateSchedule(context, record);
        await context.app.storage.upsertSchedule(userId, record);
        await context.app.managers.scheduler.notifyChanged(record.id);
        return jsonResponse(record);
    });
    router.delete('/schedule/{schedule_id}', async context => {
        const deleted = await context.app.services.session.deleteSchedule(
            context.userId(),
            context.params.schedule_id
        );
        if (!deleted)
            throw new HTTPError(404, `Schedule '${context.params.schedule_id}' not found.`);
        await context.app.managers.scheduler.notifyChanged(context.params.schedule_id);
        return emptyResponse();
    });
    router.get('/schedule/{schedule_id}/sessions', async context => {
        const userId = context.userId();
        if (!(await context.app.storage.getSchedule(userId, context.params.schedule_id))) {
            throw new HTTPError(404, `Schedule '${context.params.schedule_id}' not found.`);
        }
        const sessions = await context.app.storage.listSessionsBySchedule(
            userId,
            context.params.schedule_id
        );
        return jsonResponse({ sessions, total: sessions.length });
    });
}

/**
 *
 * @param context
 * @param userId
 * @param body
 */
async function validateSessionReferences(
    context: HTTPContext,
    userId: string,
    body: Record<string, unknown>
): Promise<void> {
    for (const field of ['chat_model_config', 'fallback_chat_model_config', 'tts_model_config']) {
        const config = body[field] as { credential_id?: string } | null | undefined;
        if (config?.credential_id) {
            await context.app.services.resourceAccess.getResource(
                userId,
                'credential',
                config.credential_id
            );
        }
    }
    const knowledge = body.knowledge_config as { knowledge_base_ids?: string[] } | null | undefined;
    for (const id of knowledge?.knowledge_base_ids ?? []) {
        await context.app.services.resourceAccess.getResource(userId, 'knowledge_base', id);
    }
}

/**
 *
 * @param context
 * @param record
 */
function validateSchedule(
    context: HTTPContext,
    record: z.output<typeof ScheduleRecordSchema>
): void {
    try {
        context.app.managers.scheduler.validateSchedule(record);
    } catch (error) {
        throw new HTTPError(422, error instanceof Error ? error.message : String(error));
    }
}

/**
 *
 * @param value
 */
function parseChatInput(value: unknown): ChatInput {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(item => parseMsg(item));
    if (value && typeof value === 'object' && 'role' in value) return parseMsg(value);
    const event = parseAgentEvent(value);
    if (
        event.type !== EventType.USER_CONFIRM_RESULT &&
        event.type !== EventType.EXTERNAL_EXECUTION_RESULT &&
        event.type !== EventType.USER_INTERRUPT
    ) {
        throw new HTTPError(422, `Event type '${event.type}' is not a valid chat input.`);
    }
    return event;
}

/**
 *
 * @param session
 */
function trimSession(session: SessionRecord): SessionRecord {
    return {
        ...session,
        state: {
            ...session.state,
            context: [],
            summary: '',
            tool_context: new ToolContext().toJSON(),
        },
    };
}

/**
 *
 * @param context
 * @param userId
 * @param teamId
 */
async function buildTeamDetail(context: HTTPContext, userId: string, teamId: string) {
    const team = await context.app.storage.getTeam(userId, teamId);
    if (!team) return null;
    const leader = await resolveLeader(context, userId, team);
    const members = [];
    for (const member of team.data.members) {
        const agent = await context.app.storage.getAgent(member.owner_id, member.agent_id);
        if (agent) {
            members.push({
                agent: { ...agent, editable: member.owner_id === userId } satisfies AgentView,
                session_id: member.session_id,
            });
        }
    }
    return { team, leader_agent: leader, members };
}

/**
 *
 * @param context
 * @param userId
 * @param team
 */
async function resolveLeader(context: HTTPContext, userId: string, team: TeamRecord) {
    const session = await context.app.storage.getSession(userId, '', team.session_id);
    if (!session) return null;
    const agent = await context.app.storage.getAgent(
        userId,
        team.leader_agent_id ?? session.agent_id
    );
    return agent ? ({ ...agent, editable: agent.user_id === userId } satisfies AgentView) : null;
}

/**
 *
 * @param context
 */
async function streamSession(context: HTTPContext): Promise<Response> {
    const userId = context.userId();
    const { agent_id: agentId } = context.query(AgentQuerySchema) as z.output<
        typeof AgentQuerySchema
    >;
    if (!(await context.app.storage.getSession(userId, agentId, context.params.session_id))) {
        throw new HTTPError(404, `Session '${context.params.session_id}' not found.`);
    }
    const sessionId = context.params.session_id;
    const bus = context.app.messageBus;
    const controller = new AbortController();
    context.request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    /**
     *
     */
    async function* events(): AsyncIterable<string> {
        for (const [, event] of await bus.sessionReadEvents(
            sessionId,
            undefined,
            MessageBusKeys.SESSION_REPLAY_MAX_LEN
        )) {
            yield `data: ${JSON.stringify(event)}\n\n`;
        }
        const projection = new SessionProjection(bus);
        for (const payload of await projection.list(sessionId, SubagentHitlProjector.KIND)) {
            yield `data: ${JSON.stringify(
                createEvent({
                    type: EventType.CUSTOM,
                    name: SubagentHitlProjector.EVT_REQUIRE,
                    value: payload,
                })
            )}\n\n`;
        }
        const iterator = bus
            .sessionSubscribeEvents(sessionId, {
                signal: controller.signal,
            })
            [Symbol.asyncIterator]();
        while (!controller.signal.aborted) {
            const item = await nextWithHeartbeat(iterator, 30_000);
            if (item === 'heartbeat') {
                yield ':\n\n';
            } else if (item.done) {
                break;
            } else {
                yield `data: ${JSON.stringify(item.value)}\n\n`;
            }
        }
        await iterator.return?.();
    }
    return iterableResponse(
        events(),
        {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no',
            },
        },
        () => controller.abort()
    );
}

/**
 *
 * @param iterator
 * @param timeoutMs
 */
function nextWithHeartbeat<T>(
    iterator: AsyncIterator<T>,
    timeoutMs: number
): Promise<IteratorResult<T> | 'heartbeat'> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('heartbeat'), timeoutMs);
        void iterator.next().then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
