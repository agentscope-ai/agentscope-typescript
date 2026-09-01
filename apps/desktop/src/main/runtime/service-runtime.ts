/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { cp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CredentialFactory } from '@agentscope-ai/agentscope/credential';
import { EventType, parseAgentEvent, ReplyFinishedReason } from '@agentscope-ai/agentscope/event';
import type {
    AgentEvent,
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import { HttpMCPConfig, MCPClient, StdioMCPConfig } from '@agentscope-ai/agentscope/mcp';
import { parseMsg } from '@agentscope-ai/agentscope/message';
import type { Msg } from '@agentscope-ai/agentscope/message';
import { createPermissionDecision, PermissionBehavior } from '@agentscope-ai/agentscope/permission';
import type { PermissionContext, PermissionDecision } from '@agentscope-ai/agentscope/permission';
import { LocalSkillLoader } from '@agentscope-ai/agentscope/skill';
import { AgentState } from '@agentscope-ai/agentscope/state';
import { ToolBase } from '@agentscope-ai/agentscope/tool';
import type { Tool } from '@agentscope-ai/agentscope/tool';
import { createApp } from '@agentscope-ai/agentscope-service';
import type { AgentScopeServiceApp } from '@agentscope-ai/agentscope-service';
import { InMemoryMessageBus } from '@agentscope-ai/agentscope-service/message-bus';
import type { MessageBus } from '@agentscope-ai/agentscope-service/message-bus';
import {
    AgentRecordSchema,
    defaultContextConfigData,
    defaultReActConfigData,
    MCPRecordSchema,
    SessionConfigSchema,
    ScheduleRecordSchema,
    SkillRecordSchema,
    SQLStorage,
} from '@agentscope-ai/agentscope-service/storage';
import type {
    ChatModelConfig,
    ScheduleRecord,
    MCPRecord,
    SkillRecord,
    SessionRecord,
    StorageBase,
} from '@agentscope-ai/agentscope-service/storage';
import { LocalWorkspaceManager } from '@agentscope-ai/agentscope-service/workspace-manager';
import type { WorkspaceManagerBase } from '@agentscope-ai/agentscope-service/workspace-manager';

import { DocumentEdit, DocumentRead, DocumentWrite } from '../../shared/tools/document';
import type { GetSessionsQuery, GetSessionsResult, Session } from '../../shared/types/chat';
import type { AgentConfig, Config, ModelConfig } from '../../shared/types/config';
import type { Document } from '../../shared/types/document';
import type {
    MCPServerConfig,
    MCPServerCreateConfig,
    MCPServerState,
} from '../../shared/types/mcp';
import type {
    ExecutionFinishedEvent,
    ExecutionStartedEvent,
    Schedule,
    ScheduleExecution,
    ScheduleWithStatus,
} from '../../shared/types/schedule';
import type {
    SkillConfig,
    SkillImportResult,
    WatchDir,
    WatchDirAddResult,
} from '../../shared/types/skill';
import { readJSON, readJSONL, writeJSON } from '../storage';

const DEFAULT_USER_ID = 'desktop';
const DEFAULT_AGENT_KEY = 'friday';

interface SessionUIData {
    pinned: Record<string, boolean>;
}

interface MCPRuntimeState {
    client: MCPClient | null;
    error?: string;
    status: MCPServerState['status'];
    tools?: string[];
}

class DesktopExternalTool extends ToolBase {
    readonly description: string;
    readonly inputSchema: Tool['inputSchema'];
    readonly isConcurrencySafe = false;
    readonly isReadOnly: boolean;
    readonly name: string;

    constructor(definition: Tool, isReadOnly: boolean) {
        super();
        this.name = definition.name;
        this.description = definition.description;
        this.inputSchema = definition.inputSchema;
        this.isReadOnly = isReadOnly;
        this.isExternalTool = true;
    }

    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `External execution is handled by the Desktop renderer for ${this.name}`,
        });
    }
}

export interface DesktopScheduleEvent {
    agentEvent: AgentEvent;
    executionFinished?: ExecutionFinishedEvent;
    executionStarted?: ExecutionStartedEvent;
    scheduleId: string;
}

export interface DesktopServiceRuntimeOptions {
    dataDirectory: string;
    messageBus?: MessageBus;
    storage?: StorageBase;
    userId?: string;
    workspaceManager?: WorkspaceManagerBase;
}

/** Desktop adapter over the shared AgentScope service composition root. */
export class DesktopServiceRuntime {
    readonly app: AgentScopeServiceApp;
    readonly userId: string;

    private readonly dataDirectory: string;
    private readonly sessionUIPath: string;
    private readonly skillWatchDirsPath: string;
    private readonly localWorkspaceManager: LocalWorkspaceManager | null;
    private readonly scheduleListeners = new Set<(event: DesktopScheduleEvent) => void>();
    private readonly mcpRuntime = new Map<string, MCPRuntimeState>();
    private workspaceSkillPaths: string[] = [];
    private config: Config | null = null;

    constructor(options: DesktopServiceRuntimeOptions) {
        this.dataDirectory = path.resolve(options.dataDirectory);
        this.sessionUIPath = path.join(this.dataDirectory, 'desktop-session-ui.json');
        this.skillWatchDirsPath = path.join(this.dataDirectory, 'skills', 'watch-dirs.json');
        this.userId = options.userId ?? DEFAULT_USER_ID;
        const workspaceManager =
            options.workspaceManager ??
            new LocalWorkspaceManager({
                baseDirectory: path.join(this.dataDirectory, 'workspace'),
            });
        this.localWorkspaceManager =
            workspaceManager instanceof LocalWorkspaceManager ? workspaceManager : null;
        this.app = createApp({
            storage:
                options.storage ??
                new SQLStorage({ filename: path.join(this.dataDirectory, 'service.sqlite3') }),
            messageBus: options.messageBus ?? new InMemoryMessageBus(),
            workspaceManager,
            extraProjectors: [
                {
                    maybeProject: async (_userId, session, _agent, event) => {
                        this.projectScheduleEvent(session, event);
                    },
                },
            ],
            extraAgentTools: async (_userId, _agentId, sessionId) =>
                this.desktopAgentTools(sessionId),
        });
    }

