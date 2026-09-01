/* eslint-disable jsdoc/require-jsdoc */

import type { CredentialBase } from '@agentscope-ai/agentscope/credential';
import type { Msg } from '@agentscope-ai/agentscope/message';
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
    ScheduleRecord,
    ScheduleRecordSchema,
    SessionRecord,
    SessionRecordSchema,
    SkillRecord,
    SkillRecordSchema,
    TeamMember,
    TeamRecord,
    TeamRecordSchema,
    RecordEnvelope,
    cloneRecord,
    touchRecord,
} from './records';

const now = () => new Date().toISOString();
const messageKey = (userId: string, sessionId: string) => `${userId}\0${sessionId}`;

function titleCredentialType(type: unknown): string {
    if (typeof type !== 'string') return 'Credential';
    const raw = type
        .replace(/_credential$/, '')
        .replaceAll('_', ' ')
        .trim();
    if (!raw) return 'Credential';
    return raw.replace(/\b\w/g, character => character.toUpperCase());
}

function preserveCreatedAt<T extends RecordEnvelope>(next: T, current?: T): T {
    const touched = touchRecord(next);
    if (current) touched.created_at = current.created_at;
    return touched;
}

/** Process-local storage backend implementing the complete service contract. */
export class InMemoryStorage extends StorageBase {
    protected readonly credentials = new Map<string, CredentialRecord>();
    protected readonly mcps = new Map<string, MCPRecord>();
    protected readonly skills = new Map<string, SkillRecord>();
    protected readonly agents = new Map<string, AgentRecord>();
    protected readonly sessions = new Map<string, SessionRecord>();
    protected readonly schedules = new Map<string, ScheduleRecord>();
    protected readonly channels = new Map<string, ChannelRecord>();
    protected readonly channelBots = new Map<string, string>();
    protected readonly channelBotById = new Map<string, string>();
    protected readonly messages = new Map<string, Msg[]>();
    protected readonly teams = new Map<string, TeamRecord>();
    protected readonly knowledgeBases = new Map<string, KnowledgeBaseRecord>();
    protected readonly knowledgeDocuments = new Map<string, KnowledgeDocumentRecord>();

    async upsertCredential(userId: string, credential: CredentialBase): Promise<string> {
        const current = this.credentials.get(credential.id);
        this.assertAvailableOwner(current, userId, 'credential');
        const data = cloneRecord(credential.toJSON());
        if (!data.name) {
            const baseName = titleCredentialType(data.type);
            const names = new Set(
                [...this.credentials.values()]
                    .filter(item => item.user_id === userId && item.id !== credential.id)
                    .map(item => item.data.name)
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
            updated_at: now(),
        });
        this.credentials.set(record.id, record);
        return record.id;
    }

    async listCredentials(userId: string): Promise<CredentialRecord[]> {
        return this.listOwned(this.credentials, userId);
    }

    async getCredential(userId: string, credentialId: string): Promise<CredentialRecord | null> {
        return this.getOwned(this.credentials, userId, credentialId);
    }

    async deleteCredential(userId: string, credentialId: string): Promise<boolean> {
        return this.deleteOwned(this.credentials, userId, credentialId);
    }

    async upsertMCP(userId: string, input: MCPRecord): Promise<string> {
        const record = MCPRecordSchema.parse({ ...input, user_id: userId });
        this.assertAvailableOwner(this.mcps.get(record.id), userId, 'MCP');
        const holder = [...this.mcps.values()].find(
            item => item.user_id === userId && item.client.name === record.client.name
        );
        if (holder && holder.id !== record.id) {
            throw new StorageConflictError(
                `An MCP named ${JSON.stringify(record.client.name)} already exists for this user.`
            );
        }
        this.mcps.set(record.id, preserveCreatedAt(record, this.mcps.get(record.id)));
        return record.id;
    }

    async listMCPs(userId: string): Promise<MCPRecord[]> {
        return this.listOwned(this.mcps, userId);
    }

    async getMCP(userId: string, mcpId: string): Promise<MCPRecord | null> {
        return this.getOwned(this.mcps, userId, mcpId);
    }

    async getMCPByName(userId: string, name: string): Promise<MCPRecord | null> {
        return this.cloneOrNull(
            [...this.mcps.values()].find(
                record => record.user_id === userId && record.client.name === name
            )
        );
    }

