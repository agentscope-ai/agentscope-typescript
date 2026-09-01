/* eslint-disable jsdoc/require-jsdoc */

import { HintBlock, TextBlock } from '@agentscope-ai/agentscope/message';
import {
    type PermissionContext,
    PermissionBehavior,
    createPermissionContext,
    createPermissionDecision,
} from '@agentscope-ai/agentscope/permission';
import { AgentState, TaskContext, parseAgentState } from '@agentscope-ai/agentscope/state';
import { ToolBase, ToolChunk } from '@agentscope-ai/agentscope/tool';
import type { ToolInputSchema } from '@agentscope-ai/agentscope/type';
import { z } from 'zod';

import { deliverToInbox } from '../bus-ops';
import type { MessageBus } from '../message-bus';
import { SessionService } from '../service/session-service';
import {
    AgentRecordSchema,
    TeamRecordSchema,
    type AgentRecord,
    type SessionRecord,
    type StorageBase,
    type TeamMember,
    type TeamRecord,
} from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';

export const TEAM_MEMBER_HANDLE_LENGTH = 8;

export interface SubAgentTemplate {
    type: string;
    description: string;
    systemPromptTemplate: string;
    contextConfig?: Record<string, unknown>;
    reactConfig?: Record<string, unknown>;
    permissionContext?: PermissionContext;
    tasksContext?: TaskContext;
    overrideLeaderMode?: boolean;
    extendLeaderPermissionRules?: boolean;
    extendLeaderWorkingDirectories?: boolean;
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
    "You are {member_name}, a member of team '{team_name}' led by {leader_name}.\n\n" +
    'Team purpose: {team_description}\n\n' +
    'Your role: {member_description}\n\n' +
    'You communicate with the team leader and other members through the TeamSay tool. ' +
    'Speak on the team only when you have something external to share — your private ' +
    'reasoning stays private.';

export const DEFAULT_SUB_AGENT_TEMPLATE: SubAgentTemplate = {
    type: 'default',
    description: 'Default worker agent with standard configuration.',
    systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
    permissionContext: createPermissionContext(),
    tasksContext: new TaskContext(),
    overrideLeaderMode: false,
    extendLeaderPermissionRules: true,
    extendLeaderWorkingDirectories: true,
};

export interface TeamToolOptions {
    storage: StorageBase;
    messageBus: MessageBus;
    workspaceManager: WorkspaceManagerBase;
    userId: string;
    sessionId: string;
    agentId: string;
}

abstract class TeamToolBase extends ToolBase {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: z.ZodObject | ToolInputSchema;
    readonly isConcurrencySafe: boolean = false;
    readonly isReadOnly = true;

    protected readonly storage: StorageBase;
    protected readonly messageBus: MessageBus;
    protected readonly workspaceManager: WorkspaceManagerBase;
    protected readonly userId: string;
    protected readonly sessionId: string;
    protected readonly agentId: string;

    constructor(options: TeamToolOptions) {
        super();
        this.storage = options.storage;
        this.messageBus = options.messageBus;
        this.workspaceManager = options.workspaceManager;
        this.userId = options.userId;
        this.sessionId = options.sessionId;
        this.agentId = options.agentId;
    }

    checkPermissions() {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `${this.name} is always allowed when attached to the agent.`,
        });
    }

    protected async requireTeam(): Promise<TeamRecord> {
        const session = await this.storage.getSession(this.userId, this.agentId, this.sessionId);
        if (!session?.team_id) {
            throw new Error('this session is not in any team — call TeamCreate first.');
        }
        const team = await this.storage.getTeam(this.userId, session.team_id);
        if (!team) throw new Error(`team ${session.team_id} no longer exists.`);
        return team;
    }

    protected async requireLeaderTeam(action: string): Promise<TeamRecord> {
        const team = await this.requireTeam();
        if (team.session_id !== this.sessionId) {
            throw new Error(`only the team leader can ${action}; this session is a worker.`);
        }
        return team;
    }
}

function result(text: string, state: 'running' | 'error' = 'running'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}

