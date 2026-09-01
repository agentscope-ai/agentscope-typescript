/* eslint-disable jsdoc/require-jsdoc */

import { PermissionBehavior, PermissionMode } from '@agentscope-ai/agentscope/permission';
import { AgentState } from '@agentscope-ai/agentscope/state';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { MessageBusKeys, InMemoryMessageBus } from '../src/message-bus';
import { AgentRecordSchema, InMemoryStorage, type SessionRecord } from '../src/storage';
import {
    AgentCreate,
    AgentInvite,
    TeamCreate,
    TeamDelete,
    TeamSay,
    displayName,
    mergeLeaderPermissions,
    resolveInviteTarget,
} from '../src/tool';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class TestWorkspaceManager extends WorkspaceManagerBase {
    async getWorkspace(): Promise<WorkspaceBase> {
        return {
            purgeSession: async () => undefined,
            purgeAgent: async () => undefined,
        } as unknown as WorkspaceBase;
    }
    async close(): Promise<void> {}
    async closeAll(): Promise<void> {}
}

const state = () => new AgentState().toJSON();

async function seedAgent(storage: InMemoryStorage, id: string, name: string, invitable = false) {
    const record = AgentRecordSchema.parse({
        id,
        user_id: 'u',
        data: {
            id: `data-${id}`,
            name,
            context_config: {},
            react_config: {},
            invite_config: {
                invitable,
                invite_description: invitable ? `${name} specialist` : null,
            },
        },
    });
    await storage.upsertAgent('u', record);
    return record;
}

async function seedSession(
    storage: InMemoryStorage,
    agentId: string,
    id: string,
    workspaceId = 'workspace'
): Promise<SessionRecord> {
    return storage.upsertSession({
        userId: 'u',
        agentId,
        sessionId: id,
        config: {
            workspace_id: workspaceId,
            name: id,
            cwd: null,
            chat_model_config: {
                type: 'test',
                credential_id: 'credential',
                model: 'model',
                parameters: {},
            },
            fallback_chat_model_config: null,
            tts_model_config: null,
            knowledge_config: null,
        },
        state: state(),
    });
}

function options(storage: InMemoryStorage, bus: InMemoryMessageBus) {
    return {
        storage,
        messageBus: bus,
        workspaceManager: new TestWorkspaceManager(),
        userId: 'u',
        sessionId: 'leader-session',
        agentId: 'leader-agent',
    };
}

async function createTeam(storage: InMemoryStorage, bus: InMemoryMessageBus): Promise<string> {
    const chunk = await new TeamCreate(options(storage, bus)).call({
        name: 'Builders',
        description: 'Build the requested system.',
    });
    expect(chunk.state).toBe('running');
    return (await storage.listTeams('u'))[0].id;
}