    /** Open every shared service resource. */
    async open(): Promise<this> {
        await this.app.open();
        return this;
    }

    /** Close the shared runtime in reverse dependency order. */
    async close(): Promise<void> {
        await Promise.allSettled(
            [...this.mcpRuntime.values()]
                .map(item => item.client)
                .filter((client): client is MCPClient => client !== null && client.isConnected)
                .map(client => client.close())
        );
        this.mcpRuntime.clear();
        await this.app.close();
    }

    /**
     * Synchronize Desktop settings into service credential and agent records.
     * @param config
     */
    async syncConfig(config: Config): Promise<void> {
        this.config = structuredClone(config);
        for (const [modelKey, model] of Object.entries(config.models)) {
            await this.syncCredential(modelKey, model);
        }
        for (const [agentKey, agent] of Object.entries(config.agents)) {
            await this.syncAgent(agentKey, agent);
            await this.syncDocumentAgent(agentKey, agent, config.username);
        }
    }

    /** Import the legacy JSON chat index exactly once into service storage. */
    async migrateLegacyChats(): Promise<number> {
        this.requireConfig();
        const legacy = readJSON<Session[]>(path.join(this.dataDirectory, 'chat', 'index.json'), []);
        let migrated = 0;
        for (const item of legacy) {
            if (await this.findSession(item.id)) continue;
            const agentKey = item.agentKey ?? DEFAULT_AGENT_KEY;
            const agentId = this.agentId(agentKey);
            if (!(await this.app.storage.getAgent(this.userId, agentId))) continue;
            const messages = readJSONL<unknown>(
                path.join(this.dataDirectory, 'chat', item.id, agentKey, 'context.jsonl')
            ).map(parseMsg);
            const workspaceId = await this.app.workspaceManager.assignWorkspaceId({
                userId: this.userId,
                agentId,
                sessionId: item.id,
            });
            await this.app.storage.upsertSession({
                userId: this.userId,
                agentId,
                sessionId: item.id,
                config: SessionConfigSchema.parse({
                    workspace_id: workspaceId,
                    name: item.name,
                    chat_model_config: this.chatModelConfig(agentKey),
                }),
                state: new AgentState({ sessionId: item.id, context: messages }).toJSON(),
            });
            for (const message of messages) {
                await this.app.storage.upsertMessage(this.userId, item.id, message);
            }
            this.setPinned(item.id, item.pinned);
            migrated += 1;
        }
        return migrated;
    }

    /** Import legacy Desktop MCP configurations into shared service records. */
    async migrateLegacyMCPs(): Promise<number> {
        const legacy = readJSON<MCPServerConfig[]>(path.join(this.dataDirectory, 'mcp.json'), []);
        let migrated = 0;
        for (const config of legacy) {
            if (await this.app.storage.getMCP(this.userId, config.id)) continue;
            await this.upsertMCP(config, config.id, config.createdAt);
            migrated += 1;
        }
        return migrated;
    }

    /** Import legacy schedules and historical executions into shared records. */
    async migrateLegacySchedules(): Promise<{ executions: number; schedules: number }> {
        this.requireConfig();
        let schedules = 0;
        let executions = 0;
        const root = path.join(this.dataDirectory, 'schedule');
        for (const entry of await readDirectory(root)) {
            if (!entry.isDirectory()) continue;
            const legacy = readJSON<Schedule | null>(
                path.join(root, entry.name, 'event.json'),
                null
            );
            if (!legacy || !this.requireConfig().agents[legacy.agentKey]) continue;
            let record = await this.app.storage.getSchedule(this.userId, legacy.id);
            if (!record) {
                record = this.scheduleRecord(legacy, legacy.id);
                await this.app.storage.upsertSchedule(this.userId, record);
                await this.app.managers.scheduler.notifyChanged(record.id);
                schedules += 1;
            }
            const executionRoot = path.join(root, entry.name, 'executions');
            for (const executionEntry of await readDirectory(executionRoot)) {
                if (!executionEntry.isFile() || !executionEntry.name.endsWith('.json')) continue;
                const execution = readJSON<ScheduleExecution | null>(
                    path.join(executionRoot, executionEntry.name),
                    null
                );
                if (!execution) continue;
                if (
                    await this.app.storage.getSession(
                        this.userId,
                        record.agent_id,
                        execution.executionId
                    )
                ) {
                    continue;
                }
                const messages = readJSONL<unknown>(
                    path.join(
                        executionRoot,
                        execution.executionId,
                        legacy.agentKey,
                        'context.jsonl'
                    )
                ).map(parseMsg);
                const workspaceId = await this.app.workspaceManager.assignWorkspaceId({
                    userId: this.userId,
                    agentId: record.agent_id,
                    sessionId: execution.executionId,
                });
                await this.app.storage.upsertSession({
                    userId: this.userId,
                    agentId: record.agent_id,
                    sessionId: execution.executionId,
                    createdAt: new Date(execution.startTime).toISOString(),
                    updatedAt: new Date(execution.endTime ?? execution.startTime).toISOString(),
                    source: 'schedule',
                    sourceScheduleId: record.id,
                    config: SessionConfigSchema.parse({
                        workspace_id: workspaceId,
                        name: legacy.name,
                        chat_model_config: this.chatModelConfig(legacy.agentKey),
                    }),
                    state: new AgentState({
                        sessionId: execution.executionId,
                        context: messages,
                        middleContext: {
                            desktop_legacy_execution: {
                                status:
                                    execution.status === 'running' ? 'failed' : execution.status,
                                end_time: execution.endTime ?? execution.startTime,
                                error:
                                    execution.error ??
                                    (execution.status === 'running'
                                        ? 'Execution was interrupted during Desktop service migration.'
                                        : null),
                            },
                        },
                    }).toJSON(),
                });
                for (const message of messages) {
                    await this.app.storage.upsertMessage(
                        this.userId,
                        execution.executionId,
                        message
                    );
                }
                executions += 1;
            }
        }
        return { executions, schedules };
    }