async function ensureTeamMembers(
    storage: StorageBase,
    userId: string,
    team: TeamRecord
): Promise<TeamMember[]> {
    if (team.data.members.length > 0) return team.data.members;
    if (team.data.member_ids.length === 0) return [];
    const members: TeamMember[] = [];
    for (const agentId of team.data.member_ids) {
        const session = (await storage.listSessions(userId, agentId))[0];
        if (session) {
            members.push({
                owner_id: userId,
                agent_id: agentId,
                session_id: session.id,
                role: 'created',
            });
        }
    }
    team.data.members = members;
    team.data.member_ids = members.map(member => member.agent_id);
    await storage.upsertTeam(userId, team);
    return members;
}

async function resolveLeader(
    storage: StorageBase,
    userId: string,
    team: TeamRecord
): Promise<{ name: string; session: SessionRecord; agent: AgentRecord } | null> {
    const session = await storage.getSession(userId, '', team.session_id);
    if (!session) return null;
    const agentId = team.leader_agent_id ?? session.agent_id;
    const agent = await storage.getAgent(userId, agentId);
    return agent ? { name: agent.data.name, session, agent } : null;
}

const teamCreateSchema = z.object({
    name: z.string().describe('Display name of the team. Used by the user to identify the team.'),
    description: z
        .string()
        .describe(
            "What the team is for — its overall goal or shared context. This becomes the team's " +
                "charter and is wired into every member's system prompt."
        ),
});

export class TeamCreate extends TeamToolBase {
    readonly name = 'TeamCreate';
    readonly description = `Create a new team led by your current session and return its team id.

## When to Use This Tool
Use this tool when the task you've been given is best decomposed into parallel sub-tasks executed by multiple specialised agents (members) under your coordination. After creating the team, use \`AgentCreate\` to spawn each member with its own role, prompt, and permission mode. NOTE: the \`prompt\` you pass to \`AgentCreate\` is delivered to that member automatically, so do **NOT** call \`TeamSay\` right after \`AgentCreate\` — just wait for the members to report back.

## When NOT to Use This Tool
- The task is small enough to handle yourself.
- You already lead a team in this session — a session can only lead one team at a time.`;
    readonly inputSchema = teamCreateSchema;

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        try {
            const parsed = this.inputSchema.parse(input);
            const session = await this.storage.getSession(
                this.userId,
                this.agentId,
                this.sessionId
            );
            if (!session)
                return result(`TeamCreate: session ${this.sessionId} not found.`, 'error');
            if (session.team_id) {
                return result(
                    `TeamCreate: this session is already part of team ${session.team_id}. A ` +
                        'session can only lead one team at a time — dissolve the current one ' +
                        'with TeamDelete first.',
                    'error'
                );
            }
            const team = TeamRecordSchema.parse({
                user_id: this.userId,
                session_id: this.sessionId,
                leader_agent_id: this.agentId,
                data: { name: parsed.name, description: parsed.description },
            });
            await this.storage.upsertTeam(this.userId, team);
            await this.storage.setSessionTeamId(this.userId, this.sessionId, team.id);
            return result(
                `Team ${team.id} (${team.data.name}) created. You are the leader. Use ` +
                    'AgentCreate to add members, then TeamSay to coordinate them.'
            );
        } catch (error) {
            return result(`TeamCreate failed: ${errorMessage(error)}`, 'error');
        }
    }
}

export class TeamDelete extends TeamToolBase {
    readonly name = 'TeamDelete';
    readonly description = `Dissolve the team you currently lead.

## When to Use This Tool
- The team has finished its work and you want to clean up.
- The team is unrecoverably stuck and you want to start over.
- You have collected the deliverables you need from each member.

## When NOT to Use This Tool
- Members are still producing useful output and you may want their follow-up; dissolving deletes them and they cannot be revived.
- You want to remove only one specific member — there is no "remove single member" tool in v1, only whole-team dissolution.

## Effects
- Every member agent + its session is deleted.
- The team record is deleted.
- Your own session continues to exist but is no longer associated with any team.

This is irreversible.`;
    readonly inputSchema = z.object({});

    async call(): Promise<ToolChunk> {
        try {
            const team = await this.requireLeaderTeam('dissolve the team');
            await new SessionService(
                this.storage,
                this.messageBus,
                this.workspaceManager
            ).deleteTeam(this.userId, team.id);
            return result(
                `Team ${team.id} dissolved. All members deleted; your session is no longer ` +
                    'leading any team.'
            );
        } catch (error) {
            return result(`TeamDelete failed: ${errorMessage(error)}`, 'error');
        }
    }
}