    async deleteMCP(userId: string, mcpId: string): Promise<boolean> {
        return this.deleteOwned(this.mcps, userId, mcpId);
    }

    async upsertSkill(userId: string, input: SkillRecord): Promise<string> {
        const record = SkillRecordSchema.parse({ ...input, user_id: userId });
        this.assertAvailableOwner(this.skills.get(record.id), userId, 'skill');
        const holder = [...this.skills.values()].find(
            item => item.user_id === userId && item.name === record.name
        );
        if (holder && holder.id !== record.id) {
            throw new StorageConflictError(
                `A skill named ${JSON.stringify(record.name)} already exists for this user.`
            );
        }
        this.skills.set(record.id, preserveCreatedAt(record, this.skills.get(record.id)));
        return record.id;
    }

    async listSkills(userId: string): Promise<SkillRecord[]> {
        return this.listOwned(this.skills, userId);
    }

    async getSkill(userId: string, skillId: string): Promise<SkillRecord | null> {
        return this.getOwned(this.skills, userId, skillId);
    }

    async getSkillByName(userId: string, name: string): Promise<SkillRecord | null> {
        return this.cloneOrNull(
            [...this.skills.values()].find(
                record => record.user_id === userId && record.name === name
            )
        );
    }

    async deleteSkill(userId: string, skillId: string): Promise<boolean> {
        return this.deleteOwned(this.skills, userId, skillId);
    }

    async upsertAgent(userId: string, input: AgentRecord): Promise<string> {
        const record = AgentRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        this.assertAvailableOwner(this.agents.get(record.id), userId, 'agent');
        this.agents.set(record.id, preserveCreatedAt(record, this.agents.get(record.id)));
        return record.id;
    }

    async listAgents(userId: string): Promise<AgentRecord[]> {
        return this.listOwned(this.agents, userId).filter(record => record.source === 'user');
    }

    async getAgent(userId: string, agentId: string): Promise<AgentRecord | null> {
        return this.getOwned(this.agents, userId, agentId);
    }

    async deleteAgent(userId: string, agentId: string): Promise<boolean> {
        const record = this.agents.get(agentId);
        if (!record || record.user_id !== userId) return false;
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
        this.agents.delete(agentId);
        return true;
    }

