/* eslint-disable jsdoc/require-jsdoc */

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { DeveloperOrientedException } from '@agentscope-ai/agentscope/exception';
import { AssistantMsg, ToolCallBlock } from '@agentscope-ai/agentscope/message';
import { AgentState } from '@agentscope-ai/agentscope/state';
import { ErrorType } from '@agentscope-ai/agentscope/type';

import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import {
    classifyError,
    classifySetupError,
    SessionProjection,
    SessionService,
    SessionStatus,
    signDownloadToken,
    SubagentHitlProjector,
    verifyDownloadToken,
} from '../src/service';
import {
    AgentRecordSchema,
    InMemoryStorage,
    SessionConfigSchema,
    TeamRecordSchema,
    type AgentRecord,
    type SessionRecord,
} from '../src/storage';

class StatusError extends Error {
    constructor(readonly status_code: number) {
        super(`status ${status_code}`);
    }
}

class APIConnectionError extends Error {}

function agent(id: string, name = id, source: 'user' | 'team' = 'user'): AgentRecord {
    return AgentRecordSchema.parse({
        id,
        user_id: 'u',
        source,
        data: {
            id,
            name,
            context_config: {},
            react_config: {},
        },
    });
}

async function session(
    storage: InMemoryStorage,
    agentId: string,
    sessionId: string,
    options: { state?: AgentState; teamId?: string | null; sourceScheduleId?: string } = {}
): Promise<SessionRecord> {
    const record = await storage.upsertSession({
        userId: 'u',
        agentId,
        sessionId,
        config: SessionConfigSchema.parse({ workspace_id: `workspace-${agentId}` }),
        state: options.state?.toJSON(),
        source: options.sourceScheduleId ? 'schedule' : 'user',
        sourceScheduleId: options.sourceScheduleId,
    });
    if (options.teamId !== undefined) {
        await storage.setSessionTeamId('u', sessionId, options.teamId);
        return (await storage.getSession('u', agentId, sessionId))!;
    }
    return record;
}

describe('service error classification', () => {
    test.each([
        [400, ErrorType.INVALID_REQUEST],
        [401, ErrorType.AUTHENTICATION],
        [403, ErrorType.PERMISSION],
        [404, ErrorType.INVALID_REQUEST],
        [418, ErrorType.INVALID_REQUEST],
        [422, ErrorType.INVALID_REQUEST],
        [429, ErrorType.RATE_LIMIT],
        [500, ErrorType.UPSTREAM],
        [503, ErrorType.UPSTREAM],
    ])('maps HTTP %d to %s', (status, expected) => {
        expect(classifyError(new StatusError(status)).type).toBe(expected);
        const responseError = Object.assign(new Error('response'), {
            response: { status_code: status },
        });
        expect(classifyError(responseError).type).toBe(expected);
    });

    test('walks causes and aggregate members and detects provider network types', () => {
        expect(classifyError(new Error('outer', { cause: new StatusError(401) })).type).toBe(
            ErrorType.AUTHENTICATION
        );
        expect(classifyError(new AggregateError([new APIConnectionError('offline')])).type).toBe(
            ErrorType.CONNECTION
        );
    });

    test('separates internal, unknown, and setup failures without leaking details', () => {
        expect(classifyError(new DeveloperOrientedException('secret')).type).toBe(
            ErrorType.INTERNAL
        );
        const unknown = classifyError(new Error('provider-secret'));
        expect(unknown).toEqual({
            type: ErrorType.UNKNOWN,
            message: 'The reply failed with an unknown error.',
        });
        expect(classifySetupError(new Error('provider-secret')).type).toBe(ErrorType.SETUP);
        expect(unknown.message).not.toContain('provider-secret');
    });
});