const teamSaySchema = z.object({
    content: z
        .string()
        .describe(
            'The message text. Plain natural-language; the recipient sees it as a user message.'
        ),
    to: z
        .string()
        .nullable()
        .optional()
        .describe(
            'Recipient member name. Pass null to broadcast to every other member of the team.'
        ),
});

export class TeamSay extends TeamToolBase {
    readonly name = 'TeamSay';
    readonly description: string;
    readonly inputSchema = teamSaySchema;
    override readonly isConcurrencySafe = true;

    constructor(options: TeamToolOptions & { role?: 'leader' | 'worker' }) {
        super(options);
        this.description =
            options.role === 'worker'
                ? `Send a message to the team leader or broadcast to all team members.

## When to Use This Tool
- **IMPORTANT**: When you finish your assigned task, you MUST call this tool to report your results back to the leader. The leader is waiting for your report — do not end your turn without sending it.
- Share intermediate findings or ask the leader for clarification.
- Broadcast information that other members might need.

## When NOT to Use This Tool
- You want to talk to yourself — use your own reasoning.
- The message is a transient internal thought with no value to others.`
                : `Send a message to a specific team member or broadcast to all members.

## When to Use This Tool
- Pass **new** requirements or context from the user to a specific member.
- Broadcast an update or coordination message to all members.
- Ask a member a follow-up question when you need clarification.

## When NOT to Use This Tool
- DO NOT repeatedly call this to check on a member's progress — members will automatically notify you via \`TeamSay\` when they finish their task. Wait for their message instead of polling.
- DO NOT call this right after creating a member by \`AgentCreate\`; the member receives its initial task from the \`prompt\` and reports back when done.
- The session is not in a team yet (call \`TeamCreate\` first).
- You want to talk to yourself — use your own reasoning.

## Important
- Each member starts working immediately when created. When a member finishes, it will call \`TeamSay\` to report results back to you.
- **DO NOT** reply to a member's report unless you have further questions or requirements. \`TeamSay\` is for coordination, not chit-chat.`;
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        try {
            const { content, to = null } = this.inputSchema.parse(input);
            const team = await this.requireTeam();
            const leader = await resolveLeader(this.storage, this.userId, team);
            if (!leader) {
                return result(`TeamSay: leader records missing for team ${team.id}.`, 'error');
            }
            const directory = new Map<string, [string, string]>([
                [leader.name, [leader.session.id, leader.agent.id]],
            ]);
            for (const member of await ensureTeamMembers(this.storage, this.userId, team)) {
                const agent = await this.storage.getAgent(member.owner_id, member.agent_id);
                if (!agent) continue;
                const display =
                    member.role === 'invited'
                        ? displayName(agent.data.name, member.agent_id)
                        : agent.data.name;
                directory.set(display, [member.session_id, member.agent_id]);
            }
            if (![...directory.values()].some(([sessionId]) => sessionId === this.sessionId)) {
                return result(
                    `TeamSay: this session (${this.sessionId}) is not part of team ${team.id}.`,
                    'error'
                );
            }
            let recipients: Array<[string, string]>;
            if (to == null) {
                recipients = [...directory.values()].filter(
                    ([sessionId]) => sessionId !== this.sessionId
                );
            } else {
                const target = directory.get(to);
                if (!target) {
                    return result(
                        `TeamSay: no team member is named '${to}'. Known members: ` +
                            `${JSON.stringify([...directory.keys()].sort())}.`,
                        'error'
                    );
                }
                if (target[0] === this.sessionId) {
                    return result(
                        'TeamSay: cannot send a message to yourself; talk to yourself in your ' +
                            'own reasoning instead.',
                        'error'
                    );
                }
                recipients = [target];
            }
            const sender = await this.storage.getAgent(this.userId, this.agentId);
            const senderName = sender?.data.name ?? this.agentId;
            const hint = HintBlock({
                hint: `<team-message from="${senderName}">\n${content}\n</team-message>`,
                source: JSON.stringify({ label: 'team', sublabel: senderName }),
            });
            for (const [sessionId, agentId] of recipients) {
                await deliverToInbox(this.messageBus, {
                    userId: this.userId,
                    sessionId,
                    agentId,
                    payload: { ...hint },
                });
            }
            return result(
                `Delivered to ${recipients.length} recipient(s) (` +
                    `${to == null ? 'broadcast' : `member '${to}'`}).`
            );
        } catch (error) {
            return result(`TeamSay failed: ${errorMessage(error)}`, 'error');
        }
    }
}

