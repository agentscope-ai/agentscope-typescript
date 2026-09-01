/* eslint-disable jsdoc/require-jsdoc */

import type { CredentialBase } from '@agentscope-ai/agentscope/credential';
import type { Msg } from '@agentscope-ai/agentscope/message';
import { parseMsg } from '@agentscope-ai/agentscope/message';
import { AgentState } from '@agentscope-ai/agentscope/state';
import type { AgentStateWire } from '@agentscope-ai/agentscope/state';

import {
    KnowledgeDocumentLeaseOptions,
    MessagePage,
    StorageBase,
    StorageConflictError,
    UpsertSessionOptions,
} from './base';
import {
    AgentRecord,
    AgentRecordSchema,
    ChannelRecord,
    ChannelRecordSchema,
    CredentialRecord,
    CredentialRecordSchema,
    KnowledgeBaseRecord,
    KnowledgeBaseRecordSchema,
    KnowledgeDocumentRecord,
    KnowledgeDocumentRecordSchema,
    KnowledgeDocumentStatus,
    MCPRecord,
    MCPRecordSchema,
    RecordEnvelope,
    ScheduleRecord,
    ScheduleRecordSchema,
    SessionRecord,
    SessionRecordSchema,
    SkillRecord,
    SkillRecordSchema,
    TeamMember,
    TeamRecord,
    TeamRecordSchema,
    cloneRecord,
    touchRecord,
} from './records';
import { BetterSQLiteDriver } from './sql-driver';
import type { SQLRecordRow, SQLStorageDriver } from './sql-driver';

type RecordWithOwner = RecordEnvelope & { user_id: string };
type RecordSchema<T> = { parse(input: unknown): T };
type RecordKind =
    | 'credential'
    | 'mcp'
    | 'skill'
    | 'agent'
    | 'session'
    | 'schedule'
    | 'channel'
    | 'team'
    | 'knowledge-base'
    | 'knowledge-document';

const currentTimestamp = () => new Date().toISOString();

function titleCredentialType(type: unknown): string {
    if (typeof type !== 'string') return 'Credential';
    const raw = type
        .replace(/_credential$/, '')
        .replaceAll('_', ' ')
        .trim();
    if (!raw) return 'Credential';
    return raw.replace(/\b\w/g, character => character.toUpperCase());
}

export interface SQLStorageOptions {
    driver?: SQLStorageDriver;
    filename?: string;
    databaseOptions?: Record<string, unknown>;
}

/** Transactional relational storage for Agent Service records. */
export class SQLStorage extends StorageBase {
    readonly driver: SQLStorageDriver;

    constructor(options: SQLStorageOptions = {}) {
        super();
        this.driver =
            options.driver ??
            new BetterSQLiteDriver({
                filename: options.filename,
                databaseOptions: options.databaseOptions,
            });
    }

    async open(): Promise<this> {
        await this.driver.open();
        return this;
    }

    async close(): Promise<void> {
        await this.driver.close();
    }