    async upsertSession(options: UpsertSessionOptions): Promise<SessionRecord> {
        if (options.sessionId) {
            const current = this.sessions.get(options.sessionId);
            if (current) {
                this.assertAvailableOwner(current, options.userId, 'session');
                const record = SessionRecordSchema.parse({
                    ...current,
                    config: options.config,
                    state: options.state ?? current.state,
                    updated_at: now(),
                }) as SessionRecord;
                this.sessions.set(record.id, record);
                return cloneRecord(record);
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
        this.assertAvailableOwner(this.sessions.get(record.id), options.userId, 'session');
        this.sessions.set(record.id, record);
        return cloneRecord(record);
    }

    async setSessionTeamId(
        userId: string,
        sessionId: string,
        teamId: string | null
    ): Promise<void> {
        const record = this.sessions.get(sessionId);
        if (!record || record.user_id !== userId || record.team_id === teamId) return;
        this.sessions.set(sessionId, { ...record, team_id: teamId, updated_at: now() });
    }

    async updateSessionState(
        userId: string,
        _agentId: string,
        sessionId: string,
        state: AgentStateWire
    ): Promise<void> {
        const record = this.sessions.get(sessionId);
        if (!record || record.user_id !== userId) {
            throw new Error(`Session ${JSON.stringify(sessionId)} not found.`);
        }
        const next = SessionRecordSchema.parse({ ...record, state, updated_at: now() });
        this.sessions.set(sessionId, next as SessionRecord);
    }

    async listSessions(userId: string, agentId: string): Promise<SessionRecord[]> {
        return [...this.sessions.values()]
            .filter(record => record.user_id === userId && record.agent_id === agentId)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .map(cloneRecord);
    }

    async getSession(
        userId: string,
        _agentId: string,
        sessionId: string
    ): Promise<SessionRecord | null> {
        return this.getOwned(this.sessions, userId, sessionId);
    }

    async deleteSession(userId: string, agentId: string, sessionId: string): Promise<boolean> {
        const record = this.sessions.get(sessionId);
        if (!record || record.user_id !== userId) return false;
        if (record.team_id) {
            const team = await this.getTeam(userId, record.team_id);
            if (team?.session_id === sessionId) await this.deleteTeam(userId, team.id);
        }
        this.sessions.delete(sessionId);
        this.messages.delete(messageKey(userId, sessionId));
        return true;
    }

    async listSessionsBySchedule(userId: string, scheduleId: string): Promise<SessionRecord[]> {
        return this.listSessionsWhere(
            record => record.user_id === userId && record.source_schedule_id === scheduleId
        );
    }

    async listSessionsByChannel(userId: string, channelId: string): Promise<SessionRecord[]> {
        return this.listSessionsWhere(
            record => record.user_id === userId && record.source_channel_id === channelId
        );
    }

    async upsertSchedule(userId: string, input: ScheduleRecord): Promise<string> {
        const record = ScheduleRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        this.assertAvailableOwner(this.schedules.get(record.id), userId, 'schedule');
        this.schedules.set(record.id, preserveCreatedAt(record, this.schedules.get(record.id)));
        return record.id;
    }

    async getSchedule(userId: string, scheduleId: string): Promise<ScheduleRecord | null> {
        return this.getOwned(this.schedules, userId, scheduleId);
    }

    async listSchedules(userId: string): Promise<ScheduleRecord[]> {
        return this.listOwned(this.schedules, userId);
    }

    async listAllSchedules(): Promise<ScheduleRecord[]> {
        return [...this.schedules.values()].map(cloneRecord);
    }

    async deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
        const record = this.schedules.get(scheduleId);
        if (!record || record.user_id !== userId) return false;
        for (const session of await this.listSessionsBySchedule(userId, scheduleId)) {
            await this.deleteSession(userId, record.agent_id, session.id);
        }
        this.schedules.delete(scheduleId);
        return true;
    }

    async upsertChannel(input: ChannelRecord, platformBotId: string): Promise<string> {
        const record = ChannelRecordSchema.parse(input);
        const holder = this.channelBots.get(platformBotId);
        if (holder && holder !== record.id) {
            throw new StorageConflictError(
                `Bot ${JSON.stringify(platformBotId)} already drives channel ${JSON.stringify(holder)}.`
            );
        }
        const previousBot = this.channelBotById.get(record.id);
        if (previousBot && previousBot !== platformBotId) this.channelBots.delete(previousBot);
        this.channels.set(record.id, preserveCreatedAt(record, this.channels.get(record.id)));
        this.channelBots.set(platformBotId, record.id);
        this.channelBotById.set(record.id, platformBotId);
        return record.id;
    }

    async getChannel(channelId: string): Promise<ChannelRecord | null> {
        return this.cloneOrNull(this.channels.get(channelId));
    }

    async listChannels(userId: string): Promise<ChannelRecord[]> {
        return this.listOwned(this.channels, userId);
    }

    async listAllChannels(): Promise<ChannelRecord[]> {
        return [...this.channels.values()].map(cloneRecord);
    }

    async deleteChannel(channelId: string, _platformBotId: string): Promise<boolean> {
        if (!this.channels.has(channelId)) return false;
        this.channels.delete(channelId);
        const bot = this.channelBotById.get(channelId);
        if (bot) this.channelBots.delete(bot);
        this.channelBotById.delete(channelId);
        return true;
    }

    async getChannelIdByPlatformBotId(platformBotId: string): Promise<string | null> {
        return this.channelBots.get(platformBotId) ?? null;
    }

    async upsertMessage(userId: string, sessionId: string, message: Msg): Promise<void> {
        const key = messageKey(userId, sessionId);
        const existing = this.messages.get(key) ?? [];
        const index = existing.findIndex(item => item.id === message.id);
        if (index === -1) existing.push(cloneRecord(message));
        else existing[index] = cloneRecord(message);
        this.messages.set(key, existing);
    }

    async getMessage(userId: string, sessionId: string, messageId: string): Promise<Msg | null> {
        return this.cloneOrNull(
            this.messages.get(messageKey(userId, sessionId))?.find(item => item.id === messageId)
        );
    }

    async listMessages(
        userId: string,
        sessionId: string,
        options: { limit?: number; before?: string } = {}
    ): Promise<MessagePage> {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be non-negative.');
        const messages = this.messages.get(messageKey(userId, sessionId)) ?? [];
        let end = messages.length;
        if (options.before !== undefined) {
            end = messages.findIndex(item => item.id === options.before);
            if (end === -1) return { messages: [], hasMore: false };
        }
        const start = Math.max(0, end - limit);
        return {
            messages: messages.slice(start, end).map(cloneRecord),
            hasMore: start > 0,
        };
    }

    async upsertTeam(userId: string, input: TeamRecord): Promise<TeamRecord> {
        const record = TeamRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        this.assertAvailableOwner(this.teams.get(record.id), userId, 'team');
        const stored = preserveCreatedAt(record, this.teams.get(record.id));
        this.teams.set(record.id, stored);
        return cloneRecord(stored);
    }

    async getTeam(userId: string, teamId: string): Promise<TeamRecord | null> {
        return this.getOwned(this.teams, userId, teamId);
    }

    async listTeams(userId: string): Promise<TeamRecord[]> {
        return this.listOwned(this.teams, userId);
    }

    async deleteTeam(userId: string, teamId: string): Promise<boolean> {
        const team = this.teams.get(teamId);
        if (!team || team.user_id !== userId) return false;
        const members = await this.ensureTeamMembers(userId, team);
        for (const member of members) {
            if (member.role === 'created') {
                await this.deleteAgent(member.owner_id, member.agent_id);
            } else {
                await this.deleteSession(member.owner_id, member.agent_id, member.session_id);
            }
        }
        await this.setSessionTeamId(userId, team.session_id, null);
        this.teams.delete(teamId);
        return true;
    }

    async upsertKnowledgeBase(
        userId: string,
        input: KnowledgeBaseRecord
    ): Promise<KnowledgeBaseRecord> {
        const record = KnowledgeBaseRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        this.assertAvailableOwner(this.knowledgeBases.get(record.id), userId, 'knowledge base');
        const stored = preserveCreatedAt(record, this.knowledgeBases.get(record.id));
        this.knowledgeBases.set(record.id, stored);
        return cloneRecord(stored);
    }

    async getKnowledgeBase(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeBaseRecord | null> {
        return this.getOwned(this.knowledgeBases, userId, knowledgeBaseId);
    }

    async listKnowledgeBases(userId: string): Promise<KnowledgeBaseRecord[]> {
        return this.listOwned(this.knowledgeBases, userId);
    }

    async deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<boolean> {
        const record = this.knowledgeBases.get(knowledgeBaseId);
        if (!record || record.user_id !== userId) return false;
        for (const document of await this.listKnowledgeDocuments(userId, knowledgeBaseId)) {
            this.knowledgeDocuments.delete(document.id);
        }
        this.knowledgeBases.delete(knowledgeBaseId);
        return true;
    }

    async upsertKnowledgeDocument(
        userId: string,
        input: KnowledgeDocumentRecord
    ): Promise<KnowledgeDocumentRecord> {
        const record = KnowledgeDocumentRecordSchema.parse(input);
        this.assertMatchingOwner(record, userId);
        this.assertAvailableOwner(
            this.knowledgeDocuments.get(record.id),
            userId,
            'knowledge document'
        );
        if (!(await this.getKnowledgeBase(userId, record.knowledge_base_id))) {
            throw new StorageConflictError(
                `Knowledge base ${JSON.stringify(record.knowledge_base_id)} does not exist.`
            );
        }
        const stored = preserveCreatedAt(record, this.knowledgeDocuments.get(record.id));
        this.knowledgeDocuments.set(record.id, stored);
        return cloneRecord(stored);
    }

    async getKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<KnowledgeDocumentRecord | null> {
        const record = this.knowledgeDocuments.get(documentId);
        if (!record || record.user_id !== userId || record.knowledge_base_id !== knowledgeBaseId) {
            return null;
        }
        return cloneRecord(record);
    }

    async listKnowledgeDocuments(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeDocumentRecord[]> {
        return [...this.knowledgeDocuments.values()]
            .filter(
                record => record.user_id === userId && record.knowledge_base_id === knowledgeBaseId
            )
            .map(cloneRecord);
    }

    async deleteKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<boolean> {
        if (!(await this.getKnowledgeDocument(userId, knowledgeBaseId, documentId))) return false;
        this.knowledgeDocuments.delete(documentId);
        return true;
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
        record.updated_at = now();
        this.knowledgeDocuments.set(documentId, record);
    }

    async acquireKnowledgeDocumentLease(options: KnowledgeDocumentLeaseOptions): Promise<boolean> {
        const record = await this.getKnowledgeDocument(
            options.userId,
            options.knowledgeBaseId,
            options.documentId
        );
        if (!record) return false;
        const current = options.now ?? new Date();
        if (
            record.processing_node !== null &&
            record.lease_expires_at !== null &&
            new Date(record.lease_expires_at) > current
        ) {
            return false;
        }
        record.processing_node = options.processingNode;
        record.lease_expires_at = new Date(current.getTime() + options.leaseTtlMs).toISOString();
        record.updated_at = current.toISOString();
        this.knowledgeDocuments.set(record.id, record);
        return true;
    }

    async renewKnowledgeDocumentLease(options: KnowledgeDocumentLeaseOptions): Promise<boolean> {
        const record = await this.getKnowledgeDocument(
            options.userId,
            options.knowledgeBaseId,
            options.documentId
        );
        if (!record || record.processing_node !== options.processingNode) return false;
        const current = options.now ?? new Date();
        record.lease_expires_at = new Date(current.getTime() + options.leaseTtlMs).toISOString();
        record.updated_at = current.toISOString();
        this.knowledgeDocuments.set(record.id, record);
        return true;
    }

    async releaseKnowledgeDocumentLease(
        options: Omit<KnowledgeDocumentLeaseOptions, 'leaseTtlMs' | 'now'>
    ): Promise<void> {
        const record = await this.getKnowledgeDocument(
            options.userId,
            options.knowledgeBaseId,
            options.documentId
        );
        if (!record || record.processing_node !== options.processingNode) return;
        record.processing_node = null;
        record.lease_expires_at = null;
        record.updated_at = now();
        this.knowledgeDocuments.set(record.id, record);
    }

    async listKnowledgeDocumentsWithExpiredLease(
        current = new Date()
    ): Promise<KnowledgeDocumentRecord[]> {
        return [...this.knowledgeDocuments.values()]
            .filter(
                record =>
                    record.status !== 'ready' &&
                    record.status !== 'error' &&
                    record.processing_node !== null &&
                    record.lease_expires_at !== null &&
                    new Date(record.lease_expires_at) < current
            )
            .map(cloneRecord);
    }

    async listKnowledgeDocumentsPendingSince(threshold: Date): Promise<KnowledgeDocumentRecord[]> {
        return [...this.knowledgeDocuments.values()]
            .filter(
                record => record.status === 'pending' && new Date(record.created_at) < threshold
            )
            .map(cloneRecord);
    }

    protected assertMatchingOwner(record: { user_id: string }, userId: string): void {
        if (record.user_id !== userId) {
            throw new StorageConflictError('record.user_id does not match the given userId.');
        }
    }

    protected assertAvailableOwner(
        record: { user_id: string } | undefined,
        userId: string,
        kind: string
    ): void {
        if (record && record.user_id !== userId) {
            throw new StorageConflictError(`The ${kind} id is already owned by another user.`);
        }
    }

    protected listOwned<T extends { user_id: string }>(
        records: Map<string, T>,
        userId: string
    ): T[] {
        return [...records.values()].filter(record => record.user_id === userId).map(cloneRecord);
    }

    protected getOwned<T extends { user_id: string }>(
        records: Map<string, T>,
        userId: string,
        id: string
    ): T | null {
        const record = records.get(id);
        return record?.user_id === userId ? cloneRecord(record) : null;
    }

    protected deleteOwned<T extends { user_id: string }>(
        records: Map<string, T>,
        userId: string,
        id: string
    ): boolean {
        const record = records.get(id);
        if (!record || record.user_id !== userId) return false;
        return records.delete(id);
    }

    protected cloneOrNull<T>(value: T | undefined): T | null {
        return value === undefined ? null : cloneRecord(value);
    }

    private listSessionsWhere(predicate: (record: SessionRecord) => boolean): SessionRecord[] {
        return [...this.sessions.values()]
            .filter(predicate)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .map(cloneRecord);
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
}