function clonePermissionContext(context: PermissionContext): PermissionContext {
    return structuredClone(context);
}

export function mergeLeaderPermissions(
    template: SubAgentTemplate,
    leader: PermissionContext
): PermissionContext {
    const merged = clonePermissionContext(template.permissionContext ?? createPermissionContext());
    if (!(template.overrideLeaderMode ?? false)) merged.mode = leader.mode;
    if (template.extendLeaderWorkingDirectories ?? false) {
        for (const [path, directory] of Object.entries(leader.working_directories)) {
            if (!(path in merged.working_directories)) {
                merged.working_directories[path] = structuredClone(directory);
            }
        }
    }
    if (template.extendLeaderPermissionRules ?? false) {
        for (const key of ['allow_rules', 'deny_rules', 'ask_rules'] as const) {
            for (const [toolName, rules] of Object.entries(leader[key])) {
                (merged[key][toolName] ??= []).push(...structuredClone(rules));
            }
        }
    }
    return merged;
}

const agentCreatePublicSchema = z.object({
    name: z
        .string()
        .describe(
            'Short unique identifier for the new member. Other members address it via TeamSay.'
        ),
    description: z
        .string()
        .describe("One-sentence summary of the member's role, used in its system prompt."),
    prompt: z
        .string()
        .describe(
            'The concrete, self-contained first task. The member begins executing immediately.'
        ),
});

const agentCreateCallSchema = agentCreatePublicSchema.extend({
    subagent_type: z.string().optional(),
    _agent_state: z.instanceof(AgentState).optional(),
});

export class AgentCreate extends TeamToolBase {
    readonly name = 'AgentCreate';
    readonly description = `Add a new member to the team you lead.

## When to Use This Tool
After \`TeamCreate\`, call this for each member you want on the team. Each call creates a worker dedicated to this team and delivers \`prompt\` as its first user message — the worker starts executing it immediately. Do not use \`TeamSay\` right after creating one agent.

## When NOT to Use This Tool
- You're not currently leading a team. Call \`TeamCreate\` first.
- The new member would duplicate an existing member's role; reuse the existing member via \`TeamSay\` instead.

## Effects
- Use the chosen \`name\` as \`to=<name>\` in \`TeamSay\`. Names must be unique within the team, including the leader's name.
- Members spawned this way live only as long as the team and are deleted by \`TeamDelete\`.

## Important
You are responsible for organising the team, assigning tasks, collecting every member's report, and producing the final answer. Do not encourage members to communicate with each other and avoid integrator-style members.`;
    readonly inputSchema: z.ZodObject | ToolInputSchema;
    override isStateInjected = true;
    private readonly templates: Map<string, SubAgentTemplate>;

