/* eslint-disable jsdoc/require-jsdoc */

import { AgentState } from '@agentscope-ai/agentscope/state';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { deliverToInbox, hasPendingInboxOrRelease, registerInboxConsumer } from '../src/bus-ops';
import { SchedulerManager } from '../src/manager';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import { InMemoryStorage, ScheduleRecordSchema, type ScheduleRecord } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class AssignmentManager extends WorkspaceManagerBase {
    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('unused');
    }

    async close(): Promise<void> {}

    async closeAll(): Promise<void> {}
}

function makeRecord(
    overrides: Partial<ScheduleRecord['data']> = {},
    envelope: Partial<Pick<ScheduleRecord, 'user_id' | 'agent_id' | 'id'>> = {}
): ScheduleRecord {
    return ScheduleRecordSchema.parse({
        ...envelope,
        user_id: envelope.user_id ?? 'u',
        agent_id: envelope.agent_id ?? 'a',
        data: {
            name: 'sched-a',
            description: 'run nightly summary',
            enabled: true,
            timezone: 'UTC',
            cron_expression: '0 0 * * *',
            started_at: '2025-01-01T00:00:00Z',
            chat_model_config: {
                type: 'test',
                credential_id: 'credential',
                model: 'model',
                parameters: {},
            },
            stateful: false,
            permission_mode: 'dont_ask',
            ...overrides,
        },
    });
}

function fixture(options: { enabled?: boolean; now?: () => Date } = {}) {
    const storage = new InMemoryStorage();
    const bus = new InMemoryMessageBus();
    const workspace = new AssignmentManager();
    const manager = new SchedulerManager(storage, bus, workspace, options);
    return { storage, bus, workspace, manager };
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for scheduler state.');
}

describe('scheduler fire delivery', () => {
    test('creates a scheduled session, HintBlock, and wakeup', async () => {
        const { manager, storage, bus } = fixture();
        const record = makeRecord({ description: 'please summarise the news' });

        await manager.buildTrigger(record)();

        const sessions = await storage.listSessions('u', 'a');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            source: 'schedule',
            source_schedule_id: record.id,
            config: { workspace_id: '77377d7bd2f7a1fc' },
        });
        const inbox = await bus.inboxDrain(sessions[0].id, 10);
        expect(inbox.map(([, payload]) => payload)).toEqual([
            expect.objectContaining({
                type: 'hint',
                hint: '<scheduled-task>\nplease summarise the news\n</scheduled-task>',
                source: JSON.stringify({ label: 'schedule', sublabel: 'sched-a' }),
            }),
        ]);
        expect(await bus.dequeueWakeups(10)).toEqual([
            {
                user_id: 'u',
                session_id: sessions[0].id,
                agent_id: 'a',
                kind: 'wake',
                input: null,
            },
        ]);
    });

    test('disabled fire has no side effects', async () => {
        const { manager, storage, bus } = fixture();

        await manager.buildTrigger(makeRecord({ enabled: false }))();

        expect(await storage.listSessions('u', 'a')).toEqual([]);
        expect(await bus.dequeueWakeups()).toEqual([]);
    });

    test('stateful fires reuse one session while fresh fires do not', async () => {
        const stateful = fixture();
        const record = makeRecord({ stateful: true });
        await stateful.manager.buildTrigger(record)();
        await stateful.manager.buildTrigger(record)();
        const shared = await stateful.storage.listSessions('u', 'a');
        expect(shared.map(session => session.id)).toEqual([`${record.id}_stateful`]);
        expect(await stateful.bus.inboxDrain(shared[0].id, 10)).toHaveLength(2);
        expect(await stateful.bus.dequeueWakeups(10)).toHaveLength(2);

        const fresh = fixture();
        const freshRecord = makeRecord();
        await fresh.manager.buildTrigger(freshRecord)();
        await fresh.manager.buildTrigger(freshRecord)();
        const sessions = await fresh.storage.listSessions('u', 'a');
        expect(sessions).toHaveLength(2);
        expect(new Set(sessions.map(session => session.id)).size).toBe(2);
    });

    test('workspace binding isolates users and covers both session branches', async () => {
        const { manager, storage } = fixture();
        await manager.buildTrigger(makeRecord({ stateful: true }, { user_id: 'alice' }))();
        await manager.buildTrigger(makeRecord({}, { user_id: 'bob' }))();

        expect((await storage.listSessions('alice', 'a'))[0].config.workspace_id).toBe(
            'ca79105d522eba6f'
        );
        expect((await storage.listSessions('bob', 'a'))[0].config.workspace_id).toBe(
            'ecbe3dbe754c96ee'
        );
    });
});