    /** Load every configured local skill into shared service records. */
    async migrateLegacySkills(): Promise<number> {
        const states = readJSON<Record<string, boolean>>(
            path.join(this.dataDirectory, 'skills', 'states.json'),
            {}
        );
        return this.refreshSkills(states);
    }

    /** Import legacy editor conversations into hidden document sessions. */
    async migrateLegacyDocuments(): Promise<number> {
        this.requireConfig();
        const documents = readJSON<Document[]>(
            path.join(this.dataDirectory, 'editor', 'index.json'),
            []
        );
        let migrated = 0;
        for (const document of documents) {
            const session = await this.ensureDocumentSession(
                document.id,
                DEFAULT_AGENT_KEY,
                document.name
            );
            const page = await this.app.storage.listMessages(this.userId, session.id, {
                limit: 1,
            });
            if (page.messages.length > 0) continue;
            const messages = readJSONL<unknown>(
                path.join(
                    this.dataDirectory,
                    'editor',
                    document.id,
                    DEFAULT_AGENT_KEY,
                    'context.jsonl'
                )
            ).map(parseMsg);
            if (messages.length === 0) continue;
            await this.app.storage.upsertSession({
                userId: this.userId,
                agentId: session.agent_id,
                sessionId: session.id,
                config: session.config,
                state: new AgentState({ sessionId: session.id, context: messages }).toJSON(),
            });
            for (const message of messages) {
                await this.app.storage.upsertMessage(this.userId, session.id, message);
            }
            migrated += 1;
        }
        return migrated;
    }

    async getDocumentMessages(documentId: string, agentKey = DEFAULT_AGENT_KEY): Promise<Msg[]> {
        const session = await this.findDocumentSession(documentId, agentKey);
        if (!session) return [];
        return (await this.app.storage.listMessages(this.userId, session.id, { limit: 10_000 }))
            .messages;
    }

    async isDocumentRunning(documentId: string): Promise<boolean> {
        const agentKeys = Object.keys(this.requireConfig().agents);
        const states = await Promise.all(
            agentKeys.map(agentKey =>
                this.app.messageBus.sessionIsRunning(this.documentSessionId(documentId, agentKey))
            )
        );
        return states.some(Boolean);
    }

    async sendDocumentMessage(
        documentId: string,
        agentKey: string,
        input: Msg | UserConfirmResultEvent | ExternalExecutionResultEvent | null,
        onEvent: (event: AgentEvent) => void
    ): Promise<void> {
        const session = await this.ensureDocumentSession(documentId, agentKey);
        await this.refreshDocumentSessionModel(session, agentKey);
        await this.runSession(session, input, onEvent);
    }

    async deleteDocumentSessions(documentId: string): Promise<void> {
        for (const agentKey of Object.keys(this.requireConfig().agents)) {
            const session = await this.findDocumentSession(documentId, agentKey);
            if (session) {
                await this.app.services.session.deleteSession(
                    this.userId,
                    session.agent_id,
                    session.id
                );
            }
        }
    }

    async getSessions(query: GetSessionsQuery): Promise<GetSessionsResult> {
        const sessions = await this.allUserSessions();
        const mapped = sessions.map(item => this.sessionView(item));
        const pinned = mapped
            .filter(item => item.pinned)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        const unpinned = mapped
            .filter(item => !item.pinned)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        const items = unpinned.slice(query.offset, query.offset + query.limit);
        return {
            pinned,
            items,
            total: unpinned.length,
            hasMore: query.offset + query.limit < unpinned.length,
        };
    }

    async createSession(agentKey = DEFAULT_AGENT_KEY, name?: string): Promise<Session> {
        this.requireAgent(agentKey);
        const agentId = this.agentId(agentKey);
        const provisionalId = crypto.randomUUID().replaceAll('-', '');
        const workspaceId = await this.app.workspaceManager.assignWorkspaceId({
            userId: this.userId,
            agentId,
            sessionId: provisionalId,
        });
        const record = await this.app.storage.upsertSession({
            userId: this.userId,
            agentId,
            sessionId: provisionalId,
            config: SessionConfigSchema.parse({
                workspace_id: workspaceId,
                ...(name ? { name } : {}),
                chat_model_config: this.chatModelConfig(agentKey),
            }),
            state: new AgentState({ sessionId: provisionalId }).toJSON(),
        });
        return this.sessionView(record);
    }

    async renameSession(id: string, name: string): Promise<Session> {
        const record = await this.requireSession(id);
        const updated = await this.app.storage.upsertSession({
            userId: this.userId,
            agentId: record.agent_id,
            sessionId: record.id,
            config: SessionConfigSchema.parse({ ...record.config, name }),
            state: record.state,
        });
        return this.sessionView(updated);
    }

    async pinSession(id: string, pinned: boolean): Promise<Session> {
        const record = await this.requireSession(id);
        this.setPinned(id, pinned);
        return this.sessionView(record);
    }

    async deleteSession(id: string): Promise<void> {
        const record = await this.requireSession(id);
        await this.app.services.session.deleteSession(this.userId, record.agent_id, id);
        const data = this.readSessionUI();
        delete data.pinned[id];
        writeJSON(this.sessionUIPath, data);
    }

    async getMessages(id: string): Promise<Msg[]> {
        await this.requireSession(id);
        return (await this.app.storage.listMessages(this.userId, id, { limit: 10_000 })).messages;
    }

    async addMessage(id: string, message: Msg): Promise<Msg> {
        await this.requireSession(id);
        const parsed = parseMsg(message);
        await this.app.storage.upsertMessage(this.userId, id, parsed);
        return parsed;
    }

    async isRunning(id: string): Promise<boolean> {
        await this.requireSession(id);
        return this.app.messageBus.sessionIsRunning(id);
    }

    async sendMessage(
        id: string,
        input: Msg | UserConfirmResultEvent | ExternalExecutionResultEvent | null,
        onEvent: (event: AgentEvent) => void
    ): Promise<void> {
        const record = await this.requireSession(id);
        await this.refreshSessionModel(record);
        await this.runSession(record, input, onEvent);
    }