    async upsertCredential(userId: string, credential: CredentialBase): Promise<string> {
        const current = await this.readOwned(
            'credential',
            userId,
            credential.id,
            CredentialRecordSchema
        );
        const data = cloneRecord(credential.toJSON());
        if (!data.name) {
            const baseName = titleCredentialType(data.type);
            const names = new Set(
                (await this.listCredentials(userId))
                    .filter(record => record.id !== credential.id)
                    .map(record => record.data.name)
                    .filter((name): name is string => typeof name === 'string')
            );
            let name = baseName;
            for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} (${suffix})`;
            data.name = name;
        }
        const record = CredentialRecordSchema.parse({
            id: credential.id,
            user_id: userId,
            data,
            created_at: current?.created_at,
            updated_at: currentTimestamp(),
        });
        await this.writeOwned('credential', userId, record, CredentialRecordSchema);
        return record.id;
    }

    async listCredentials(userId: string): Promise<CredentialRecord[]> {
        return this.listOwned('credential', userId, CredentialRecordSchema);
    }

    async getCredential(userId: string, credentialId: string): Promise<CredentialRecord | null> {
        return this.readOwned('credential', userId, credentialId, CredentialRecordSchema);
    }

    async deleteCredential(userId: string, credentialId: string): Promise<boolean> {
        return this.deleteOwned('credential', userId, credentialId, CredentialRecordSchema);
    }

    async upsertMCP(userId: string, input: MCPRecord): Promise<string> {
        return this.driver.transaction(async () => {
            const record = MCPRecordSchema.parse({ ...input, user_id: userId });
            const current = await this.readOwned('mcp', userId, record.id, MCPRecordSchema);
            await this.claimUnique(
                'mcp-name',
                userId,
                record.client.name,
                record.id,
                `An MCP named ${record.client.name} exists.`
            );
            try {
                await this.writeOwned('mcp', userId, record, MCPRecordSchema);
            } catch (error) {
                await this.driver.releaseUnique('mcp-name', userId, record.client.name, record.id);
                throw error;
            }
            if (current && current.client.name !== record.client.name) {
                await this.driver.releaseUnique('mcp-name', userId, current.client.name, record.id);
            }
            return record.id;
        });
    }

    async listMCPs(userId: string): Promise<MCPRecord[]> {
        return this.listOwned('mcp', userId, MCPRecordSchema);
    }

    async getMCP(userId: string, mcpId: string): Promise<MCPRecord | null> {
        return this.readOwned('mcp', userId, mcpId, MCPRecordSchema);
    }

    async getMCPByName(userId: string, name: string): Promise<MCPRecord | null> {
        const id = await this.driver.getUnique('mcp-name', userId, name);
        return id ? this.getMCP(userId, id) : null;
    }

    async deleteMCP(userId: string, mcpId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const record = await this.getMCP(userId, mcpId);
            const deleted = await this.deleteOwned('mcp', userId, mcpId, MCPRecordSchema);
            if (record) {
                await this.driver.releaseUnique('mcp-name', userId, record.client.name, record.id);
            }
            return deleted;
        });
    }

    async upsertSkill(userId: string, input: SkillRecord): Promise<string> {
        return this.driver.transaction(async () => {
            const record = SkillRecordSchema.parse({ ...input, user_id: userId });
            const current = await this.readOwned('skill', userId, record.id, SkillRecordSchema);
            await this.claimUnique(
                'skill-name',
                userId,
                record.name,
                record.id,
                `A skill named ${record.name} exists.`
            );
            try {
                await this.writeOwned('skill', userId, record, SkillRecordSchema);
            } catch (error) {
                await this.driver.releaseUnique('skill-name', userId, record.name, record.id);
                throw error;
            }
            if (current && current.name !== record.name) {
                await this.driver.releaseUnique('skill-name', userId, current.name, record.id);
            }
            return record.id;
        });
    }

    async listSkills(userId: string): Promise<SkillRecord[]> {
        return this.listOwned('skill', userId, SkillRecordSchema);
    }

    async getSkill(userId: string, skillId: string): Promise<SkillRecord | null> {
        return this.readOwned('skill', userId, skillId, SkillRecordSchema);
    }

    async getSkillByName(userId: string, name: string): Promise<SkillRecord | null> {
        const id = await this.driver.getUnique('skill-name', userId, name);
        return id ? this.getSkill(userId, id) : null;
    }

    async deleteSkill(userId: string, skillId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const record = await this.getSkill(userId, skillId);
            const deleted = await this.deleteOwned('skill', userId, skillId, SkillRecordSchema);
            if (record) {
                await this.driver.releaseUnique('skill-name', userId, record.name, record.id);
            }
            return deleted;
        });
    }

    async upsertAgent(userId: string, input: AgentRecord): Promise<string> {
        const record = AgentRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        await this.writeOwned('agent', userId, record, AgentRecordSchema);
        return record.id;
    }

    async listAgents(userId: string): Promise<AgentRecord[]> {
        return (await this.listOwned('agent', userId, AgentRecordSchema)).filter(
            record => record.source === 'user'
        );
    }

    async getAgent(userId: string, agentId: string): Promise<AgentRecord | null> {
        return this.readOwned('agent', userId, agentId, AgentRecordSchema);
    }

    async deleteAgent(userId: string, agentId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            if (!(await this.getAgent(userId, agentId))) return false;
            for (const session of await this.listSessions(userId, agentId)) {
                await this.deleteSession(userId, agentId, session.id);
            }
            for (const schedule of await this.listSchedules(userId)) {
                if (schedule.agent_id === agentId) await this.deleteSchedule(userId, schedule.id);
            }
            for (const team of await this.listTeams(userId)) {
                const memberIds = team.data.member_ids.filter(id => id !== agentId);
                const members = team.data.members.filter(member => member.agent_id !== agentId);
                if (
                    memberIds.length !== team.data.member_ids.length ||
                    members.length !== team.data.members.length
                ) {
                    await this.upsertTeam(userId, {
                        ...team,
                        data: { ...team.data, member_ids: memberIds, members },
                    });
                }
            }
            return this.deleteOwned('agent', userId, agentId, AgentRecordSchema);
        });
    }

    async upsertSession(options: UpsertSessionOptions): Promise<SessionRecord> {
        if (options.sessionId) {
            const current = await this.readOwned(
                'session',
                options.userId,
                options.sessionId,
                SessionRecordSchema
            );
            if (current) {
                const updated = SessionRecordSchema.parse({
                    ...current,
                    config: options.config,
                    state: options.state ?? current.state,
                    updated_at: currentTimestamp(),
                }) as SessionRecord;
                await this.writeOwned('session', options.userId, updated, SessionRecordSchema);
                return updated;
            }
        }
        const record = SessionRecordSchema.parse({
            id: options.sessionId,
            user_id: options.userId,
            agent_id: options.agentId,
            config: options.config,
            state: options.state ?? new AgentState().toJSON(),
            source: options.source,
            source_schedule_id: options.sourceScheduleId,
            source_chat_id: options.sourceChatId,
            source_chat_name: options.sourceChatName,
            source_channel_id: options.sourceChannelId,
        }) as SessionRecord;
        await this.writeOwned('session', options.userId, record, SessionRecordSchema);
        return record;
    }

    async setSessionTeamId(
        userId: string,
        sessionId: string,
        teamId: string | null
    ): Promise<void> {
        const record = await this.readOwned('session', userId, sessionId, SessionRecordSchema);
        if (!record || record.team_id === teamId) return;
        await this.writeOwned(
            'session',
            userId,
            { ...record, team_id: teamId, updated_at: currentTimestamp() },
            SessionRecordSchema
        );
    }

    async updateSessionState(
        userId: string,
        _agentId: string,
        sessionId: string,
        state: AgentStateWire
    ): Promise<void> {
        const record = await this.readOwned('session', userId, sessionId, SessionRecordSchema);
        if (!record) throw new Error(`Session ${JSON.stringify(sessionId)} not found.`);
        await this.writeOwned(
            'session',
            userId,
            { ...record, state, updated_at: currentTimestamp() },
            SessionRecordSchema
        );
    }

    async listSessions(userId: string, agentId: string): Promise<SessionRecord[]> {
        return this.sortSessions(
            (await this.listOwned('session', userId, SessionRecordSchema)).filter(
                record => record.agent_id === agentId
            )
        );
    }

    async getSession(
        userId: string,
        _agentId: string,
        sessionId: string
    ): Promise<SessionRecord | null> {
        return this.readOwned('session', userId, sessionId, SessionRecordSchema);
    }

    async deleteSession(userId: string, agentId: string, sessionId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const record = await this.getSession(userId, agentId, sessionId);
            if (!record) return false;
            if (record.team_id) {
                const team = await this.getTeam(userId, record.team_id);
                if (team?.session_id === sessionId) await this.deleteTeam(userId, team.id);
            }
            await this.driver.deleteMessages(userId, sessionId);
            return this.deleteOwned('session', userId, sessionId, SessionRecordSchema);
        });
    }

    async listSessionsBySchedule(userId: string, scheduleId: string): Promise<SessionRecord[]> {
        return this.sortSessions(
            (await this.listOwned('session', userId, SessionRecordSchema)).filter(
                record => record.source_schedule_id === scheduleId
            )
        );
    }

    async listSessionsByChannel(userId: string, channelId: string): Promise<SessionRecord[]> {
        return this.sortSessions(
            (await this.listOwned('session', userId, SessionRecordSchema)).filter(
                record => record.source_channel_id === channelId
            )
        );
    }

    async upsertSchedule(userId: string, input: ScheduleRecord): Promise<string> {
        const record = ScheduleRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        await this.writeOwned('schedule', userId, record, ScheduleRecordSchema);
        return record.id;
    }

    async getSchedule(userId: string, scheduleId: string): Promise<ScheduleRecord | null> {
        return this.readOwned('schedule', userId, scheduleId, ScheduleRecordSchema);
    }

    async listSchedules(userId: string): Promise<ScheduleRecord[]> {
        return this.listOwned('schedule', userId, ScheduleRecordSchema);
    }

    async listAllSchedules(): Promise<ScheduleRecord[]> {
        return this.listAll('schedule', ScheduleRecordSchema);
    }

    async deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const record = await this.getSchedule(userId, scheduleId);
            if (!record) return false;
            for (const session of await this.listSessionsBySchedule(userId, scheduleId)) {
                await this.deleteSession(userId, record.agent_id, session.id);
            }
            return this.deleteOwned('schedule', userId, scheduleId, ScheduleRecordSchema);
        });
    }

    async upsertChannel(input: ChannelRecord, platformBotId: string): Promise<string> {
        return this.driver.transaction(async () => {
            const record = ChannelRecordSchema.parse(input);
            await this.claimUnique(
                'channel-bot',
                '',
                platformBotId,
                record.id,
                `Bot ${platformBotId} already drives another channel.`
            );
            const previousBot = await this.findChannelBot(record.id);
            try {
                await this.writeOwned('channel', record.user_id, record, ChannelRecordSchema);
            } catch (error) {
                await this.driver.releaseUnique('channel-bot', '', platformBotId, record.id);
                throw error;
            }
            if (previousBot && previousBot !== platformBotId) {
                await this.driver.releaseUnique('channel-binding', '', record.id, previousBot);
            }
            await this.claimUnique(
                'channel-binding',
                '',
                record.id,
                platformBotId,
                `Channel ${record.id} already has another bot binding.`
            );
            if (previousBot && previousBot !== platformBotId) {
                await this.driver.releaseUnique('channel-bot', '', previousBot, record.id);
            }
            return record.id;
        });
    }

    async getChannel(channelId: string): Promise<ChannelRecord | null> {
        return this.readRecord('channel', channelId, ChannelRecordSchema);
    }

    async listChannels(userId: string): Promise<ChannelRecord[]> {
        return this.listOwned('channel', userId, ChannelRecordSchema);
    }

    async listAllChannels(): Promise<ChannelRecord[]> {
        return this.listAll('channel', ChannelRecordSchema);
    }

    async deleteChannel(channelId: string, _platformBotId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const record = await this.getChannel(channelId);
            if (!record) return false;
            const bot = await this.findChannelBot(channelId);
            const deleted = await this.deleteOwned(
                'channel',
                record.user_id,
                channelId,
                ChannelRecordSchema
            );
            if (bot) {
                await this.driver.releaseUnique('channel-bot', '', bot, channelId);
                await this.driver.releaseUnique('channel-binding', '', channelId, bot);
            }
            return deleted;
        });
    }

    async getChannelIdByPlatformBotId(platformBotId: string): Promise<string | null> {
        return this.driver.getUnique('channel-bot', '', platformBotId);
    }

    async upsertMessage(userId: string, sessionId: string, message: Msg): Promise<void> {
        await this.driver.upsertMessage(userId, sessionId, message.id, JSON.stringify(message));
    }

    async getMessage(userId: string, sessionId: string, messageId: string): Promise<Msg | null> {
        const row = (await this.driver.getMessages(userId, sessionId)).find(
            message => message.messageId === messageId
        );
        return row ? parseMsg(JSON.parse(row.payload)) : null;
    }

    async listMessages(
        userId: string,
        sessionId: string,
        options: { limit?: number; before?: string } = {}
    ): Promise<MessagePage> {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be non-negative.');
        const rows = await this.driver.getMessages(userId, sessionId);
        let end = rows.length;
        if (options.before !== undefined) {
            end = rows.findIndex(row => row.messageId === options.before);
            if (end < 0) return { messages: [], hasMore: false };
        }
        if (limit === 0) return { messages: [], hasMore: end > 0 };
        const start = Math.max(0, end - limit);
        return {
            messages: rows.slice(start, end).map(row => parseMsg(JSON.parse(row.payload))),
            hasMore: start > 0,
        };
    }

    async upsertTeam(userId: string, input: TeamRecord): Promise<TeamRecord> {
        const record = TeamRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        return this.writeOwned('team', userId, record, TeamRecordSchema);
    }

    async getTeam(userId: string, teamId: string): Promise<TeamRecord | null> {
        return this.readOwned('team', userId, teamId, TeamRecordSchema);
    }

    async listTeams(userId: string): Promise<TeamRecord[]> {
        return this.listOwned('team', userId, TeamRecordSchema);
    }

    async deleteTeam(userId: string, teamId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            const team = await this.getTeam(userId, teamId);
            if (!team) return false;
            for (const member of await this.ensureTeamMembers(userId, team)) {
                if (member.role === 'created') {
                    await this.deleteAgent(member.owner_id, member.agent_id);
                } else {
                    await this.deleteSession(member.owner_id, member.agent_id, member.session_id);
                }
            }
            await this.setSessionTeamId(userId, team.session_id, null);
            return this.deleteOwned('team', userId, teamId, TeamRecordSchema);
        });
    }

    async upsertKnowledgeBase(
        userId: string,
        input: KnowledgeBaseRecord
    ): Promise<KnowledgeBaseRecord> {
        const record = KnowledgeBaseRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        return this.writeOwned('knowledge-base', userId, record, KnowledgeBaseRecordSchema);
    }

    async getKnowledgeBase(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeBaseRecord | null> {
        return this.readOwned('knowledge-base', userId, knowledgeBaseId, KnowledgeBaseRecordSchema);
    }

    async listKnowledgeBases(userId: string): Promise<KnowledgeBaseRecord[]> {
        return this.listOwned('knowledge-base', userId, KnowledgeBaseRecordSchema);
    }

    async deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<boolean> {
        return this.driver.transaction(async () => {
            if (!(await this.getKnowledgeBase(userId, knowledgeBaseId))) return false;
            for (const document of await this.listKnowledgeDocuments(userId, knowledgeBaseId)) {
                await this.deleteKnowledgeDocument(userId, knowledgeBaseId, document.id);
            }
            return this.deleteOwned(
                'knowledge-base',
                userId,
                knowledgeBaseId,
                KnowledgeBaseRecordSchema
            );
        });
    }

    async upsertKnowledgeDocument(
        userId: string,
        input: KnowledgeDocumentRecord
    ): Promise<KnowledgeDocumentRecord> {
        const record = KnowledgeDocumentRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        if (!(await this.getKnowledgeBase(userId, record.knowledge_base_id))) {
            throw new StorageConflictError(
                `Knowledge base ${record.knowledge_base_id} does not exist.`
            );
        }
        return this.writeOwned('knowledge-document', userId, record, KnowledgeDocumentRecordSchema);
    }

    async getKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<KnowledgeDocumentRecord | null> {
        const record = await this.readOwned(
            'knowledge-document',
            userId,
            documentId,
            KnowledgeDocumentRecordSchema
        );
        return record?.knowledge_base_id === knowledgeBaseId ? record : null;
    }

    async listKnowledgeDocuments(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeDocumentRecord[]> {
        return (
            await this.listOwned('knowledge-document', userId, KnowledgeDocumentRecordSchema)
        ).filter(record => record.knowledge_base_id === knowledgeBaseId);
    }

    async deleteKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<boolean> {
        if (!(await this.getKnowledgeDocument(userId, knowledgeBaseId, documentId))) return false;
        return this.deleteOwned(
            'knowledge-document',
            userId,
            documentId,
            KnowledgeDocumentRecordSchema
        );
    }

    async updateKnowledgeDocumentStatus(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        status: KnowledgeDocumentStatus,
        options: { error?: string; chunkCount?: number } = {}
    ): Promise<void> {
        const record = await this.getKnowledgeDocument(userId, knowledgeBaseId, documentId);
        if (!record) return;
        record.status = status;
        if (options.error !== undefined) record.data.error = options.error;
        if (options.chunkCount !== undefined) record.data.chunk_count = options.chunkCount;
        record.updated_at = currentTimestamp();
        await this.writeOwned('knowledge-document', userId, record, KnowledgeDocumentRecordSchema);
    }

    async acquireKnowledgeDocumentLease(options: KnowledgeDocumentLeaseOptions): Promise<boolean> {
        const current = options.now ?? new Date();
        return this.updateLease(options, record => {
            if (
                record.processing_node !== null &&
                record.lease_expires_at !== null &&
                new Date(record.lease_expires_at) > current
            ) {
                return null;
            }
            record.processing_node = options.processingNode;
            record.lease_expires_at = new Date(
                current.getTime() + options.leaseTtlMs
            ).toISOString();
            record.updated_at = current.toISOString();
            return record;
        });
    }

    async renewKnowledgeDocumentLease(options: KnowledgeDocumentLeaseOptions): Promise<boolean> {
        const current = options.now ?? new Date();
        return this.updateLease(options, record => {
            if (record.processing_node !== options.processingNode) return null;
            record.lease_expires_at = new Date(
                current.getTime() + options.leaseTtlMs
            ).toISOString();
            record.updated_at = current.toISOString();
            return record;
        });
    }

    async releaseKnowledgeDocumentLease(
        options: Omit<KnowledgeDocumentLeaseOptions, 'leaseTtlMs' | 'now'>
    ): Promise<void> {
        await this.updateLease(options, record => {
            if (record.processing_node !== options.processingNode) return null;
            record.processing_node = null;
            record.lease_expires_at = null;
            record.updated_at = currentTimestamp();
            return record;
        });
    }

    async listKnowledgeDocumentsWithExpiredLease(
        current = new Date()
    ): Promise<KnowledgeDocumentRecord[]> {
        return (await this.listAll('knowledge-document', KnowledgeDocumentRecordSchema)).filter(
            record =>
                record.status !== 'ready' &&
                record.status !== 'error' &&
                record.processing_node !== null &&
                record.lease_expires_at !== null &&
                new Date(record.lease_expires_at) < current
        );
    }

    async listKnowledgeDocumentsPendingSince(threshold: Date): Promise<KnowledgeDocumentRecord[]> {
        return (await this.listAll('knowledge-document', KnowledgeDocumentRecordSchema)).filter(
            record => record.status === 'pending' && new Date(record.created_at) < threshold
        );
    }

    private async updateLease(
        options: Omit<KnowledgeDocumentLeaseOptions, 'leaseTtlMs' | 'now'>,
        update: (record: KnowledgeDocumentRecord) => KnowledgeDocumentRecord | null
    ): Promise<boolean> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const row = await this.driver.getRecord('knowledge-document', options.documentId);
            if (!row) return false;
            const record = KnowledgeDocumentRecordSchema.parse(JSON.parse(row.payload));
            if (
                record.user_id !== options.userId ||
                record.knowledge_base_id !== options.knowledgeBaseId
            ) {
                return false;
            }
            const next = update(record);
            if (!next) return false;
            const payload = JSON.stringify(next);
            if (
                await this.driver.compareAndSetRecord(
                    this.toRow('knowledge-document', next, payload),
                    row.payload
                )
            ) {
                return true;
            }
        }
        return false;
    }

    private async writeOwned<T extends RecordWithOwner>(
        kind: RecordKind,
        userId: string,
        input: T,
        schema: RecordSchema<T>
    ): Promise<T> {
        this.assertMatchingOwner(input, userId);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const currentRow = await this.driver.getRecord(kind, input.id);
            let record = touchRecord(schema.parse(input));
            if (currentRow) {
                const current = schema.parse(JSON.parse(currentRow.payload));
                if (current.user_id !== userId) {
                    throw new StorageConflictError(`The ${kind} id is owned by another user.`);
                }
                record.created_at = current.created_at;
            }
            const payload = JSON.stringify(record);
            if (
                await this.driver.compareAndSetRecord(
                    this.toRow(kind, record, payload),
                    currentRow?.payload ?? null
                )
            ) {
                return cloneRecord(record);
            }
        }
        throw new StorageConflictError(`Concurrent ${kind} update did not converge.`);
    }

    private async readRecord<T>(
        kind: RecordKind,
        id: string,
        schema: RecordSchema<T>
    ): Promise<T | null> {
        const row = await this.driver.getRecord(kind, id);
        return row ? schema.parse(JSON.parse(row.payload)) : null;
    }

    private async readOwned<T extends RecordWithOwner>(
        kind: RecordKind,
        userId: string,
        id: string,
        schema: RecordSchema<T>
    ): Promise<T | null> {
        const record = await this.readRecord(kind, id, schema);
        return record?.user_id === userId ? cloneRecord(record) : null;
    }

    private async listOwned<T extends RecordWithOwner>(
        kind: RecordKind,
        userId: string,
        schema: RecordSchema<T>
    ): Promise<T[]> {
        return (await this.driver.listRecords(kind, userId)).map(row =>
            cloneRecord(schema.parse(JSON.parse(row.payload)))
        );
    }

    private async listAll<T>(kind: RecordKind, schema: RecordSchema<T>): Promise<T[]> {
        return (await this.driver.listRecords(kind)).map(row =>
            cloneRecord(schema.parse(JSON.parse(row.payload)))
        );
    }

    private async deleteOwned<T extends RecordWithOwner>(
        kind: RecordKind,
        userId: string,
        id: string,
        schema: RecordSchema<T>
    ): Promise<boolean> {
        if (!(await this.readOwned(kind, userId, id, schema))) return false;
        return this.driver.deleteRecord(kind, id, userId);
    }

    private async claimUnique(
        namespace: string,
        scope: string,
        value: string,
        ownerId: string,
        message: string
    ): Promise<void> {
        if (!(await this.driver.claimUnique(namespace, scope, value, ownerId))) {
            throw new StorageConflictError(message);
        }
    }

    private async findChannelBot(channelId: string): Promise<string | null> {
        return this.driver.getUnique('channel-binding', '', channelId);
    }

    private toRow(kind: RecordKind, record: RecordWithOwner, payload: string): SQLRecordRow {
        return {
            kind,
            id: record.id,
            userId: record.user_id,
            payload,
            createdAt: record.created_at,
            updatedAt: record.updated_at,
        };
    }

    private assertMatchingOwner(record: { user_id: string }, userId: string): void {
        if (record.user_id !== userId) {
            throw new StorageConflictError('record.user_id does not match the given userId.');
        }
    }

    private async ensureTeamMembers(userId: string, team: TeamRecord): Promise<TeamMember[]> {
        if (team.data.members.length > 0) return team.data.members;
        if (team.data.member_ids.length === 0) return [];
        const members: TeamMember[] = [];
        for (const agentId of team.data.member_ids) {
            const session = (await this.listSessions(userId, agentId))[0];
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
        await this.upsertTeam(userId, team);
        return members;
    }

    private sortSessions(records: SessionRecord[]): SessionRecord[] {
        return records.sort((left, right) => right.created_at.localeCompare(left.created_at));
    }
}