describe('scheduler validation and ownership', () => {
    test.each([
        ['not a cron', 'UTC'],
        ['61 9 * * *', 'UTC'],
        ['0 9 * * *', ''],
        ['0 9 * * *', 'Mars/Olympus_Mons'],
    ])('rejects invalid cron=%s timezone=%s', (cronExpression, timezone) => {
        expect(() =>
            SchedulerManager.validateSchedule(
                makeRecord({ cron_expression: cronExpression, timezone })
            )
        ).toThrow();
    });

    test('rejects an inverted activation window', () => {
        expect(() =>
            SchedulerManager.validateSchedule(
                makeRecord({
                    started_at: '2026-01-02T00:00:00Z',
                    ended_at: '2026-01-01T00:00:00Z',
                })
            )
        ).toThrow('ended_at must be later than started_at');
    });

    test('reconcile holds enabled records and removes deleted or disabled ones', async () => {
        const { manager, storage } = fixture({
            now: () => new Date('2026-09-01T00:00:00Z'),
        });
        const live = makeRecord();
        const disabled = makeRecord({ enabled: false });
        await storage.upsertSchedule('u', live);
        await storage.upsertSchedule('u', disabled);

        await manager.reconcile();
        expect((await manager.listTasks()).map(task => task.id)).toEqual([live.id]);

        await storage.deleteSchedule('u', live.id);
        await manager.reconcile();
        expect(await manager.listTasks()).toEqual([]);
    });

    test('reconcile replaces edited records and isolates an invalid cron', async () => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { manager, storage } = fixture({
            now: () => new Date('2026-09-01T00:00:00Z'),
        });
        const edited = makeRecord();
        await storage.upsertSchedule('u', edited);
        await manager.reconcile();
        expect((await manager.listTasks())[0].name).toBe('sched-a');

        await new Promise(resolve => setTimeout(resolve, 2));
        edited.data.name = 'edited';
        edited.data.cron_expression = '30 3 * * *';
        await storage.upsertSchedule('u', edited);
        const broken = makeRecord({ cron_expression: 'not a cron' });
        await storage.upsertSchedule('u', broken);
        await manager.reconcile();

        expect(await manager.listTasks()).toEqual([
            expect.objectContaining({ id: edited.id, name: 'edited' }),
        ]);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Cannot register schedule'));
        errorLog.mockRestore();
    });

    test('only an enabled owner starts and lifecycle writes reach it', async () => {
        const { manager: disabled } = fixture({ enabled: false });
        await disabled.open();
        expect(disabled.running).toBe(false);

        const storage = new InMemoryStorage();
        const bus = new InMemoryMessageBus();
        const owner = new SchedulerManager(storage, bus, new AssignmentManager());
        const writer = new SchedulerManager(storage, bus, new AssignmentManager(), {
            enabled: false,
        });
        await owner.open();
        const record = makeRecord();
        await storage.upsertSchedule('u', record);
        await writer.notifyChanged(record.id);

        await waitFor(async () => (await owner.listTasks()).length === 1);
        expect((await owner.listTasks()).map(task => task.id)).toEqual([record.id]);
        await owner.close();
    });

    test('Python weekday zero means Monday, not Sunday', async () => {
        const { manager, storage } = fixture({
            now: () => new Date('2026-09-06T12:00:00Z'),
        });
        const monday = makeRecord({ cron_expression: '0 9 * * 0' });
        await storage.upsertSchedule('u', monday);

        await manager.reconcile();

        expect((await manager.listTasks())[0].next_run?.toISOString()).toBe(
            '2026-09-07T09:00:00.000Z'
        );
    });
});

describe('inbox producer-consumer protocol', () => {
    test('an active consumer suppresses redundant wakeups without losing payloads', async () => {
        const bus = new InMemoryMessageBus();
        await registerInboxConsumer(bus, 'session');

        await deliverToInbox(bus, {
            userId: 'user',
            sessionId: 'session',
            agentId: 'agent',
            payload: { value: 1 },
        });

        expect(await bus.dequeueWakeups()).toEqual([]);
        expect(await hasPendingInboxOrRelease(bus, 'session')).toBe(true);
        expect(await bus.inboxDrain('session')).toEqual([expect.anything()]);
    });

    test('an empty consumer releases its lease so the next producer wakes', async () => {
        const bus = new InMemoryMessageBus();
        await registerInboxConsumer(bus, 'session');
        expect(await hasPendingInboxOrRelease(bus, 'session')).toBe(false);
        expect(
            await bus.registryGet(
                MessageBusKeys.inboxConsumer('session'),
                MessageBusKeys.INBOX_CONSUMER_FIELD
            )
        ).toBeNull();
    });
});