    constructor(
        options: TeamToolOptions & {
            subAgentTemplates?: Record<string, SubAgentTemplate>;
        }
    ) {
        super(options);
        this.templates = new Map(Object.entries(options.subAgentTemplates ?? {}));
        if (!this.templates.has('default')) {
            this.templates.set('default', DEFAULT_SUB_AGENT_TEMPLATE);
        }
        if (this.templates.size === 1) {
            this.inputSchema = agentCreatePublicSchema;
        } else {
            const schema = z.toJSONSchema(
                agentCreatePublicSchema.extend({ subagent_type: z.string().optional() })
            );
            const property = (schema.properties as Record<string, Record<string, unknown>>)
                .subagent_type;
            property.enum = [...this.templates.keys()];
            property.description =
                'The registered sub-agent template type to use. Available types:\n\n' +
                [...this.templates.values()]
                    .map(template => `- '${template.type}' — ${template.description}`)
                    .join('\n');
            this.inputSchema = schema as ToolInputSchema;
        }
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        try {
            const parsed = agentCreateCallSchema.parse(input);
            const team = await this.requireLeaderTeam('add members');
            const leaderSession = await this.storage.getSession(this.userId, '', team.session_id);
            if (!leaderSession) {
                return result(
                    `AgentCreate: leader session ${team.session_id} for team ${team.id} is ` +
                        'missing — team is in an inconsistent state.',
                    'error'
                );
            }
            const template = this.templates.get(parsed.subagent_type ?? 'default');
            if (!template) {
                return result(
                    `AgentCreate: unknown subagent_type '${parsed.subagent_type}'; expected one ` +
                        `of ${JSON.stringify([...this.templates.keys()])}.`,
                    'error'
                );
            }
            if (parsed.name.includes('@')) {
                return result(
                    `AgentCreate: member name '${parsed.name}' cannot contain the character '@'.`,
                    'error'
                );
            }
            const leader = await resolveLeader(this.storage, this.userId, team);
            const leaderName = leader?.name ?? leaderSession.agent_id;
            const names = new Set([leaderName]);
            const members = await ensureTeamMembers(this.storage, this.userId, team);
            for (const member of members) {
                const agent = await this.storage.getAgent(member.owner_id, member.agent_id);
                if (agent) names.add(agent.data.name);
            }
            if (names.has(parsed.name)) {
                return result(
                    `AgentCreate: a team member named '${parsed.name}' already exists. Member ` +
                        "names must be unique within the team (including the leader's name); " +
                        'pick another.',
                    'error'
                );
            }
            const systemPrompt = renderSystemPrompt(template.systemPromptTemplate, {
                team_name: team.data.name,
                team_description: team.data.description,
                member_name: parsed.name,
                member_description: parsed.description,
                leader_name: leaderName,
            });
            const workerAgent = AgentRecordSchema.parse({
                user_id: this.userId,
                source: 'team',
                data: {
                    name: parsed.name,
                    system_prompt: systemPrompt,
                    context_config: structuredClone(template.contextConfig ?? {}),
                    react_config: structuredClone(template.reactConfig ?? {}),
                },
            });
            await this.storage.upsertAgent(this.userId, workerAgent);
            const leaderState = parsed._agent_state ?? parseAgentState(leaderSession.state);
            const workerState = new AgentState({
                permissionContext: mergeLeaderPermissions(template, leaderState.permissionContext),
                tasksContext: new TaskContext({
                    tasks: structuredClone(template.tasksContext?.tasks ?? []),
                }),
            });
            const workerSession = await this.storage.upsertSession({
                userId: this.userId,
                agentId: workerAgent.id,
                config: {
                    workspace_id: leaderSession.config.workspace_id,
                    name: `team:${team.id}/${parsed.name}`,
                    chat_model_config: leaderSession.config.chat_model_config,
                    fallback_chat_model_config: leaderSession.config.fallback_chat_model_config,
                    tts_model_config: null,
                    knowledge_config: null,
                    cwd: null,
                },
                state: workerState.toJSON(),
            });
            await this.storage.setSessionTeamId(this.userId, workerSession.id, team.id);
            team.data.member_ids = [...team.data.member_ids, workerAgent.id];
            team.data.members = [
                ...members,
                {
                    owner_id: this.userId,
                    agent_id: workerAgent.id,
                    session_id: workerSession.id,
                    role: 'created',
                },
            ];
            await this.storage.upsertTeam(this.userId, team);
            await this.deliverInitialTask(
                workerSession.id,
                workerAgent.id,
                leaderName,
                parsed.prompt
            );
            return result(`Member '${parsed.name}' added to team '${team.data.name}'.`);
        } catch (error) {
            return result(`AgentCreate failed: ${errorMessage(error)}`, 'error');
        }
    }

    private async deliverInitialTask(
        sessionId: string,
        agentId: string,
        leaderName: string,
        prompt: string
    ): Promise<void> {
        await deliverToInbox(this.messageBus, {
            userId: this.userId,
            sessionId,
            agentId,
            payload: {
                ...HintBlock({
                    hint: `<team-message from="${leaderName}">\n${prompt}\n</team-message>`,
                    source: JSON.stringify({ label: 'team_message', sublabel: leaderName }),
                }),
            },
        });
    }
}

