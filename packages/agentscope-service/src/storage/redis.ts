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
import type { RedisDriver } from './redis-driver';
import { NodeRedisDriver } from './redis-driver';

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
const encodeKeyPart = (value: string) => encodeURIComponent(value);

function titleCredentialType(type: unknown): string {
    if (typeof type !== 'string') return 'Credential';
    const raw = type
        .replace(/_credential$/, '')
        .replaceAll('_', ' ')
        .trim();
    if (!raw) return 'Credential';
    return raw.replace(/\b\w/g, character => character.toUpperCase());
}

export interface RedisStorageOptions {
    driver?: RedisDriver;
    url?: string;
    prefix?: string;
    keyTtlSeconds?: number;
    clientOptions?: Record<string, unknown>;
}

/** Redis-backed Agent Service storage using normalized keys and indexes. */
export class RedisStorage extends StorageBase {
    readonly driver: RedisDriver;
    readonly prefix: string;
    readonly keyTtlSeconds: number | undefined;

    constructor(options: RedisStorageOptions = {}) {
        super();
        this.driver =
            options.driver ??
            new NodeRedisDriver({ url: options.url, clientOptions: options.clientOptions });
        this.prefix = options.prefix ?? 'agentscope';
        this.keyTtlSeconds = options.keyTtlSeconds;
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
        const record = MCPRecordSchema.parse({ ...input, user_id: userId });
        const current = await this.readOwned('mcp', userId, record.id, MCPRecordSchema);
        const nameKey = this.uniqueKey('mcp-name', userId, record.client.name);
        await this.claimUnique(nameKey, record.id, `An MCP named ${record.client.name} exists.`);
        try {
            await this.writeOwned('mcp', userId, record, MCPRecordSchema);
        } catch (error) {
            await this.driver.deleteIfValue(nameKey, record.id);
            throw error;
        }
        if (current && current.client.name !== record.client.name) {
            await this.driver.deleteIfValue(
                this.uniqueKey('mcp-name', userId, current.client.name),
                record.id
            );
        }
        return record.id;
    }

    async listMCPs(userId: string): Promise<MCPRecord[]> {
        return this.listOwned('mcp', userId, MCPRecordSchema);
    }

    async getMCP(userId: string, mcpId: string): Promise<MCPRecord | null> {
        return this.readOwned('mcp', userId, mcpId, MCPRecordSchema);
    }

    async getMCPByName(userId: string, name: string): Promise<MCPRecord | null> {
        const id = await this.driver.get(this.uniqueKey('mcp-name', userId, name));
        return id ? this.getMCP(userId, id) : null;
    }

    async deleteMCP(userId: string, mcpId: string): Promise<boolean> {
        const record = await this.getMCP(userId, mcpId);
        const deleted = await this.deleteOwned('mcp', userId, mcpId, MCPRecordSchema);
        if (record) {
            await this.driver.deleteIfValue(
                this.uniqueKey('mcp-name', userId, record.client.name),
                record.id
            );
        }
        return deleted;
    }

    async upsertSkill(userId: string, input: SkillRecord): Promise<string> {
        const record = SkillRecordSchema.parse({ ...input, user_id: userId });
        const current = await this.readOwned('skill', userId, record.id, SkillRecordSchema);
        const nameKey = this.uniqueKey('skill-name', userId, record.name);
        await this.claimUnique(nameKey, record.id, `A skill named ${record.name} exists.`);
        try {
            await this.writeOwned('skill', userId, record, SkillRecordSchema);
        } catch (error) {
            await this.driver.deleteIfValue(nameKey, record.id);
            throw error;
        }
        if (current && current.name !== record.name) {
            await this.driver.deleteIfValue(
                this.uniqueKey('skill-name', userId, current.name),
                record.id
            );
        }
        return record.id;
    }

    async listSkills(userId: string): Promise<SkillRecord[]> {
        return this.listOwned('skill', userId, SkillRecordSchema);
    }

    async getSkill(userId: string, skillId: string): Promise<SkillRecord | null> {
        return this.readOwned('skill', userId, skillId, SkillRecordSchema);
    }