describe('schedule tools', () => {
    test('listTools exposes the four Python schedule controls', async () => {
        const { manager } = fixture({ enabled: false });
        const tools = await manager.listTools('u', 'a', makeRecord().data.chat_model_config);

        expect(tools.map(tool => tool.name)).toEqual([
            'ScheduleCreate',
            'ScheduleView',
            'ScheduleDelete',
            'ScheduleList',
        ]);
        expect(
            tools.map(tool => ({
                name: tool.name,
                concurrent: tool.isConcurrencySafe,
                readOnly: tool.isReadOnly,
            }))
        ).toEqual([
            { name: 'ScheduleCreate', concurrent: false, readOnly: false },
            { name: 'ScheduleView', concurrent: true, readOnly: true },
            { name: 'ScheduleDelete', concurrent: false, readOnly: false },
            { name: 'ScheduleList', concurrent: true, readOnly: true },
        ]);
    });

    test('create validates before persistence and records injected session state', async () => {
        const { manager, storage } = fixture({ enabled: false });
        const [create] = await manager.listTools('u', 'a', makeRecord().data.chat_model_config);
        const state = new AgentState({ sessionId: 'source-session' });

        const response = await create.call({
            name: 'weekday report',
            description: 'summarize work',
            cron_expression: '0 9 * * 0-4',
            timezone: 'Asia/Shanghai',
            permission_mode: 'not-a-mode',
            _agent_state: state,
        });

        expect(response.state).toBe('success');
        const records = await storage.listSchedules('u');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            user_id: 'u',
            agent_id: 'a',
            data: {
                name: 'weekday report',
                description: 'summarize work',
                source: 'AGENT',
                source_session_id: 'source-session',
                permission_mode: 'dont_ask',
            },
        });

        await expect(create.call({ name: 'bad', cron_expression: 'not a cron' })).rejects.toThrow();
        expect(await storage.listSchedules('u')).toHaveLength(1);
    });

    test('view and list return persisted fields plus live next-run state', async () => {
        const { manager, storage } = fixture({
            now: () => new Date('2026-09-01T00:00:00Z'),
        });
        const record = makeRecord({ name: 'nightly', stateful: true });
        await storage.upsertSchedule('u', record);
        await manager.reconcile();
        const [, view, , list] = await manager.listTools('u', 'a', record.data.chat_model_config);

        const viewed = await view.call({ schedule_id: record.id });
        const listed = await list.call({});

        expect(viewed.content[0]).toMatchObject({
            text: expect.stringContaining(`Schedule ID:     ${record.id}`),
        });
        expect(viewed.content[0]).toMatchObject({ text: expect.stringContaining('nightly') });
        expect(listed.content[0]).toMatchObject({
            text: expect.stringContaining(`Found 1 scheduled task(s)`),
        });
        expect((await view.call({ schedule_id: 'missing' })).state).toBe('error');
    });

    test('delete removes the timer, spawned sessions, storage record, and bus state', async () => {
        const { manager, storage, bus } = fixture({
            now: () => new Date('2026-09-01T00:00:00Z'),
        });
        const record = makeRecord({ stateful: true });
        await storage.upsertSchedule('u', record);
        await manager.reconcile();
        await manager.buildTrigger(record)();
        const session = (await storage.listSessionsBySchedule('u', record.id))[0];
        await bus.sessionPublishEvent(session.id, { marker: true });
        const [, , remove] = await manager.listTools('u', 'a', record.data.chat_model_config);

        const response = await remove.call({ schedule_id: record.id });

        expect(response.state).toBe('success');
        expect(await manager.listTasks()).toEqual([]);
        expect(await storage.getSchedule('u', record.id)).toBeNull();
        expect(await storage.listSessionsBySchedule('u', record.id)).toEqual([]);
        expect(await bus.sessionReadEvents(session.id)).toEqual([]);
        expect(await bus.inboxDrain(session.id)).toEqual([]);
        expect((await remove.call({ schedule_id: record.id })).state).toBe('error');
    });
});
