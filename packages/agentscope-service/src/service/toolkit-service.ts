/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

import type { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';
import {
    TaskCreate,
    TaskGet,
    TaskList,
    TaskUpdate,
    ToolGroup,
    Toolkit,
    type ToolBase,
} from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import type { BackgroundTaskManager, SchedulerManager } from '../manager';
import type { MessageBus } from '../message-bus';
import type { AgentRecord, SessionRecord, StorageBase } from '../storage';
import {
    AgentCreate,
    AgentInvite,
    TeamCreate,
    TeamDelete,
    TeamSay,
    type SubAgentTemplate,
    type TeamToolOptions,
} from '../tool';
import type { WorkspaceManagerBase } from '../workspace-manager';
import type { ResourceAccessService } from './resource-access-service';

export type AgentToolFactory = (
    userId: string,
    agentId: string,
    sessionId: string
) => Promise<ToolBase[]>;

export interface GetToolkitOptions {
    storage: StorageBase;
    workspace: WorkspaceBase;
    workspaceManager: WorkspaceManagerBase;
    schedulerManager: SchedulerManager;
    backgroundTaskManager: BackgroundTaskManager;
    messageBus: MessageBus;
    middlewares: MiddlewareBase[];
    userId: string;
    agentRecord: AgentRecord;
    sessionRecord: SessionRecord;
    resourceAccessService: ResourceAccessService;
    extraFactory?: AgentToolFactory | null;
    subAgentTemplates?: Record<string, SubAgentTemplate> | null;
    teamRole?: 'leader' | 'worker' | null;
    channelTools?: ToolBase[] | null;
}

const SCHEDULE_GROUP_DESCRIPTION = `Tools for managing cron schedules. A cron schedule is a recurring task that fires at a specified time — at that point, a new session is created and an agent will be invoked to complete the given task autonomously.

## When to Use This Tool Group
- When you need to create a new cron schedule that triggers at a specific time or interval
- When you're asked to list, inspect, stop, or delete existing cron schedules`;

/** Assemble all app, workspace, middleware and channel tools for one chat turn. */
export async function getToolkit(options: GetToolkitOptions): Promise<Toolkit> {
    const tools: ToolBase[] = [
        ...(await options.workspace.listTools()),
        TaskCreate(),
        TaskList(),
        TaskGet(),
        TaskUpdate(),
        ...options.backgroundTaskManager.listTools(options.sessionRecord.id),
    ];
    const toolGroups: ToolGroup[] = [];
    if (options.sessionRecord.config.chat_model_config) {
        toolGroups.push(
            new ToolGroup({
                name: 'schedule_tools',
                description: SCHEDULE_GROUP_DESCRIPTION,
                tools: await options.schedulerManager.listTools(
                    options.userId,
                    options.agentRecord.id,
                    options.sessionRecord.config.chat_model_config
                ),
            })
        );
    }

    const teamOptions: TeamToolOptions = {
        storage: options.storage,
        messageBus: options.messageBus,
        workspaceManager: options.workspaceManager,
        userId: options.userId,
        sessionId: options.sessionRecord.id,
        agentId: options.agentRecord.id,
    };
    if (options.teamRole === 'worker') {
        tools.push(new TeamSay({ ...teamOptions, role: 'worker' }));
    } else {
        tools.push(
            new TeamCreate(teamOptions),
            new AgentCreate({
                ...teamOptions,
                subAgentTemplates: options.subAgentTemplates ?? {},
            }),
            new TeamSay({ ...teamOptions, role: 'leader' }),
            new TeamDelete(teamOptions)
        );
        const visibleAgents = await options.resourceAccessService.listResource(
            options.userId,
            'agent'
        );
        const invitablePool = visibleAgents.filter(
            view =>
                view.data.invite_config.invitable &&
                Boolean(view.data.invite_config.invite_description?.trim())
        );
        if (invitablePool.length > 0) {
            tools.push(new AgentInvite({ ...teamOptions, invitablePool }));
        }
    }

    if (options.extraFactory) {
        tools.push(
            ...(await options.extraFactory(
                options.userId,
                options.agentRecord.id,
                options.sessionRecord.id
            ))
        );
    }
    for (const middleware of options.middlewares) {
        tools.push(...(await middleware.listTools()));
    }
    if (options.channelTools) tools.push(...options.channelTools);

    return new Toolkit({
        tools,
        skillsOrLoaders: await options.workspace.listSkills({
            agentId: options.agentRecord.id,
        }),
        mcps: await options.workspace.listMcps({
            agentId: options.agentRecord.id,
            sessionId: options.sessionRecord.id,
        }),
        toolGroups,
    });
}

export const get_toolkit = getToolkit;