    async getSkillByName(userId: string, name: string): Promise<SkillRecord | null> {
        const id = await this.driver.get(this.uniqueKey('skill-name', userId, name));
        return id ? this.getSkill(userId, id) : null;
    }

    async deleteSkill(userId: string, skillId: string): Promise<boolean> {
        const record = await this.getSkill(userId, skillId);
        const deleted = await this.deleteOwned('skill', userId, skillId, SkillRecordSchema);
        if (record) {
            await this.driver.deleteIfValue(
                this.uniqueKey('skill-name', userId, record.name),
                record.id
            );
        }
        return deleted;
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
                    updated_at: options.updatedAt ?? currentTimestamp(),
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
            created_at: options.createdAt,
            updated_at: options.updatedAt,
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
        const record = await this.getSession(userId, agentId, sessionId);
        if (!record) return false;
        if (record.team_id) {
            const team = await this.getTeam(userId, record.team_id);
            if (team?.session_id === sessionId) await this.deleteTeam(userId, team.id);
        }
        await this.driver.delete(this.messageKey(userId, sessionId));
        return this.deleteOwned('session', userId, sessionId, SessionRecordSchema);
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
        await this.driver.setAdd(this.globalIndexKey('schedule'), record.id);
        return record.id;
    }

    async getSchedule(userId: string, scheduleId: string): Promise<ScheduleRecord | null> {
        return this.readOwned('schedule', userId, scheduleId, ScheduleRecordSchema);
    }

    async listSchedules(userId: string): Promise<ScheduleRecord[]> {
        return this.listOwned('schedule', userId, ScheduleRecordSchema);
    }

    async listAllSchedules(): Promise<ScheduleRecord[]> {
        return this.listGlobal('schedule', ScheduleRecordSchema);
    }