const agentInviteSchema = z.object({
    target: z
        .string()
        .describe('The invitable agent formatted as "<name>@<handle>"; choose from the enum.'),
    prompt: z
        .string()
        .describe('The concrete, self-contained first task. The invited agent starts immediately.'),
});

export class AgentInvite extends TeamToolBase {
    readonly name = 'AgentInvite';
    readonly description: string;
    readonly inputSchema: ToolInputSchema;
    private readonly poolById: Map<string, AgentRecord>;

    constructor(options: TeamToolOptions & { invitablePool: AgentRecord[] }) {
        super(options);
        this.poolById = new Map(options.invitablePool.map(agent => [agent.id, agent]));
        const targets = options.invitablePool.map(agent => displayName(agent.data.name, agent.id));
        this.description =
            `Borrow an existing user-owned agent into the team you lead.

## Difference From \`AgentCreate\`
- \`AgentCreate\` creates a new agent sharing your workspace. \`AgentInvite\` borrows an existing agent with its own workspace, so paths cannot be assumed to resolve on both sides.
- The invited agent already has a name; you cannot rename it.

## When to Use This Tool
- A user-owned agent already exists whose stated purpose matches the role you need.
- You want to delegate to an existing specialist.

## When NOT to Use This Tool
- No suitable invitable agent exists — use \`AgentCreate\` instead.
- You need to customise the member's system prompt or role for this team.
- You are not currently leading a team.

## Important
- Do not assume the invited agent shares your filesystem. Prefer self-contained messages.
- \`TeamSay\` is the primary communication channel.
- \`TeamDelete\` removes only the team-scoped session, not the invited agent.

## Available invitable agents
` +
            targets
                .map(target => {
                    const agent = options.invitablePool.find(
                        candidate => displayName(candidate.data.name, candidate.id) === target
                    )!;
                    return `- '${target}' — ${agent.data.invite_config.invite_description}`;
                })
                .join('\n');
        const schema = z.toJSONSchema(agentInviteSchema);
        (schema.properties as Record<string, Record<string, unknown>>).target.enum = targets;
        this.inputSchema = schema as ToolInputSchema;
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        try {
            const parsed = agentInviteSchema.parse(input);
            const resolved = resolveInviteTarget(this.poolById, parsed.target);
            if (typeof resolved === 'string') return result(resolved, 'error');
            let invited = resolved;
            const team = await this.requireLeaderTeam('invite members');
            const fresh = await this.storage.getAgent(this.userId, invited.id);
            if (
                !fresh?.data.invite_config.invitable ||
                !fresh.data.invite_config.invite_description?.trim()
            ) {
                return result(
                    `AgentInvite: agent '${invited.data.name}' is no longer invitable.`,
                    'error'
                );
            }
            invited = fresh;
            const members = await ensureTeamMembers(this.storage, this.userId, team);
            if (members.some(member => member.agent_id === invited.id)) {
                return result(
                    `AgentInvite: agent '${invited.data.name}' is already a member of team ` +
                        `'${team.data.name}'.`,
                    'error'
                );
            }
            const leaderSession = await this.storage.getSession(this.userId, '', team.session_id);
            if (!leaderSession) {
                return result(
                    `AgentInvite: leader session ${team.session_id} for team ${team.id} is ` +
                        'missing — team is in an inconsistent state.',
                    'error'
                );
            }
            const leader = await resolveLeader(this.storage, this.userId, team);
            const leaderName = leader?.name ?? leaderSession.agent_id;
            const sessions = await this.storage.listSessions(this.userId, invited.id);
            const primary = sessions[0];
            const workspaceId =
                primary?.config.workspace_id ??
                (await this.workspaceManager.assignWorkspaceId({
                    userId: this.userId,
                    agentId: invited.id,
                    sessionId: crypto.randomUUID().replaceAll('-', ''),
                }));
            const borrowed = await this.storage.upsertSession({
                userId: this.userId,
                agentId: invited.id,
                config: {
                    workspace_id: workspaceId,
                    name: `team:${team.id}/invited:${displayHandle(invited.id)}`,
                    chat_model_config:
                        primary?.config.chat_model_config ?? leaderSession.config.chat_model_config,
                    fallback_chat_model_config:
                        primary?.config.fallback_chat_model_config ??
                        leaderSession.config.fallback_chat_model_config,
                    tts_model_config: null,
                    knowledge_config: null,
                    cwd: null,
                },
                state: new AgentState().toJSON(),
            });
            await this.storage.setSessionTeamId(this.userId, borrowed.id, team.id);
            team.data.members = [
                ...members,
                {
                    owner_id: this.userId,
                    agent_id: invited.id,
                    session_id: borrowed.id,
                    role: 'invited',
                },
            ];
            await this.storage.upsertTeam(this.userId, team);
            const reminder =
                `<system-reminder>You're now invited into a team named '${team.data.name}' ` +
                `led by an agent named '${leaderName}' in this session. All team members can ` +
                '**ONLY** communicate through the `TeamSay` tool. Once you finished the given ' +
                'tasks, or want to communicate with the leader or team members, use ' +
                '`TeamSay`.</system-reminder>\n';
            await deliverToInbox(this.messageBus, {
                userId: this.userId,
                sessionId: borrowed.id,
                agentId: invited.id,
                payload: {
                    ...HintBlock({
                        hint:
                            reminder +
                            `<team-message from="${leaderName}">\n${parsed.prompt}\n</team-message>`,
                        source: JSON.stringify({ label: 'team_message', sublabel: leaderName }),
                    }),
                },
            });
            return result(
                `Invited '${displayName(invited.data.name, invited.id)}' into team ` +
                    `'${team.data.name}'.`
            );
        } catch (error) {
            return result(`AgentInvite failed: ${errorMessage(error)}`, 'error');
        }
    }
}