describe('download tokens', () => {
    test('matches the Python HMAC fixture byte-for-byte', () => {
        expect(signDownloadToken('secret', '用户', '/a b', 60, 1_000_000)).toEqual({
            token: '1060.55So5oi3.27vjsC05TU6Wbe9GibcNhPu0Ks1SdfF1JBVyiN63fcs',
            expiresAt: 1060,
        });
        expect(
            verifyDownloadToken(
                'secret',
                '1060.55So5oi3.27vjsC05TU6Wbe9GibcNhPu0Ks1SdfF1JBVyiN63fcs',
                '/a b',
                1_000_000
            )
        ).toBe('用户');
    });

    test('rejects path replay, another secret, expiry, and malformed input', () => {
        const { token } = signDownloadToken('secret', 'alice', '/a', 60, 1_000_000);
        expect(() => verifyDownloadToken('secret', token, '/b', 1_000_000)).toThrow(
            'Invalid download token.'
        );
        expect(() => verifyDownloadToken('other', token, '/a', 1_000_000)).toThrow(
            'Invalid download token.'
        );
        expect(() => verifyDownloadToken('secret', token, '/a', 1_061_000)).toThrow(
            'Expired download token.'
        );
        expect(() => verifyDownloadToken('secret', 'bad', '/a')).toThrow(
            'Malformed download token.'
        );
    });
});

describe('SessionProjection and SubagentHitlProjector', () => {
    test('stores feeds independently, publishes live CustomEvents, and purges by kind', async () => {
        const bus = new InMemoryMessageBus();
        const projection = new SessionProjection(bus);
        await projection.upsert('leader', 'hitl', 'one', { value: 1 });
        await projection.upsert('leader', 'progress', 'two', { value: 2 });
        await projection.publish('leader', 'changed', { entry_id: 'one' });

        expect(await projection.list('leader', 'hitl')).toEqual([{ value: 1 }]);
        expect((await bus.sessionReadEvents('leader')).map(([, value]) => value)).toEqual([
            expect.objectContaining({
                type: EventType.CUSTOM,
                name: 'changed',
                value: { entry_id: 'one' },
            }),
        ]);
        await projection.purge('leader', 'hitl');
        expect(await projection.list('leader', 'hitl')).toEqual([]);
        expect(await projection.list('leader', 'progress')).toEqual([{ value: 2 }]);
    });

    test('projects worker require/result events and resolves the owning session', async () => {
        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const leaderAgent = agent('leader-agent', 'leader');
        const workerAgent = agent('worker-agent', 'researcher', 'team');
        await storage.upsertAgent('u', leaderAgent);
        await storage.upsertAgent('u', workerAgent);
        await session(storage, leaderAgent.id, 'leader-sid', { teamId: 'team' });
        const worker = await session(storage, workerAgent.id, 'worker-sid', { teamId: 'team' });
        await storage.upsertTeam(
            'u',
            TeamRecordSchema.parse({
                id: 'team',
                user_id: 'u',
                session_id: 'leader-sid',
                data: { name: 'team' },
            })
        );
        const projection = new SessionProjection(bus);
        const projector = new SubagentHitlProjector(storage);
        const requireEvent = createEvent({
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: 'reply',
            tool_calls: [],
        });

        await projector.maybeProject('u', worker, workerAgent, requireEvent, projection);

        expect(await SubagentHitlProjector.resolve(projection, 'leader-sid', 'reply')).toEqual(
            expect.objectContaining({
                worker_session_id: 'worker-sid',
                worker_agent_id: 'worker-agent',
                worker_agent_name: 'researcher',
                event_type: 'require_user_confirm',
            })
        );
        await projector.maybeProject(
            'u',
            worker,
            workerAgent,
            createEvent({
                type: EventType.REPLY_END,
                reply_id: 'reply',
                session_id: 'worker-sid',
            }),
            projection
        );
        expect(await SubagentHitlProjector.resolve(projection, 'leader-sid', 'reply')).toBeNull();
        const names = (await bus.sessionReadEvents('leader-sid')).map(([, event]) => event.name);
        expect(names).toEqual([
            SubagentHitlProjector.EVT_REQUIRE,
            SubagentHitlProjector.EVT_RESULT,
        ]);
    });

    test('does not project a teamless or leader session', async () => {
        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const record = agent('agent');
        await storage.upsertAgent('u', record);
        const teamless = await session(storage, record.id, 'solo');
        const projector = new SubagentHitlProjector(storage);
        const projection = new SessionProjection(bus);
        await projector.maybeProject(
            'u',
            teamless,
            record,
            createEvent({
                type: EventType.REQUIRE_EXTERNAL_EXECUTION,
                reply_id: 'reply',
                tool_calls: [],
            }),
            projection
        );
        expect(await projection.list('solo', SubagentHitlProjector.KIND)).toEqual([]);
    });
});

