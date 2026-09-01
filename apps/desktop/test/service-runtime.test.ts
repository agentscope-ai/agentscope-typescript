import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { UserMsg } from '@agentscope-ai/agentscope/message';
import { InMemoryMessageBus } from '@agentscope-ai/agentscope-service/message-bus';
import { InMemoryStorage } from '@agentscope-ai/agentscope-service/storage';
import { LocalWorkspaceManager } from '@agentscope-ai/agentscope-service/workspace-manager';

import { DesktopServiceRuntime } from '../src/main/runtime';
import type { Config } from '../src/shared/types/config';

const CONFIG: Config = {
    username: 'User',
    language: 'en',
    models: {
        local: { provider: 'ollama', modelName: 'qwen3.5:9b', apiKey: '' },
    },
    agents: {
        friday: {
            name: 'friday',
            type: 'builtin',
            modelKey: 'local',
            instruction: 'Be concise.',
            maxIters: 12,
            compressionTrigger: 10_000,
            compressionKeepRecent: 5,
        },
    },
    chat: {},
    editor: { autoSave: true, autoSaveIntervalMs: 3_000 },
    skills: { dirs: [] },
    telemetry: { enabled: false },
};

describe('DesktopServiceRuntime', () => {
    let directory: string;
    let runtime: DesktopServiceRuntime;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'agentscope-desktop-runtime-'));
        runtime = new DesktopServiceRuntime({
            dataDirectory: directory,
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({
                baseDirectory: path.join(directory, 'workspace'),
            }),
        });
        await runtime.open();
        await runtime.syncConfig(CONFIG);
    });

    afterEach(async () => {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    });

    test('stores Desktop credentials, agents, sessions and messages in shared services', async () => {
        expect(await runtime.app.storage.listCredentials(runtime.userId)).toEqual([
            expect.objectContaining({
                user_id: 'desktop',
                data: expect.objectContaining({
                    name: 'local',
                    type: 'ollama_credential',
                }),
            }),
        ]);
        expect(await runtime.app.storage.listAgents(runtime.userId)).toEqual([
            expect.objectContaining({
                user_id: 'desktop',
                source: 'user',
                data: expect.objectContaining({
                    id: 'friday',
                    name: 'friday',
                    system_prompt: "You're a helpful assistant named friday.\n\nBe concise.",
                    react_config: expect.objectContaining({ max_iters: 12 }),
                }),
            }),
        ]);

        const created = await runtime.createSession('friday', 'First');
        expect(created).toEqual({
            id: expect.any(String),
            agentKey: 'friday',
            name: 'First',
            pinned: false,
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number),
        });
        const message = UserMsg({ name: 'user', content: 'hello' });
        await runtime.addMessage(created.id, message);
        expect(await runtime.getMessages(created.id)).toEqual([message]);

        expect(await runtime.renameSession(created.id, 'Renamed')).toEqual({
            ...created,
            name: 'Renamed',
            updatedAt: expect.any(Number),
        });
        expect(await runtime.pinSession(created.id, true)).toEqual({
            ...created,
            name: 'Renamed',
            pinned: true,
            updatedAt: expect.any(Number),
        });
        expect(await runtime.getSessions({ offset: 0, limit: 20 })).toEqual({
            pinned: [
                {
                    ...created,
                    name: 'Renamed',
                    pinned: true,
                    updatedAt: expect.any(Number),
                },
            ],
            items: [],
            total: 0,
            hasMore: false,
        });

        await runtime.deleteSession(created.id);
        expect(await runtime.getSessions({ offset: 0, limit: 20 })).toEqual({
            pinned: [],
            items: [],
            total: 0,
            hasMore: false,
        });
    });

    test('migrates legacy JSON sessions and complete message structures once', async () => {
        const sessionId = 'legacy-session';
        const message = UserMsg({ id: 'message-1', name: 'user', content: 'legacy' });
        await mkdir(path.join(directory, 'chat', sessionId, 'friday'), { recursive: true });
        await writeFile(
            path.join(directory, 'chat', 'index.json'),
            JSON.stringify([
                {
                    id: sessionId,
                    name: 'Legacy',
                    pinned: true,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
        );
        await writeFile(
            path.join(directory, 'chat', sessionId, 'friday', 'context.jsonl'),
            `${JSON.stringify(message)}\n`
        );

        await expect(runtime.migrateLegacyChats()).resolves.toBe(1);
        await expect(runtime.migrateLegacyChats()).resolves.toBe(0);
        expect(await runtime.getMessages(sessionId)).toEqual([message]);
        expect(await runtime.getSessions({ offset: 0, limit: 20 })).toEqual({
            pinned: [
                {
                    id: sessionId,
                    agentKey: 'friday',
                    name: 'Legacy',
                    pinned: true,
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                },
            ],
            items: [],
            total: 0,
            hasMore: false,
        });
    });

    test('delegates schedule persistence and validation to the shared scheduler', async () => {
        const startAt = Date.parse('2030-01-01T00:00:00.000Z');
        const endAt = Date.parse('2031-01-01T00:00:00.000Z');
        const created = await runtime.createSchedule({
            name: 'Daily report',
            enabled: true,
            description: 'Prepare the report.',
            cronExpr: '0 9 * * *',
            startAt,
            endAt,
            agentKey: 'friday',
        });
        expect(created).toEqual({
            id: expect.any(String),
            name: 'Daily report',
            enabled: true,
            description: 'Prepare the report.',
            cronExpr: '0 9 * * *',
            startAt,
            endAt,
            agentKey: 'friday',
        });
        expect(await runtime.listSchedules()).toEqual([created]);
        expect(await runtime.getScheduleExecutions(created.id)).toEqual([]);

        expect(await runtime.updateSchedule(created.id, { enabled: false })).toEqual({
            ...created,
            enabled: false,
        });
        await expect(runtime.deleteSchedule(created.id)).resolves.toBe(true);
        await expect(runtime.getSchedule(created.id)).resolves.toBeUndefined();
    });

    test('migrates legacy schedules, executions, timestamps and messages once', async () => {
        const scheduleId = 'legacy-schedule';
        const executionId = 'legacy-execution';
        const startAt = Date.parse('2030-01-01T00:00:00.000Z');
        const endAt = Date.parse('2031-01-01T00:00:00.000Z');
        const executionStart = Date.parse('2029-01-01T00:00:00.000Z');
        const executionEnd = Date.parse('2029-01-01T00:01:00.000Z');
        const message = UserMsg({ id: 'scheduled-message', name: 'user', content: 'run' });
        const executionDirectory = path.join(directory, 'schedule', scheduleId, 'executions');
        await mkdir(path.join(executionDirectory, executionId, 'friday'), {
            recursive: true,
        });
        await writeFile(
            path.join(directory, 'schedule', scheduleId, 'event.json'),
            JSON.stringify({
                id: scheduleId,
                name: 'Legacy schedule',
                enabled: true,
                description: 'Migrated',
                cronExpr: '0 9 * * *',
                startAt,
                endAt,
                agentKey: 'friday',
            })
        );
        await writeFile(
            path.join(executionDirectory, `${executionId}.json`),
            JSON.stringify({
                executionId,
                scheduleId,
                startTime: executionStart,
                endTime: executionEnd,
                status: 'failed',
                error: 'legacy failure',
            })
        );
        await writeFile(
            path.join(executionDirectory, executionId, 'friday', 'context.jsonl'),
            `${JSON.stringify(message)}\n`
        );

        await expect(runtime.migrateLegacySchedules()).resolves.toEqual({
            schedules: 1,
            executions: 1,
        });
        await expect(runtime.migrateLegacySchedules()).resolves.toEqual({
            schedules: 0,
            executions: 0,
        });
        await expect(runtime.getSchedule(scheduleId)).resolves.toEqual({
            id: scheduleId,
            name: 'Legacy schedule',
            enabled: true,
            description: 'Migrated',
            cronExpr: '0 9 * * *',
            startAt,
            endAt,
            agentKey: 'friday',
        });
        await expect(runtime.getScheduleExecutions(scheduleId)).resolves.toEqual([
            {
                executionId,
                scheduleId,
                startTime: executionStart,
                endTime: executionEnd,
                status: 'failed',
                error: 'legacy failure',
            },
        ]);
        await expect(
            runtime.getScheduleExecutionMessages(scheduleId, executionId)
        ).resolves.toEqual([message]);
    });

    test('stores MCP configuration through shared records and unified clients', async () => {
        const added = await runtime.addMCP({
            name: 'local_tools',
            protocol: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { MODE: 'test' },
        });
        expect(added).toEqual({
            config: {
                id: expect.any(String),
                name: 'local_tools',
                createdAt: expect.any(Number),
                protocol: 'stdio',
                command: 'node',
                args: ['server.js'],
                env: { MODE: 'test' },
            },
            status: 'disconnected',
        });
        expect(await runtime.listMCPs()).toEqual([added]);
        expect(await runtime.app.storage.listMCPs(runtime.userId)).toEqual([
            expect.objectContaining({
                id: added.config.id,
                user_id: 'desktop',
                enabled: true,
                client: {
                    name: 'local_tools',
                    is_stateful: true,
                    mcp_config: {
                        type: 'stdio_mcp',
                        command: 'node',
                        args: ['server.js'],
                        env: { MODE: 'test' },
                        cwd: null,
                        encoding_error_handler: 'strict',
                    },
                    enable_tools: null,
                    disable_tools: null,
                    execution_timeout: null,
                },
            }),
        ]);

        await runtime.removeMCP(added.config.id);
        expect(await runtime.listMCPs()).toEqual([]);
    });

    test('stores local skill metadata and activation in the shared skill service', async () => {
        const skillDirectory = path.join(directory, 'skills', 'writer');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            path.join(skillDirectory, 'SKILL.md'),
            '---\nname: writer\ndescription: Write clear prose\n---\n\n# Writer\n'
        );

        await expect(runtime.migrateLegacySkills()).resolves.toBe(1);
        expect(await runtime.listSkills()).toEqual([
            {
                id: expect.any(String),
                name: 'writer',
                description: 'Write clear prose',
                author: 'Unknown',
                importedAt: expect.any(Number),
                createdAt: expect.any(Number),
                isActive: false,
                dirPath: skillDirectory,
            },
        ]);
        expect(await runtime.setSkillActive('writer', true)).toEqual({
            id: expect.any(String),
            name: 'writer',
            description: 'Write clear prose',
            author: 'Unknown',
            importedAt: expect.any(Number),
            createdAt: expect.any(Number),
            isActive: true,
            dirPath: skillDirectory,
        });
        expect(await runtime.app.storage.getSkillByName(runtime.userId, 'writer')).toEqual(
            expect.objectContaining({ name: 'writer', enabled: true })
        );
        const agent = (await runtime.app.storage.listAgents(runtime.userId))[0];
        const session = await runtime.createSession('friday', 'Skill session');
        const sessionRecord = await runtime.app.storage.getSession(
            runtime.userId,
            agent.id,
            session.id
        );
        const workspace = await runtime.app.workspaceManager.getWorkspace(
            runtime.userId,
            agent.id,
            session.id,
            sessionRecord!.config.workspace_id
        );
        expect(
            (await workspace.listSkills({ agentId: agent.id })).map(skill => skill.name)
        ).toEqual(['writer']);

        await runtime.setSkillActive('writer', false);
        const refreshedWorkspace = await runtime.app.workspaceManager.getWorkspace(
            runtime.userId,
            agent.id,
            session.id,
            sessionRecord!.config.workspace_id
        );
        expect(await refreshedWorkspace.listSkills({ agentId: agent.id })).toEqual([]);

        await runtime.removeSkill('writer');
        await expect(runtime.listSkills()).resolves.toEqual([]);
    });

    test('removes watched skill sources so refresh cannot restore them', async () => {
        const watchDirectory = path.join(directory, 'watched-skills');
        const skillDirectory = path.join(watchDirectory, 'reviewer');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            path.join(skillDirectory, 'SKILL.md'),
            '---\nname: reviewer\ndescription: Review code\n---\n\n# Reviewer\n'
        );

        await expect(runtime.addSkillWatchDir(watchDirectory)).resolves.toEqual({
            success: true,
            watchDir: {
                id: expect.any(String),
                path: watchDirectory,
                addedAt: expect.any(Number),
                isDefault: false,
            },
            skillsAdded: 1,
            errors: [],
        });
        await expect(runtime.listSkills()).resolves.toEqual([
            expect.objectContaining({ name: 'reviewer', dirPath: skillDirectory }),
        ]);

        await runtime.removeSkill('reviewer');
        await expect(runtime.listSkills()).resolves.toEqual([]);
        await expect(runtime.importSkill(skillDirectory)).resolves.toEqual({
            success: false,
            error: `Source path is not a directory: ${skillDirectory}`,
        });
    });

    test('migrates document conversations into isolated hidden service sessions', async () => {
        const documentId = 'legacy-document';
        const message = UserMsg({ id: 'document-message', name: 'user', content: 'draft' });
        await mkdir(path.join(directory, 'editor', documentId, 'friday'), {
            recursive: true,
        });
        await writeFile(
            path.join(directory, 'editor', 'index.json'),
            JSON.stringify([
                {
                    id: documentId,
                    name: 'Draft',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
        );
        await writeFile(
            path.join(directory, 'editor', documentId, 'friday', 'context.jsonl'),
            `${JSON.stringify(message)}\n`
        );

        await expect(runtime.migrateLegacyDocuments()).resolves.toBe(1);
        await expect(runtime.migrateLegacyDocuments()).resolves.toBe(0);
        await expect(runtime.getDocumentMessages(documentId)).resolves.toEqual([message]);
        expect(await runtime.app.storage.listAgents(runtime.userId)).toHaveLength(1);
        await expect(runtime.isDocumentRunning(documentId)).resolves.toBe(false);

        await runtime.deleteDocumentSessions(documentId);
        await expect(runtime.getDocumentMessages(documentId)).resolves.toEqual([]);
    });
});