export function displayHandle(agentId: string): string {
    return agentId.slice(0, TEAM_MEMBER_HANDLE_LENGTH);
}

export function displayName(agentName: string, agentId: string): string {
    return `${agentName}@${displayHandle(agentId)}`;
}

export function resolveInviteTarget(
    poolById: Map<string, AgentRecord>,
    target: string
): AgentRecord | string {
    if (!target.includes('@')) {
        return `AgentInvite: malformed target '${target}' — expected "<name>@<handle>", got no \`\`@\`\` separator.`;
    }
    const separator = target.lastIndexOf('@');
    const name = target.slice(0, separator).trim();
    const handle = target.slice(separator + 1).trim();
    if (!handle) {
        return `AgentInvite: malformed target '${target}' — empty handle after \`\`@\`\`.`;
    }
    const handleMatches = [...poolById.values()].filter(
        record => displayHandle(record.id) === handle
    );
    const namedMatches = handleMatches.filter(record => record.data.name === name);
    if (namedMatches.length === 1) return namedMatches[0];
    if (namedMatches.length > 1) {
        return (
            `AgentInvite: target '${target}' is ambiguous — multiple invitable agents share ` +
            `this display string: ${JSON.stringify(namedMatches.map(item => item.id).sort())}.`
        );
    }
    if (handleMatches.length === 1) return handleMatches[0];
    if (handleMatches.length > 1) {
        return (
            `AgentInvite: handle '${handle}' matches multiple invitable agents: ` +
            `${JSON.stringify(
                handleMatches.map(item => displayName(item.data.name, item.id)).sort()
            )}. Retry with the exact display string.`
        );
    }
    return (
        `AgentInvite: no invitable agent matches target '${target}'. Available: ` +
        `${JSON.stringify(
            [...poolById.values()].map(item => displayName(item.data.name, item.id)).sort()
        )}.`
    );
}

function renderSystemPrompt(template: string, values: Record<string, string>): string {
    const open = '\u0000agentscope-open\u0000';
    const close = '\u0000agentscope-close\u0000';
    const escaped = template.replaceAll('{{', open).replaceAll('}}', close);
    const rendered = escaped.replace(
        /\{([A-Za-z_][A-Za-z0-9_]*)(?:!([rs]))?\}/g,
        (_original, key: string, conversion: string | undefined) => {
            if (!(key in values)) throw new Error(`Unknown system-prompt field '${key}'.`);
            const value = values[key];
            return conversion === 'r' ? `'${value}'` : value;
        }
    );
    if (/[{}]/.test(rendered)) throw new Error('Invalid braces in system-prompt template.');
    return rendered.replaceAll(open, '{').replaceAll(close, '}');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
