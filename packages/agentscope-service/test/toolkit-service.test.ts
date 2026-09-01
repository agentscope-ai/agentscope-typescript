/* eslint-disable jsdoc/require-jsdoc */

import { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';
import { createPermissionDecision, PermissionBehavior } from '@agentscope-ai/agentscope/permission';
import { AgentState } from '@agentscope-ai/agentscope/state';
import { ToolBase, ToolChunk } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import { z } from 'zod';

import { DenyAllResourceAccessPolicy } from '../src/access';
import { BackgroundTaskManager, SchedulerManager } from '../src/manager';
import { InMemoryMessageBus } from '../src/message-bus';
import { getToolkit, ResourceAccessService } from '../src/service';
import { AgentRecordSchema, InMemoryStorage } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class StubTool extends ToolBase {
    readonly name: string;
    readonly description = 'Stub tool.';
    readonly inputSchema = z.object({});
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    constructor(name: string) {
        super();
        this.name = name;
    }
    checkPermissions() {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'Allowed.',
        });
    }
    async call(): Promise<ToolChunk> {
        return new ToolChunk({ content: [] });
    }
}

class StubMiddleware extends MiddlewareBase {
    override async listTools(): Promise<ToolBase[]> {
        return [new StubTool('middleware')];
    }
}

class StubWorkspaceManager extends WorkspaceManagerBase {
    async getWorkspace(): Promise<WorkspaceBase> {
        return {} as WorkspaceBase;
    }
    async close(): Promise<void> {}
    async closeAll(): Promise<void> {}
}

describe('getToolkit', () => {
    test.each([
        [true, null, ['TeamCreate', 'AgentCreate', 'TeamSay', 'TeamDelete']],
        [true, 'worker', ['TeamSay']],
        [false, null, ['TeamCreate', 'AgentCreate', 'TeamSay', 'TeamDelete']],
    ] as const)(
        'assembles every source with model=%s and role=%s',
        async (withModel, role, team) => {
            const storage = new InMemoryStorage();
            const bus = new InMemoryMessageBus();
            const workspaceManager = new StubWorkspaceManager();
            const agent = AgentRecordSchema.parse({
                id: 'agent',
                user_id: 'u',
                data: { name: 'A', context_config: {}, react_config: {} },
            });
            await storage.upsertAgent('u', agent);
            const session = await storage.upsertSession({
                userId: 'u',
                agentId: agent.id,
                sessionId: 'session',
                config: {
                    workspace_id: 'workspace',
                    name: 'session',
                    cwd: null,
                    chat_model_config: withModel
                        ? {
                              type: 'test',
                              credential_id: 'credential',
                              model: 'model',
                              parameters: {},
                          }
                        : null,
                    fallback_chat_model_config: null,
                    tts_model_config: null,
                    knowledge_config: null,
                },
                state: new AgentState().toJSON(),
            });
            const workspace = {
                listTools: async () => [new StubTool('workspace')],
                listSkills: async () => [],
                listMcps: async () => [],
            } as unknown as WorkspaceBase;
            const toolkit = await getToolkit({
                storage,
                workspace,
                workspaceManager,
                schedulerManager: new SchedulerManager(storage, bus, workspaceManager),
                backgroundTaskManager: new BackgroundTaskManager(bus),
                messageBus: bus,
                middlewares: [new StubMiddleware()],
                userId: 'u',
                agentRecord: agent,
                sessionRecord: session,
                resourceAccessService: new ResourceAccessService(
                    storage,
                    new DenyAllResourceAccessPolicy()
                ),
                extraFactory: async () => [new StubTool('extra')],
                teamRole: role,
                channelTools: [new StubTool('channel')],
            });
            const names = toolkit.toolGroups.flatMap(group => group.tools.map(tool => tool.name));
            expect(names).toEqual(
                expect.arrayContaining([
                    'workspace',
                    'TaskCreate',
                    'TaskList',
                    'TaskGet',
                    'TaskUpdate',
                    'ToolStop',
                    ...team,
                    'extra',
                    'middleware',
                    'channel',
                ])
            );
            for (const name of [
                'ScheduleCreate',
                'ScheduleView',
                'ScheduleDelete',
                'ScheduleList',
            ]) {
                expect(names.includes(name)).toBe(withModel);
            }
            if (role === 'worker') {
                for (const name of ['TeamCreate', 'AgentCreate', 'TeamDelete', 'AgentInvite']) {
                    expect(names).not.toContain(name);
                }
            }
        }
    );
});