    async deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
        const record = await this.getSchedule(userId, scheduleId);
        if (!record) return false;
        for (const session of await this.listSessionsBySchedule(userId, scheduleId)) {
            await this.deleteSession(userId, record.agent_id, session.id);
        }
        const deleted = await this.deleteOwned(
            'schedule',
            userId,
            scheduleId,
            ScheduleRecordSchema
        );
        await this.driver.setRemove(this.globalIndexKey('schedule'), scheduleId);
        return deleted;
    }

    async upsertChannel(input: ChannelRecord, platformBotId: string): Promise<string> {
        const record = ChannelRecordSchema.parse(input);
        const botKey = this.botKey(platformBotId);
        await this.claimUnique(
            botKey,
            record.id,
            `Bot ${platformBotId} already drives another channel.`
        );
        const previousBot = await this.driver.get(this.channelBotKey(record.id));
        try {
            await this.writeOwned('channel', record.user_id, record, ChannelRecordSchema);
        } catch (error) {
            await this.driver.deleteIfValue(botKey, record.id);
            throw error;
        }
        await this.driver.set(this.channelBotKey(record.id), platformBotId);
        await this.driver.setAdd(this.globalIndexKey('channel'), record.id);
        if (previousBot && previousBot !== platformBotId) {
            await this.driver.deleteIfValue(this.botKey(previousBot), record.id);
        }
        return record.id;
    }

    async getChannel(channelId: string): Promise<ChannelRecord | null> {
        return this.readRecord('channel', channelId, ChannelRecordSchema);
    }

    async listChannels(userId: string): Promise<ChannelRecord[]> {
        return this.listOwned('channel', userId, ChannelRecordSchema);
    }

    async listAllChannels(): Promise<ChannelRecord[]> {
        return this.listGlobal('channel', ChannelRecordSchema);
    }

    async deleteChannel(channelId: string, _platformBotId: string): Promise<boolean> {
        const record = await this.getChannel(channelId);
        if (!record) return false;
        const bot = await this.driver.get(this.channelBotKey(channelId));
        const deleted = await this.deleteOwned(
            'channel',
            record.user_id,
            channelId,
            ChannelRecordSchema
        );
        await this.driver.setRemove(this.globalIndexKey('channel'), channelId);
        await this.driver.delete(this.channelBotKey(channelId));
        if (bot) await this.driver.deleteIfValue(this.botKey(bot), channelId);
        return deleted;
    }

    async getChannelIdByPlatformBotId(platformBotId: string): Promise<string | null> {
        return this.driver.get(this.botKey(platformBotId));
    }

    async upsertMessage(userId: string, sessionId: string, message: Msg): Promise<void> {
        const key = this.messageKey(userId, sessionId);
        const length = await this.driver.listLength(key);
        for (let index = length - 1; index >= 0; index -= 1) {
            const raw = await this.driver.listIndex(key, index);
            if (raw && parseMsg(JSON.parse(raw)).id === message.id) {
                await this.driver.listSet(key, index, JSON.stringify(message));
                if (this.keyTtlSeconds !== undefined) {
                    await this.driver.expire(key, this.keyTtlSeconds);
                }
                return;
            }
        }
        await this.driver.listPush(key, JSON.stringify(message));
        if (this.keyTtlSeconds !== undefined) await this.driver.expire(key, this.keyTtlSeconds);
    }

    async getMessage(userId: string, sessionId: string, messageId: string): Promise<Msg | null> {
        const key = this.messageKey(userId, sessionId);
        for (let index = (await this.driver.listLength(key)) - 1; index >= 0; index -= 1) {
            const raw = await this.driver.listIndex(key, index);
            if (raw) {
                const message = parseMsg(JSON.parse(raw));
                if (message.id === messageId) return message;
            }
        }
        return null;
    }

    async listMessages(
        userId: string,
        sessionId: string,
        options: { limit?: number; before?: string } = {}
    ): Promise<MessagePage> {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be non-negative.');
        const key = this.messageKey(userId, sessionId);
        const total = await this.driver.listLength(key);
        let end = total - 1;
        if (options.before !== undefined) {
            end = -1;
            for (let index = total - 1; index >= 0; index -= 1) {
                const raw = await this.driver.listIndex(key, index);
                if (raw && parseMsg(JSON.parse(raw)).id === options.before) {
                    end = index - 1;
                    break;
                }
            }
            if (end === -1) return { messages: [], hasMore: false };
        }
        if (end < 0 || limit === 0) return { messages: [], hasMore: end >= 0 };
        const start = Math.max(0, end - limit + 1);
        const raw = await this.driver.listRange(key, start, end);
        return {
            messages: raw.map(value => parseMsg(JSON.parse(value))),
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
        const stored = await this.writeOwned(
            'knowledge-document',
            userId,
            record,
            KnowledgeDocumentRecordSchema
        );
        await this.driver.setAdd(this.globalIndexKey('knowledge-document'), record.id);
        return stored;
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
        const deleted = await this.deleteOwned(
            'knowledge-document',
            userId,
            documentId,
            KnowledgeDocumentRecordSchema
        );
        await this.driver.setRemove(this.globalIndexKey('knowledge-document'), documentId);
        return deleted;
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
        return (await this.listGlobal('knowledge-document', KnowledgeDocumentRecordSchema)).filter(
            record =>
                record.status !== 'ready' &&
                record.status !== 'error' &&
                record.processing_node !== null &&
                record.lease_expires_at !== null &&
                new Date(record.lease_expires_at) < current
        );
    }

    async listKnowledgeDocumentsPendingSince(threshold: Date): Promise<KnowledgeDocumentRecord[]> {
        return (await this.listGlobal('knowledge-document', KnowledgeDocumentRecordSchema)).filter(
            record => record.status === 'pending' && new Date(record.created_at) < threshold
        );
    }

    private async updateLease(
        options: Omit<KnowledgeDocumentLeaseOptions, 'leaseTtlMs' | 'now'>,
        update: (record: KnowledgeDocumentRecord) => KnowledgeDocumentRecord | null
    ): Promise<boolean> {
        const key = this.recordKey('knowledge-document', options.documentId);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const raw = await this.driver.get(key);
            if (!raw) return false;
            const record = KnowledgeDocumentRecordSchema.parse(JSON.parse(raw));
            if (
                record.user_id !== options.userId ||
                record.knowledge_base_id !== options.knowledgeBaseId
            ) {
                return false;
            }
            const next = update(record);
            if (!next) return false;
            if (
                await this.driver.compareAndSet(key, raw, JSON.stringify(next), this.keyTtlSeconds)
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
        const key = this.recordKey(kind, input.id);
        let raw = await this.driver.get(key);
        let record = schema.parse(input);
        if (raw) {
            const current = schema.parse(JSON.parse(raw));
            if (current.user_id !== userId) {
                throw new StorageConflictError(`The ${kind} id is owned by another user.`);
            }
            record = touchRecord(record);
            record.created_at = current.created_at;
            await this.driver.set(key, JSON.stringify(record), this.keyTtlSeconds);
        } else {
            record = touchRecord(record);
            if (
                !(await this.driver.compareAndSet(
                    key,
                    null,
                    JSON.stringify(record),
                    this.keyTtlSeconds
                ))
            ) {
                raw = await this.driver.get(key);
                if (!raw || schema.parse(JSON.parse(raw)).user_id !== userId) {
                    throw new StorageConflictError(`The ${kind} id is owned by another user.`);
                }
                return this.writeOwned(kind, userId, record, schema);
            }
        }
        await this.driver.setAdd(this.userIndexKey(kind, userId), record.id);
        return cloneRecord(record);
    }

    private async readRecord<T>(
        kind: RecordKind,
        id: string,
        schema: RecordSchema<T>
    ): Promise<T | null> {
        const raw = await this.driver.get(this.recordKey(kind, id));
        return raw ? schema.parse(JSON.parse(raw)) : null;
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
        const indexKey = this.userIndexKey(kind, userId);
        const records: T[] = [];
        const stale: string[] = [];
        for (const id of await this.driver.setMembers(indexKey)) {
            const record = await this.readOwned(kind, userId, id, schema);
            if (record) records.push(record);
            else stale.push(id);
        }
        if (stale.length > 0) await this.driver.setRemove(indexKey, ...stale);
        return records;
    }

    private async listGlobal<T>(kind: RecordKind, schema: RecordSchema<T>): Promise<T[]> {
        const indexKey = this.globalIndexKey(kind);
        const records: T[] = [];
        const stale: string[] = [];
        for (const id of await this.driver.setMembers(indexKey)) {
            const record = await this.readRecord(kind, id, schema);
            if (record) records.push(record);
            else stale.push(id);
        }
        if (stale.length > 0) await this.driver.setRemove(indexKey, ...stale);
        return records;
    }

    private async deleteOwned<T extends RecordWithOwner>(
        kind: RecordKind,
        userId: string,
        id: string,
        schema: RecordSchema<T>
    ): Promise<boolean> {
        if (!(await this.readOwned(kind, userId, id, schema))) return false;
        const deleted = await this.driver.delete(this.recordKey(kind, id));
        await this.driver.setRemove(this.userIndexKey(kind, userId), id);
        return deleted;
    }

    private async claimUnique(key: string, id: string, message: string): Promise<void> {
        const holder = await this.driver.get(key);
        if (holder === id) return;
        if (holder !== null || !(await this.driver.compareAndSet(key, null, id))) {
            throw new StorageConflictError(message);
        }
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

    private recordKey(kind: RecordKind, id: string): string {
        return `${this.prefix}:record:${kind}:${encodeKeyPart(id)}`;
    }

    private userIndexKey(kind: RecordKind, userId: string): string {
        return `${this.prefix}:user:${encodeKeyPart(userId)}:${kind}s`;
    }

    private globalIndexKey(kind: RecordKind): string {
        return `${this.prefix}:all:${kind}s`;
    }

    private uniqueKey(kind: string, userId: string, value: string): string {
        return `${this.prefix}:user:${encodeKeyPart(userId)}:${kind}:${encodeKeyPart(value)}`;
    }

    private messageKey(userId: string, sessionId: string): string {
        return `${this.prefix}:user:${encodeKeyPart(userId)}:session:${encodeKeyPart(sessionId)}:messages`;
    }

    private botKey(botId: string): string {
        return `${this.prefix}:channel-bot:${encodeKeyPart(botId)}`;
    }

    private channelBotKey(channelId: string): string {
        return `${this.prefix}:channel:${encodeKeyPart(channelId)}:bot`;
    }
}