    private async runSession(
        record: SessionRecord,
        input: Msg | UserConfirmResultEvent | ExternalExecutionResultEvent | null,
        onEvent: (event: AgentEvent) => void
    ): Promise<void> {
        const controller = new AbortController();
        let ready = (): void => {};
        const readyPromise = new Promise<void>(resolve => {
            ready = resolve;
        });
        const events = this.forwardEvents(record.id, controller.signal, ready, onEvent);
        await readyPromise;
        try {
            await this.app.services.chat.run({
                userId: this.userId,
                sessionId: record.id,
                agentId: record.agent_id,
                input,
            });
        } finally {
            controller.abort();
            await events;
        }
    }

    /**
     * Subscribe to Desktop projections of shared scheduler execution events.
     * @param listener
     */
    onScheduleEvent(listener: (event: DesktopScheduleEvent) => void): () => void {
        this.scheduleListeners.add(listener);
        return () => this.scheduleListeners.delete(listener);
    }

    async createSchedule(input: Omit<Schedule, 'id'>): Promise<Schedule> {
        const record = this.scheduleRecord(input);
        this.app.managers.scheduler.validateSchedule(record);
        await this.app.storage.upsertSchedule(this.userId, record);
        await this.app.managers.scheduler.notifyChanged(record.id);
        return this.scheduleView(record);
    }

    async getSchedule(id: string): Promise<Schedule | undefined> {
        const record = await this.app.storage.getSchedule(this.userId, id);
        return record ? this.scheduleView(record) : undefined;
    }

    async listSchedules(): Promise<ScheduleWithStatus[]> {
        const result: ScheduleWithStatus[] = [];
        for (const record of await this.app.storage.listSchedules(this.userId)) {
            const executions = await this.scheduleExecutions(record.id);
            const running = executions.find(item => item.status === 'running');
            result.push({
                ...this.scheduleView(record),
                ...(running
                    ? {
                          runningExecution: {
                              executionId: running.executionId,
                              startTime: running.startTime,
                          },
                      }
                    : {}),
            });
        }
        return result;
    }

    async updateSchedule(
        id: string,
        patch: Partial<Omit<Schedule, 'id'>>
    ): Promise<Schedule | null> {
        const current = await this.app.storage.getSchedule(this.userId, id);
        if (!current) return null;
        const next = { ...this.scheduleView(current), ...patch };
        const chatModelConfig = this.chatModelConfig(next.agentKey);
        if (!chatModelConfig) throw new Error('No model configured.');
        const record = ScheduleRecordSchema.parse({
            ...current,
            agent_id: this.agentId(next.agentKey),
            data: {
                ...current.data,
                name: next.name,
                description: next.description,
                enabled: next.enabled,
                cron_expression: next.cronExpr,
                started_at: new Date(next.startAt).toISOString(),
                ended_at: next.endAt == null ? null : new Date(next.endAt).toISOString(),
                chat_model_config: chatModelConfig,
                stateful: Boolean(next.sessionId),
                source_session_id: next.sessionId ?? '',
            },
            updated_at: new Date().toISOString(),
        });
        this.app.managers.scheduler.validateSchedule(record);
        await this.app.storage.upsertSchedule(this.userId, record);
        await this.app.managers.scheduler.notifyChanged(record.id);
        return this.scheduleView(record);
    }

    async deleteSchedule(id: string): Promise<boolean> {
        const deleted = await this.app.services.session.deleteSchedule(this.userId, id);
        if (deleted) await this.app.managers.scheduler.notifyChanged(id);
        return deleted;
    }

    async getScheduleExecutions(scheduleId: string): Promise<ScheduleExecution[]> {
        if (!(await this.app.storage.getSchedule(this.userId, scheduleId))) return [];
        return this.scheduleExecutions(scheduleId);
    }

    async getScheduleExecutionMessages(scheduleId: string, executionId: string): Promise<Msg[]> {
        const sessions = await this.app.storage.listSessionsBySchedule(this.userId, scheduleId);
        if (!sessions.some(item => item.id === executionId)) return [];
        return (await this.app.storage.listMessages(this.userId, executionId, { limit: 10_000 }))
            .messages;
    }

    async listMCPs(): Promise<MCPServerState[]> {
        return (await this.app.storage.listMCPs(this.userId)).map(record => this.mcpState(record));
    }

    async addMCP(config: MCPServerCreateConfig): Promise<MCPServerState> {
        const record = await this.upsertMCP({
            ...config,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
        } as MCPServerConfig);
        return this.mcpState(record);
    }

    async removeMCP(id: string): Promise<void> {
        await this.disconnectMCP(id).catch(() => undefined);
        await this.app.storage.deleteMCP(this.userId, id);
        this.mcpRuntime.delete(id);
    }