describe('team tools', () => {
    let storage: InMemoryStorage;
    let bus: InMemoryMessageBus;

    beforeEach(async () => {
        storage = new InMemoryStorage();
        bus = new InMemoryMessageBus();
        await seedAgent(storage, 'leader-agent', 'leader');
        await seedSession(storage, 'leader-agent', 'leader-session');
    });

    test('creates one team and rejects a second team for the same session', async () => {
        const tool = new TeamCreate(options(storage, bus));
        const first = await tool.call({ name: 'Builders', description: 'Build things.' });
        const second = await tool.call({ name: 'Other', description: 'Other work.' });
        expect(first.content[0]).toMatchObject({ type: 'text' });
        expect(second).toMatchObject({ state: 'error' });
        expect((await storage.listTeams('u')).map(team => team.data.name)).toEqual(['Builders']);
        expect((await storage.getSession('u', '', 'leader-session'))?.team_id).toBeTruthy();
    });

    test('creates a worker, inherits leader runtime policy and delivers its first task', async () => {
        await createTeam(storage, bus);
        const leaderState = new AgentState();
        leaderState.permissionContext.mode = PermissionMode.ACCEPT_EDITS;
        leaderState.permissionContext.allow_rules.Bash = [
            {
                tool_name: 'Bash',
                rule_content: 'pnpm test',
                behavior: PermissionBehavior.ALLOW,
                source: 'user',
            },
        ];
        const chunk = await new AgentCreate(options(storage, bus)).call({
            name: 'coder',
            description: 'Implements the feature.',
            prompt: 'Implement and test it.',
            _agent_state: leaderState,
        });
        expect(chunk.state).toBe('running');
        const team = (await storage.listTeams('u'))[0];
        expect(team.data.members).toHaveLength(1);
        expect(team.data.members[0]).toMatchObject({ role: 'created' });
        const member = team.data.members[0];
        const worker = await storage.getAgent('u', member.agent_id);
        const workerSession = await storage.getSession('u', member.agent_id, member.session_id);
        expect(worker).toMatchObject({ source: 'team', data: { name: 'coder' } });
        expect(workerSession?.config.workspace_id).toBe('workspace');
        expect(workerSession?.state.permission_context).toMatchObject({
            mode: 'accept_edits',
            allow_rules: { Bash: [{ rule_content: 'pnpm test' }] },
        });
        expect(
            (await bus.queueDrain(MessageBusKeys.inbox(member.session_id), 10))[0][1]
        ).toMatchObject({
            type: 'hint',
            source: JSON.stringify({ label: 'team_message', sublabel: 'leader' }),
        });
    });

    test('routes targeted and broadcast messages while rejecting self delivery', async () => {
        await createTeam(storage, bus);
        await new AgentCreate(options(storage, bus)).call({
            name: 'coder',
            description: 'Codes.',
            prompt: 'Start.',
        });
        const member = (await storage.listTeams('u'))[0].data.members[0];
        await bus.queueDrain(MessageBusKeys.inbox(member.session_id), 10);
        const say = new TeamSay({ ...options(storage, bus), role: 'leader' });
        expect((await say.call({ content: 'Report.', to: 'coder' })).state).toBe('running');
        const payload = (await bus.queueDrain(MessageBusKeys.inbox(member.session_id), 10))[0][1];
        expect(payload).toMatchObject({
            type: 'hint',
            hint: '<team-message from="leader">\nReport.\n</team-message>',
        });
        expect(await say.call({ content: 'No.', to: 'leader' })).toMatchObject({ state: 'error' });
    });

    test('invites an existing agent with an isolated session and preserves it on dissolution', async () => {
        await createTeam(storage, bus);
        const invited = await seedAgent(storage, 'invited-agent-1234', 'reviewer', true);
        await seedSession(storage, invited.id, 'primary-session', 'invited-workspace');
        const invite = new AgentInvite({
            ...options(storage, bus),
            invitablePool: [invited],
        });
        const target = displayName(invited.data.name, invited.id);
        expect(resolveInviteTarget(new Map([[invited.id, invited]]), target)).toBe(invited);
        expect(await invite.call({ target, prompt: 'Review the implementation.' })).toMatchObject({
            state: 'running',
        });
        const team = (await storage.listTeams('u'))[0];
        const member = team.data.members[0];
        expect(member).toMatchObject({ agent_id: invited.id, role: 'invited' });
        expect(
            (await storage.getSession('u', invited.id, member.session_id))?.config
        ).toMatchObject({
            workspace_id: 'invited-workspace',
        });
        expect(await new TeamDelete(options(storage, bus)).call()).toMatchObject({
            state: 'running',
        });
        expect(await storage.getAgent('u', invited.id)).not.toBeNull();
        expect(await storage.getSession('u', invited.id, member.session_id)).toBeNull();
        expect(await storage.getSession('u', invited.id, 'primary-session')).not.toBeNull();
    });

    test('merges template-first rules and working directories without mutating inputs', () => {
        const templateContext = new AgentState().permissionContext;
        templateContext.mode = PermissionMode.EXPLORE;
        templateContext.working_directories['/template'] = {
            path: '/template',
            source: 'template',
        };
        const leaderContext = new AgentState().permissionContext;
        leaderContext.mode = PermissionMode.BYPASS;
        leaderContext.working_directories['/leader'] = { path: '/leader', source: 'leader' };
        const merged = mergeLeaderPermissions(
            {
                type: 'custom',
                description: 'Custom.',
                systemPromptTemplate: '{member_name}',
                permissionContext: templateContext,
                extendLeaderPermissionRules: true,
                extendLeaderWorkingDirectories: true,
            },
            leaderContext
        );
        expect(merged).toMatchObject({
            mode: 'bypass',
            working_directories: {
                '/template': { source: 'template' },
                '/leader': { source: 'leader' },
            },
        });
        expect(templateContext.mode).toBe('explore');
    });
});
