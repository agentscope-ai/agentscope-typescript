import type { CredentialBase } from '@agentscope-ai/agentscope/credential';
import type { Msg } from '@agentscope-ai/agentscope/message';
import type { AgentStateWire } from '@agentscope-ai/agentscope/state';

import type {
    AgentRecord,
    ChannelRecord,
    CredentialRecord,
    KnowledgeBaseRecord,
    KnowledgeDocumentRecord,
    KnowledgeDocumentStatus,
    MCPRecord,
    ScheduleRecord,
    SessionConfig,
    SessionRecord,
    SessionSource,
    SkillRecord,
    TeamRecord,
} from './records';

/** Page of chronologically ordered messages. */
export interface MessagePage {
    messages: Msg[];
    hasMore: boolean;
}

/** Options used when creating or updating a session. */
export interface UpsertSessionOptions {
    userId: string;
    agentId: string;
    config: SessionConfig;
    state?: AgentStateWire;
    sessionId?: string;
    source?: SessionSource;
    sourceScheduleId?: string | null;
    sourceChatId?: string | null;
    sourceChatName?: string | null;
    sourceChannelId?: string | null;
    createdAt?: string;
    updatedAt?: string;
}

/** Options for knowledge-document lease operations. */
export interface KnowledgeDocumentLeaseOptions {
    userId: string;
    knowledgeBaseId: string;
    documentId: string;
    processingNode: string;
    leaseTtlMs: number;
    now?: Date;
}

/** Python-compatible persistence contract used by the Agent Service. */
export abstract class StorageBase {
    /** Start the backend. */
    async open(): Promise<this> {
        return this;
    }

    /** Release backend resources. */
    async close(): Promise<void> {}

    abstract upsertCredential(userId: string, credential: CredentialBase): Promise<string>;
    abstract listCredentials(userId: string): Promise<CredentialRecord[]>;
    abstract getCredential(userId: string, credentialId: string): Promise<CredentialRecord | null>;
    abstract deleteCredential(userId: string, credentialId: string): Promise<boolean>;

    abstract upsertMCP(userId: string, record: MCPRecord): Promise<string>;
    abstract listMCPs(userId: string): Promise<MCPRecord[]>;
    abstract getMCP(userId: string, mcpId: string): Promise<MCPRecord | null>;
    abstract getMCPByName(userId: string, name: string): Promise<MCPRecord | null>;
    abstract deleteMCP(userId: string, mcpId: string): Promise<boolean>;

    abstract upsertSkill(userId: string, record: SkillRecord): Promise<string>;
    abstract listSkills(userId: string): Promise<SkillRecord[]>;
    abstract getSkill(userId: string, skillId: string): Promise<SkillRecord | null>;
    abstract getSkillByName(userId: string, name: string): Promise<SkillRecord | null>;
    abstract deleteSkill(userId: string, skillId: string): Promise<boolean>;

    abstract upsertAgent(userId: string, record: AgentRecord): Promise<string>;
    abstract listAgents(userId: string): Promise<AgentRecord[]>;
    abstract getAgent(userId: string, agentId: string): Promise<AgentRecord | null>;
    abstract deleteAgent(userId: string, agentId: string): Promise<boolean>;

    abstract upsertSession(options: UpsertSessionOptions): Promise<SessionRecord>;
    abstract setSessionTeamId(
        userId: string,
        sessionId: string,
        teamId: string | null
    ): Promise<void>;
    abstract updateSessionState(
        userId: string,
        agentId: string,
        sessionId: string,
        state: AgentStateWire
    ): Promise<void>;
    abstract listSessions(userId: string, agentId: string): Promise<SessionRecord[]>;
    abstract getSession(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<SessionRecord | null>;
    abstract deleteSession(userId: string, agentId: string, sessionId: string): Promise<boolean>;
    abstract listSessionsBySchedule(userId: string, scheduleId: string): Promise<SessionRecord[]>;
    abstract listSessionsByChannel(userId: string, channelId: string): Promise<SessionRecord[]>;

    abstract upsertSchedule(userId: string, record: ScheduleRecord): Promise<string>;
    abstract getSchedule(userId: string, scheduleId: string): Promise<ScheduleRecord | null>;
    abstract listSchedules(userId: string): Promise<ScheduleRecord[]>;
    abstract listAllSchedules(): Promise<ScheduleRecord[]>;
    abstract deleteSchedule(userId: string, scheduleId: string): Promise<boolean>;

    abstract upsertChannel(record: ChannelRecord, platformBotId: string): Promise<string>;
    abstract getChannel(channelId: string): Promise<ChannelRecord | null>;
    abstract listChannels(userId: string): Promise<ChannelRecord[]>;
    abstract listAllChannels(): Promise<ChannelRecord[]>;
    abstract deleteChannel(channelId: string, platformBotId: string): Promise<boolean>;
    abstract getChannelIdByPlatformBotId(platformBotId: string): Promise<string | null>;

    abstract upsertMessage(userId: string, sessionId: string, message: Msg): Promise<void>;
    abstract getMessage(userId: string, sessionId: string, messageId: string): Promise<Msg | null>;
    abstract listMessages(
        userId: string,
        sessionId: string,
        options?: { limit?: number; before?: string }
    ): Promise<MessagePage>;

    abstract upsertTeam(userId: string, record: TeamRecord): Promise<TeamRecord>;
    abstract getTeam(userId: string, teamId: string): Promise<TeamRecord | null>;
    abstract listTeams(userId: string): Promise<TeamRecord[]>;
    abstract deleteTeam(userId: string, teamId: string): Promise<boolean>;

    abstract upsertKnowledgeBase(
        userId: string,
        record: KnowledgeBaseRecord
    ): Promise<KnowledgeBaseRecord>;
    abstract getKnowledgeBase(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeBaseRecord | null>;
    abstract listKnowledgeBases(userId: string): Promise<KnowledgeBaseRecord[]>;
    abstract deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<boolean>;

    abstract upsertKnowledgeDocument(
        userId: string,
        record: KnowledgeDocumentRecord
    ): Promise<KnowledgeDocumentRecord>;
    abstract getKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<KnowledgeDocumentRecord | null>;
    abstract listKnowledgeDocuments(
        userId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeDocumentRecord[]>;
    abstract deleteKnowledgeDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<boolean>;
    abstract updateKnowledgeDocumentStatus(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        status: KnowledgeDocumentStatus,
        options?: { error?: string; chunkCount?: number }
    ): Promise<void>;
    abstract acquireKnowledgeDocumentLease(
        options: KnowledgeDocumentLeaseOptions
    ): Promise<boolean>;
    abstract renewKnowledgeDocumentLease(options: KnowledgeDocumentLeaseOptions): Promise<boolean>;
    abstract releaseKnowledgeDocumentLease(
        options: Omit<KnowledgeDocumentLeaseOptions, 'leaseTtlMs' | 'now'>
    ): Promise<void>;
    abstract listKnowledgeDocumentsWithExpiredLease(now?: Date): Promise<KnowledgeDocumentRecord[]>;
    abstract listKnowledgeDocumentsPendingSince(
        threshold: Date
    ): Promise<KnowledgeDocumentRecord[]>;
}

/** Raised when a unique persistence constraint would be violated. */
export class StorageConflictError extends Error {
    /**
     * Create a storage conflict.
     * @param message
     */
    constructor(message: string) {
        super(message);
        this.name = 'StorageConflictError';
    }
}