    async connectMCP(id: string): Promise<MCPServerState> {
        const record = await this.requireMCP(id);
        const existing = this.mcpRuntime.get(id);
        if (existing?.status === 'connected') return this.mcpState(record);
        try {
            const client = this.mcpClient(record);
            await client.connect();
            const tools = (await client.listTools()).map(tool => tool.originalName);
            this.mcpRuntime.set(id, { client, status: 'connected', tools });
        } catch (error) {
            this.mcpRuntime.set(id, {
                client: null,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return this.mcpState(record);
    }

    async disconnectMCP(id: string): Promise<MCPServerState> {
        const record = await this.requireMCP(id);
        const state = this.mcpRuntime.get(id);
        if (state?.client?.isConnected) await state.client.close();
        this.mcpRuntime.set(id, { client: null, status: 'disconnected' });
        return this.mcpState(record);
    }

    async listMCPTools(id: string): Promise<string[]> {
        const record = await this.requireMCP(id);
        let state = this.mcpRuntime.get(id);
        if (state?.status !== 'connected' || !state.client) {
            await this.connectMCP(id);
            state = this.mcpRuntime.get(id);
        }
        if (state?.status !== 'connected' || !state.client) {
            throw new Error(state?.error ?? `MCP server '${record.client.name}' is not connected`);
        }
        const tools = (await state.client.listTools()).map(tool => tool.originalName);
        state.tools = tools;
        return tools;
    }

    async listSkills(): Promise<SkillConfig[]> {
        await this.refreshSkills();
        return (await this.app.storage.listSkills(this.userId)).map(record =>
            this.skillView(record)
        );
    }

    async setSkillActive(name: string, enabled: boolean): Promise<SkillConfig> {
        const record = await this.app.storage.getSkillByName(this.userId, name);
        if (!record) throw new Error(`Skill '${name}' not found`);
        const updated = SkillRecordSchema.parse({
            ...record,
            enabled,
            updated_at: new Date().toISOString(),
        });
        await this.app.storage.upsertSkill(this.userId, updated);
        await this.syncWorkspaceSkills();
        return this.skillView(updated);
    }

    async removeSkill(name: string): Promise<void> {
        const record = await this.app.storage.getSkillByName(this.userId, name);
        if (!record) throw new Error(`Skill '${name}' not found`);
        await this.app.storage.deleteSkill(this.userId, record.id);
        const directory = localSkillDirectory(record);
        if (directory) {
            await rm(directory, { recursive: true, force: true });
        }
        await this.syncWorkspaceSkills();
    }

    async importSkill(sourcePath: string): Promise<SkillImportResult> {
        if (!(await isDirectory(sourcePath))) {
            return { success: false, error: `Source path is not a directory: ${sourcePath}` };
        }
        const skills = await new LocalSkillLoader({ directory: sourcePath }).listSkills();
        if (skills.length !== 1) {
            return { success: false, error: `No valid SKILL.md found in: ${sourcePath}` };
        }
        const target = path.join(this.dataDirectory, 'skills', path.basename(sourcePath));
        if (await pathExists(target)) {
            return {
                success: false,
                error: `Skill '${path.basename(sourcePath)}' already exists`,
            };
        }
        await cp(sourcePath, target, { recursive: true, errorOnExist: true });
        await this.refreshSkills();
        const record = await this.app.storage.getSkillByName(this.userId, skills[0].name);
        if (!record) return { success: false, error: `Failed to import skill '${skills[0].name}'` };
        const active = await this.setSkillActive(record.name, true);
        return { success: true, skill: active };
    }

    getSkillWatchDirs(): WatchDir[] {
        return this.readWatchDirs();
    }

    async addSkillWatchDir(directory: string): Promise<WatchDirAddResult> {
        if (!(await isDirectory(directory))) {
            return {
                success: false,
                skillsAdded: 0,
                errors: [`Directory does not exist: ${directory}`],
            };
        }
        const watchDirs = this.readWatchDirs();
        const normalized = path.resolve(directory);
        if (watchDirs.some(item => path.resolve(item.path) === normalized)) {
            return {
                success: false,
                skillsAdded: 0,
                errors: [`Directory is already monitored: ${directory}`],
            };
        }
        const loader = new LocalSkillLoader({ directory: normalized, scanSubdir: true });
        const skills = await loader.listSkills();
        const watchDir: WatchDir = {
            id: crypto.randomUUID(),
            path: normalized,
            addedAt: Date.now(),
            isDefault: false,
        };
        watchDirs.push(watchDir);
        writeJSON(this.skillWatchDirsPath, watchDirs);
        await this.refreshSkills();
        return { success: true, watchDir, skillsAdded: skills.length, errors: [] };
    }

    async removeSkillWatchDir(id: string): Promise<void> {
        const watchDirs = this.readWatchDirs();
        const item = watchDirs.find(entry => entry.id === id);
        if (!item) throw new Error(`Watch dir '${id}' not found`);
        if (item.isDefault) throw new Error('Cannot remove the default watch dir');
        writeJSON(
            this.skillWatchDirsPath,
            watchDirs.filter(entry => entry.id !== id)
        );
        for (const record of await this.app.storage.listSkills(this.userId)) {
            const directory = localSkillDirectory(record);
            if (directory && isWithin(item.path, directory)) {
                await this.app.storage.deleteSkill(this.userId, record.id);
            }
        }
        await this.refreshSkills();
    }

    private async forwardEvents(
        sessionId: string,
        signal: AbortSignal,
        onReady: () => void,
        onEvent: (event: AgentEvent) => void
    ): Promise<void> {
        for await (const payload of this.app.messageBus.sessionSubscribeEvents(sessionId, {
            signal,
            onReady,
        })) {
            onEvent(parseAgentEvent(payload));
        }
    }

    private projectScheduleEvent(session: SessionRecord, event: AgentEvent): void {
        const scheduleId = session.source_schedule_id;
        if (session.source !== 'schedule' || !scheduleId) return;
        const projected: DesktopScheduleEvent = { scheduleId, agentEvent: event };
        if (event.type === EventType.REPLY_START) {
            projected.executionStarted = {
                scheduleId,
                executionId: session.id,
                startTime: Date.parse(event.created_at),
            };
        } else if (event.type === EventType.REPLY_END) {
            projected.executionFinished = {
                scheduleId,
                executionId: session.id,
                status:
                    event.finished_reason === ReplyFinishedReason.ERROR ? 'failed' : 'completed',
                endTime: Date.parse(event.created_at),
                error: event.error?.message,
            };
        }
        for (const listener of this.scheduleListeners) listener(projected);
    }

    private async enabledMCPTools(): Promise<ToolBase[]> {
        const tools: ToolBase[] = [];
        for (const record of await this.app.storage.listMCPs(this.userId)) {
            if (!record.enabled) continue;
            let state = this.mcpRuntime.get(record.id);
            if (state?.status !== 'connected') {
                await this.connectMCP(record.id);
                state = this.mcpRuntime.get(record.id);
            }
            if (state?.client) tools.push(...(await state.client.listTools()));
        }
        return tools;
    }

    private async desktopAgentTools(sessionId: string): Promise<ToolBase[]> {
        const tools = await this.enabledMCPTools();
        if (sessionId.startsWith('desktop-document-')) {
            tools.push(
                new DesktopExternalTool(DocumentRead(), true),
                new DesktopExternalTool(DocumentWrite(), false),
                new DesktopExternalTool(DocumentEdit(), false)
            );
        }
        return tools;
    }

    private async refreshSkills(legacyStates: Record<string, boolean> = {}): Promise<number> {
        let changed = 0;
        const watchDirs = this.readWatchDirs();
        const discoveredDirectories = new Set<string>();
        for (const watchDir of watchDirs) {
            const skills = await new LocalSkillLoader({
                directory: watchDir.path,
                scanSubdir: true,
            }).listSkills();
            for (const skill of skills) {
                discoveredDirectories.add(path.resolve(skill.dir));
                const current = await this.app.storage.getSkillByName(this.userId, skill.name);
                const record = SkillRecordSchema.parse({
                    id: current?.id ?? stableId('skill', skill.dir),
                    user_id: this.userId,
                    created_at: current?.created_at,
                    name: skill.name,
                    display_name: skill.name,
                    description: skill.description,
                    markdown: skill.markdown,
                    url: pathToFileURL(skill.dir).href,
                    enabled: legacyStates[skill.name] ?? current?.enabled ?? false,
                });
                await this.app.storage.upsertSkill(this.userId, record);
                changed += current ? 0 : 1;
            }
        }
        for (const record of await this.app.storage.listSkills(this.userId)) {
            const directory = localSkillDirectory(record);
            if (
                directory &&
                watchDirs.some(item => isWithin(item.path, directory)) &&
                !discoveredDirectories.has(path.resolve(directory))
            ) {
                await this.app.storage.deleteSkill(this.userId, record.id);
            }
        }
        await this.syncWorkspaceSkills();
        return changed;
    }

    private async syncWorkspaceSkills(): Promise<void> {
        if (!this.localWorkspaceManager) return;
        const directories = (await this.app.storage.listSkills(this.userId))
            .filter(record => record.enabled)
            .map(localSkillDirectory)
            .filter((directory): directory is string => directory !== null)
            .sort();
        if (
            directories.length === this.workspaceSkillPaths.length &&
            directories.every((directory, index) => directory === this.workspaceSkillPaths[index])
        ) {
            return;
        }
        await this.localWorkspaceManager.setSkillPaths(directories);
        const agentKeys = Object.keys(this.requireConfig().agents);
        await Promise.all(
            agentKeys.flatMap(agentKey =>
                [this.agentId(agentKey), this.documentAgentId(agentKey)].map(agentId =>
                    rm(path.join(this.localWorkspaceManager!.baseDirectory, agentId, 'skills'), {
                        recursive: true,
                        force: true,
                    })
                )
            )
        );
        this.workspaceSkillPaths = directories;
    }

    private skillView(record: SkillRecord): SkillConfig {
        const directory = localSkillDirectory(record) ?? '';
        const watchDir = this.readWatchDirs().find(item => isWithin(item.path, directory));
        return {
            id: record.id,
            name: record.name,
            description: record.description,
            author: record.author ?? 'Unknown',
            version: record.version ?? undefined,
            importedAt: watchDir?.addedAt ?? Date.parse(record.created_at),
            createdAt: Date.parse(record.created_at),
            isActive: record.enabled,
            dirPath: directory,
        };
    }

    private readWatchDirs(): WatchDir[] {
        const defaultDirectory = path.join(this.dataDirectory, 'skills');
        const stored = readJSON<WatchDir[]>(this.skillWatchDirsPath, []);
        if (stored.some(item => item.isDefault)) return stored;
        const watchDirs: WatchDir[] = [
            {
                id: 'default',
                path: defaultDirectory,
                addedAt: Date.now(),
                isDefault: true,
            },
            ...stored,
        ];
        writeJSON(this.skillWatchDirsPath, watchDirs);
        return watchDirs;
    }

    private async upsertMCP(
        config: MCPServerConfig,
        id = config.id,
        createdAt = config.createdAt
    ): Promise<MCPRecord> {
        const client = desktopMCPClient(config);
        const mcpConfig = client.mcpConfig;
        const record = MCPRecordSchema.parse({
            id,
            user_id: this.userId,
            created_at: new Date(createdAt).toISOString(),
            client: {
                name: client.name,
                is_stateful: client.isStateful,
                mcp_config:
                    mcpConfig.type === 'http_mcp'
                        ? {
                              type: 'http_mcp',
                              url: mcpConfig.url,
                              headers: mcpConfig.headers ?? null,
                              timeout: mcpConfig.timeout,
                          }
                        : {
                              type: 'stdio_mcp',
                              command: mcpConfig.command,
                              args: mcpConfig.args ?? null,
                              env: mcpConfig.env ?? null,
                              cwd: mcpConfig.cwd ?? null,
                              encoding_error_handler: mcpConfig.encodingErrorHandler,
                          },
                enable_tools: null,
                disable_tools: null,
                execution_timeout: null,
            },
            display_name: config.name,
            values: { desktop_protocol: config.protocol },
        });
        await this.app.storage.upsertMCP(this.userId, record);
        return record;
    }

    private async requireMCP(id: string): Promise<MCPRecord> {
        const record = await this.app.storage.getMCP(this.userId, id);
        if (!record) throw new Error(`MCP server '${id}' not found`);
        return record;
    }

    private mcpClient(record: MCPRecord): MCPClient {
        const config = record.client.mcp_config;
        return new MCPClient({
            name: record.client.name,
            isStateful: record.client.is_stateful,
            mcpConfig:
                config.type === 'http_mcp'
                    ? new HttpMCPConfig({
                          url: config.url,
                          headers: config.headers ?? undefined,
                          timeout: config.timeout,
                      })
                    : new StdioMCPConfig({
                          command: config.command,
                          args: config.args ?? undefined,
                          env: config.env ?? undefined,
                          cwd: config.cwd ?? undefined,
                          encodingErrorHandler: config.encoding_error_handler,
                      }),
            enableTools: record.client.enable_tools,
            disableTools: record.client.disable_tools,
            executionTimeout: record.client.execution_timeout,
        });
    }

    private mcpState(record: MCPRecord): MCPServerState {
        const config = record.client.mcp_config;
        const desktopConfig: MCPServerConfig =
            config.type === 'stdio_mcp'
                ? {
                      id: record.id,
                      name: record.client.name,
                      createdAt: Date.parse(record.created_at),
                      protocol: 'stdio',
                      command: config.command,
                      ...(config.args ? { args: config.args } : {}),
                      ...(config.env ? { env: config.env } : {}),
                  }
                : {
                      id: record.id,
                      name: record.client.name,
                      createdAt: Date.parse(record.created_at),
                      protocol:
                          record.values.desktop_protocol === 'sse' ? 'sse' : 'streamable-http',
                      url: config.url,
                      ...(config.timeout == null ? {} : { timeout: config.timeout }),
                  };
        const state = this.mcpRuntime.get(record.id);
        return {
            config: desktopConfig,
            status: state?.status ?? 'disconnected',
            ...(state?.error ? { error: state.error } : {}),
            ...(state?.tools ? { tools: state.tools } : {}),
        };
    }

    private async scheduleExecutions(scheduleId: string): Promise<ScheduleExecution[]> {
        const result: ScheduleExecution[] = [];
        for (const session of await this.app.storage.listSessionsBySchedule(
            this.userId,
            scheduleId
        )) {
            const running = await this.app.messageBus.sessionIsRunning(session.id);
            const legacy = legacyExecutionView(session.state.middle_context);
            const page = await this.app.storage.listMessages(this.userId, session.id, {
                limit: 10_000,
            });
            const last = page.messages.at(-1);
            result.push({
                executionId: session.id,
                scheduleId,
                startTime: Date.parse(session.created_at),
                ...(running ? {} : { endTime: legacy?.endTime ?? Date.parse(session.updated_at) }),
                status: running
                    ? 'running'
                    : (legacy?.status ??
                      (last?.finished_reason === ReplyFinishedReason.ERROR
                          ? 'failed'
                          : 'completed')),
                ...(legacy?.error || last?.error?.message
                    ? { error: legacy?.error ?? last!.error!.message }
                    : {}),
            });
        }
        return result.sort((left, right) => right.startTime - left.startTime);
    }

    private scheduleView(record: ScheduleRecord): Schedule {
        return {
            id: record.id,
            name: record.data.name,
            enabled: record.data.enabled,
            description: record.data.description,
            ...(record.data.source_session_id ? { sessionId: record.data.source_session_id } : {}),
            cronExpr: record.data.cron_expression,
            startAt: Date.parse(record.data.started_at),
            ...(record.data.ended_at ? { endAt: Date.parse(record.data.ended_at) } : {}),
            agentKey: this.configAgentKey(record.agent_id),
        };
    }

    private scheduleRecord(input: Omit<Schedule, 'id'>, id?: string): ScheduleRecord {
        const chatModelConfig = this.chatModelConfig(input.agentKey);
        if (!chatModelConfig) throw new Error('No model configured.');
        return ScheduleRecordSchema.parse({
            id,
            user_id: this.userId,
            agent_id: this.agentId(input.agentKey),
            data: {
                name: input.name,
                description: input.description,
                enabled: input.enabled,
                timezone: localTimezone(),
                cron_expression: input.cronExpr,
                started_at: new Date(input.startAt).toISOString(),
                ended_at: input.endAt == null ? null : new Date(input.endAt).toISOString(),
                chat_model_config: chatModelConfig,
                stateful: Boolean(input.sessionId),
                permission_mode: 'dont_ask',
                source: 'USER',
                source_session_id: input.sessionId ?? '',
            },
        });
    }

    private async refreshSessionModel(record: SessionRecord): Promise<void> {
        const agentKey = await this.agentKey(record.agent_id);
        const config = SessionConfigSchema.parse({
            ...record.config,
            chat_model_config: this.chatModelConfig(agentKey),
        });
        await this.app.storage.upsertSession({
            userId: this.userId,
            agentId: record.agent_id,
            sessionId: record.id,
            config,
            state: record.state,
        });
    }

    private async refreshDocumentSessionModel(
        record: SessionRecord,
        agentKey: string
    ): Promise<void> {
        await this.app.storage.upsertSession({
            userId: this.userId,
            agentId: record.agent_id,
            sessionId: record.id,
            config: SessionConfigSchema.parse({
                ...record.config,
                chat_model_config: this.chatModelConfig(agentKey),
            }),
            state: record.state,
        });
    }

    private async syncCredential(modelKey: string, model: ModelConfig): Promise<void> {
        const type = `${model.provider}_credential`;
        const credential = CredentialFactory.fromDict({
            id: this.credentialId(modelKey),
            name: modelKey,
            type,
            ...(model.provider === 'ollama' ? {} : { api_key: model.apiKey }),
        });
        await this.app.storage.upsertCredential(this.userId, credential);
    }

    private async syncAgent(agentKey: string, agent: AgentConfig): Promise<void> {
        const record = AgentRecordSchema.parse({
            id: this.agentId(agentKey),
            user_id: this.userId,
            data: {
                id: agentKey,
                name: agent.name,
                system_prompt: this.systemPrompt(agentKey, agent),
                context_config: defaultContextConfigData(),
                react_config: {
                    ...defaultReActConfigData(),
                    max_iters: agent.maxIters,
                },
            },
        });
        await this.app.storage.upsertAgent(this.userId, record);
    }

    private async syncDocumentAgent(
        agentKey: string,
        agent: AgentConfig,
        username: string
    ): Promise<void> {
        const record = AgentRecordSchema.parse({
            id: this.documentAgentId(agentKey),
            user_id: this.userId,
            source: 'team',
            data: {
                id: `document:${agentKey}`,
                name: agent.name,
                system_prompt: documentSystemPrompt(username, agent.instruction),
                context_config: defaultContextConfigData(),
                react_config: {
                    ...defaultReActConfigData(),
                    max_iters: agent.maxIters,
                },
            },
        });
        await this.app.storage.upsertAgent(this.userId, record);
    }

    private async ensureDocumentSession(
        documentId: string,
        agentKey: string,
        name?: string
    ): Promise<SessionRecord> {
        this.requireAgent(agentKey);
        const existing = await this.findDocumentSession(documentId, agentKey);
        if (existing) return existing;
        const agentId = this.documentAgentId(agentKey);
        const sessionId = this.documentSessionId(documentId, agentKey);
        const workspaceId = await this.app.workspaceManager.assignWorkspaceId({
            userId: this.userId,
            agentId,
            sessionId,
        });
        return this.app.storage.upsertSession({
            userId: this.userId,
            agentId,
            sessionId,
            config: SessionConfigSchema.parse({
                workspace_id: workspaceId,
                ...(name ? { name } : {}),
                chat_model_config: this.chatModelConfig(agentKey),
            }),
            state: new AgentState({ sessionId }).toJSON(),
        });
    }

    private findDocumentSession(
        documentId: string,
        agentKey: string
    ): Promise<SessionRecord | null> {
        return this.app.storage.getSession(
            this.userId,
            this.documentAgentId(agentKey),
            this.documentSessionId(documentId, agentKey)
        );
    }

    private systemPrompt(agentKey: string, agent: AgentConfig): string {
        const base =
            agentKey === DEFAULT_AGENT_KEY
                ? "You're a helpful assistant named friday."
                : (agent.systemPrompt ?? '');
        return agent.instruction ? `${base}\n\n${agent.instruction}` : base;
    }

    private chatModelConfig(agentKey: string): ChatModelConfig | null {
        const config = this.requireConfig();
        const agent = this.requireAgent(agentKey);
        const modelKey = config.models[agent.modelKey]
            ? agent.modelKey
            : Object.keys(config.models)[0];
        if (!modelKey) return null;
        const model = config.models[modelKey];
        return {
            type: `${model.provider}_credential`,
            credential_id: this.credentialId(modelKey),
            model: model.modelName,
            parameters: { stream: true },
        };
    }

    private async allUserSessions(): Promise<SessionRecord[]> {
        const records = await this.app.storage.listAgents(this.userId);
        return (
            await Promise.all(
                records.map(record => this.app.storage.listSessions(this.userId, record.id))
            )
        ).flat();
    }

    private async findSession(id: string): Promise<SessionRecord | null> {
        return (await this.allUserSessions()).find(item => item.id === id) ?? null;
    }

    private async requireSession(id: string): Promise<SessionRecord> {
        const record = await this.findSession(id);
        if (!record) throw new Error(`Session not found: ${id}`);
        return record;
    }

    private async agentKey(agentId: string): Promise<string> {
        const agent = await this.app.storage.getAgent(this.userId, agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        return agent.data.id;
    }

    private sessionView(record: SessionRecord): Session {
        const ui = this.readSessionUI();
        return {
            id: record.id,
            agentKey: this.configAgentKey(record.agent_id),
            name: record.config.name,
            pinned: ui.pinned[record.id] ?? false,
            createdAt: Date.parse(record.created_at),
            updatedAt: Date.parse(record.updated_at),
        };
    }

    private configAgentKey(agentId: string): string {
        const config = this.requireConfig();
        return (
            Object.keys(config.agents).find(key => this.agentId(key) === agentId) ??
            DEFAULT_AGENT_KEY
        );
    }

    private readSessionUI(): SessionUIData {
        return readJSON<SessionUIData>(this.sessionUIPath, { pinned: {} });
    }

    private setPinned(id: string, pinned: boolean): void {
        const data = this.readSessionUI();
        data.pinned[id] = pinned;
        writeJSON(this.sessionUIPath, data);
    }

    private requireConfig(): Config {
        if (!this.config) throw new Error('Desktop service configuration is not synchronized.');
        return this.config;
    }

    private requireAgent(agentKey: string): AgentConfig {
        const agent = this.requireConfig().agents[agentKey];
        if (!agent) throw new Error(`Agent configuration not found: ${agentKey}`);
        return agent;
    }

    private agentId(agentKey: string): string {
        return stableId('agent', agentKey);
    }

    private documentAgentId(agentKey: string): string {
        return stableId('document-agent', agentKey);
    }

    private documentSessionId(documentId: string, agentKey: string): string {
        return stableId('document', `${documentId}:${agentKey}`);
    }

    private credentialId(modelKey: string): string {
        return stableId('credential', modelKey);
    }
}

function stableId(kind: string, value: string): string {
    return `desktop-${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function documentSystemPrompt(username: string, instruction?: string): string {
    const prompt = `You are a helpful writing assistant named Friday. You're co-editing a Markdown document with the user named ${username}. Your target is to help the user write and edit the document collaboratively.

# Important Notes:
- The 'DocumentRead', 'DocumentWrite' and 'DocumentEdit' tools are used to read and edit the co-edited document, not the filesystem.
- The user's modifications to the document will be wrapped in <user_modification></user_modification> tags.
- The co-edited document is in Markdown format.`;
    return instruction ? `${prompt}\n\n${instruction}` : prompt;
}

function legacyExecutionView(
    middleContext: Record<string, unknown>
): { endTime: number; error?: string; status: 'completed' | 'failed' } | null {
    const value = middleContext.desktop_legacy_execution;
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (
        (candidate.status !== 'completed' && candidate.status !== 'failed') ||
        typeof candidate.end_time !== 'number'
    ) {
        return null;
    }
    return {
        status: candidate.status,
        endTime: candidate.end_time,
        ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
    };
}

function localTimezone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function desktopMCPClient(config: MCPServerConfig): MCPClient {
    return new MCPClient({
        name: config.name,
        isStateful: true,
        mcpConfig:
            config.protocol === 'stdio'
                ? new StdioMCPConfig({
                      command: config.command,
                      args: config.args,
                      env: config.env,
                  })
                : new HttpMCPConfig({ url: config.url, timeout: config.timeout }),
    });
}

function localSkillDirectory(record: SkillRecord): string | null {
    if (!record.url?.startsWith('file:')) return null;
    try {
        return fileURLToPath(record.url);
    } catch {
        return null;
    }
}

function isWithin(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(value: string): Promise<boolean> {
    try {
        await stat(value);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(value: string): Promise<boolean> {
    try {
        return (await stat(value)).isDirectory();
    } catch {
        return false;
    }
}

async function readDirectory(value: string): Promise<Dirent[]> {
    try {
        return await readdir(value, { withFileTypes: true });
    } catch {
        return [];
    }
}