describe('SessionService', () => {
    test('derives live and parked status with asking taking precedence', async () => {
        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const record = agent('agent');
        await storage.upsertAgent('u', record);
        const state = new AgentState({
            context: [
                AssistantMsg({
                    name: 'agent',
                    content: [
                        ToolCallBlock({
                            id: 'submitted',
                            name: 'Bash',
                            input: '{}',
                            state: 'submitted',
                        }),
                        ToolCallBlock({
                            id: 'asking',
                            name: 'Write',
                            input: '{}',
                            state: 'asking',
                        }),
                    ],
                }),
            ],
        });
        await session(storage, record.id, 'session', { state });
        const service = new SessionService(storage, bus);

        expect(await service.getSessionStatus('u', record.id, 'session')).toBe(
            SessionStatus.AWAITING_PERMISSION
        );
        const lock = await bus.acquireLock(MessageBusKeys.sessionLock('session'));
        expect(await service.getSessionStatus('u', record.id, 'session')).toBe(
            SessionStatus.RUNNING
        );
        await lock.release();
        expect(await service.getSessionStatus('u', record.id, 'missing')).toBeNull();
    });

    test('cancel waits for a distributed lock and reports timeout', async () => {
        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const lock = await bus.acquireLock(MessageBusKeys.sessionLock('session'));
        const service = new SessionService(storage, bus, null, { cancelPollIntervalMs: 1 });
        expect(await service.cancelSessionRun('session', 0)).toBe(false);
        await lock.release();
        expect(await service.cancelSessionRun('session', 10)).toBe(true);
    });

    test('team deletion removes created agents and borrowed sessions but preserves the leader', async () => {
        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const leader = agent('leader');
        const created = agent('created', 'created', 'team');
        const invited = agent('invited');
        for (const record of [leader, created, invited]) await storage.upsertAgent('u', record);
        await session(storage, leader.id, 'leader-session', { teamId: 'team' });
        await session(storage, created.id, 'created-session', { teamId: 'team' });
        await session(storage, invited.id, 'invited-session', { teamId: 'team' });
        await storage.upsertTeam(
            'u',
            TeamRecordSchema.parse({
                id: 'team',
                user_id: 'u',
                session_id: 'leader-session',
                data: {
                    name: 'team',
                    member_ids: [created.id, invited.id],
                    members: [
                        {
                            owner_id: 'u',
                            agent_id: created.id,
                            session_id: 'created-session',
                            role: 'created',
                        },
                        {
                            owner_id: 'u',
                            agent_id: invited.id,
                            session_id: 'invited-session',
                            role: 'invited',
                        },
                    ],
                },
            })
        );
        for (const sessionId of ['created-session', 'invited-session']) {
            await bus.inboxPush(sessionId, { pending: true });
            await bus.sessionPublishEvent(sessionId, { pending: true });
        }
        const service = new SessionService(storage, bus);

        expect(await service.deleteTeam('u', 'team')).toBe(true);

        expect(await storage.getAgent('u', created.id)).toBeNull();
        expect(await storage.getAgent('u', invited.id)).not.toBeNull();
        expect(await storage.getSession('u', invited.id, 'invited-session')).toBeNull();
        expect(await storage.getSession('u', leader.id, 'leader-session')).toMatchObject({
            team_id: null,
        });
        expect(await storage.getTeam('u', 'team')).toBeNull();
        expect(await bus.inboxDrain('created-session')).toEqual([]);
        expect(await bus.sessionReadEvents('invited-session')).toEqual([]);
    });
});
