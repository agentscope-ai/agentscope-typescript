import { parseAgentState } from '@agentscope-ai/agentscope/state';
import type { AgentStateWire } from '@agentscope-ai/agentscope/state';
import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.unknown());
const timestamp = () => new Date().toISOString();
const identifier = () => crypto.randomUUID().replaceAll('-', '');

/** Fields shared by every persisted service record. */
export interface RecordEnvelope {
    id: string;
    created_at: string;
    updated_at: string;
}

const RecordEnvelopeSchema = z.object({
    id: z.string().default(identifier),
    created_at: z.string().default(timestamp),
    updated_at: z.string().default(timestamp),
});

/** User-editable invitation settings for an agent. */
export const InviteConfigSchema = z
    .object({
        invitable: z.boolean().default(false),
        invite_description: z.string().nullable().default(null),
    })
    .superRefine((value, context) => {
        if (value.invitable && !value.invite_description?.trim()) {
            context.addIssue({
                code: 'custom',
                message: 'invite_description must be non-empty when invitable=true',
                path: ['invite_description'],
            });
        }
    });
export type InviteConfig = z.output<typeof InviteConfigSchema>;

/** Persisted agent configuration payload. */
export const AgentDataSchema = z.object({
    id: z.string().default(identifier),
    name: z.string(),
    system_prompt: z.string().default("You're a helpful assistant."),
    context_config: JsonObjectSchema,
    react_config: JsonObjectSchema,
    invite_config: InviteConfigSchema.default({
        invitable: false,
        invite_description: null,
    }),
});
export type AgentData = z.output<typeof AgentDataSchema>;

/** Persisted agent record. */
export const AgentRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    source: z.enum(['user', 'team']).default('user'),
    data: AgentDataSchema,
});
export type AgentRecord = z.output<typeof AgentRecordSchema>;

/** Persisted credential record. */
export const CredentialRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    data: JsonObjectSchema,
});
export type CredentialRecord = z.output<typeof CredentialRecordSchema>;

/** Chat model selection persisted on sessions and schedules. */
export const ChatModelConfigSchema = z.object({
    type: z.string(),
    credential_id: z.string(),
    model: z.string(),
    parameters: JsonObjectSchema,
});
export type ChatModelConfig = z.output<typeof ChatModelConfigSchema>;

/** TTS model selection persisted on sessions. */
export const TTSModelConfigSchema = ChatModelConfigSchema;
export type TTSModelConfig = z.output<typeof TTSModelConfigSchema>;

/** Embedding model selection persisted on a knowledge base. */
export const EmbeddingModelConfigSchema = z.object({
    type: z.string(),
    credential_id: z.string(),
    model: z.string(),
    dimensions: z.number().int().positive(),
    parameters: JsonObjectSchema.default({}),
});
export type EmbeddingModelConfig = z.output<typeof EmbeddingModelConfigSchema>;

/** Session-level knowledge attachment. */
export const SessionKnowledgeConfigSchema = z.object({
    knowledge_base_ids: z.array(z.string()).default([]),
    parameters: JsonObjectSchema.default({}),
});
export type SessionKnowledgeConfig = z.output<typeof SessionKnowledgeConfigSchema>;

/** Persisted session configuration. */
export const SessionConfigSchema = z.object({
    workspace_id: z.string(),
    name: z.string().default(() => new Date().toISOString().replace('T', ' ').slice(0, 19)),
    cwd: z.string().nullable().default(null),
    chat_model_config: ChatModelConfigSchema.nullable().default(null),
    fallback_chat_model_config: ChatModelConfigSchema.nullable().default(null),
    tts_model_config: TTSModelConfigSchema.nullable().default(null),
    knowledge_config: SessionKnowledgeConfigSchema.nullable().default(null),
});
export type SessionConfig = z.output<typeof SessionConfigSchema>;

/** Origin of a persisted session. */
export const SessionSourceSchema = z.enum(['user', 'schedule', 'channel']);
export type SessionSource = z.output<typeof SessionSourceSchema>;

const AgentStateWireSchema = z.unknown().transform(value => parseAgentState(value).toJSON());

/** Persisted session record. */
export const SessionRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    agent_id: z.string(),
    source: SessionSourceSchema.default('user'),
    source_schedule_id: z.string().nullable().default(null),
    source_chat_id: z.string().nullable().default(null),
    source_chat_name: z.string().nullable().default(null),
    source_channel_id: z.string().nullable().default(null),
    team_id: z.string().nullable().default(null),
    config: SessionConfigSchema,
    state: AgentStateWireSchema,
});
export interface SessionRecord extends RecordEnvelope {
    user_id: string;
    agent_id: string;
    source: SessionSource;
    source_schedule_id: string | null;
    source_chat_id: string | null;
    source_chat_name: string | null;
    source_channel_id: string | null;
    team_id: string | null;
    config: SessionConfig;
    state: AgentStateWire;
}

/** Origin of a persisted schedule. */
export const ScheduleSourceSchema = z.enum(['USER', 'AGENT']);
export type ScheduleSource = z.output<typeof ScheduleSourceSchema>;

/** Persisted schedule payload. */
export const ScheduleDataSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    timezone: z.string().default('UTC'),
    cron_expression: z.string(),
    started_at: z.string().default(timestamp),
    ended_at: z.string().nullable().default(null),
    chat_model_config: ChatModelConfigSchema,
    stateful: z.boolean().default(false),
    permission_mode: z
        .enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'])
        .default('dont_ask'),
    source: ScheduleSourceSchema.default('USER'),
    source_session_id: z.string().default(''),
});
export type ScheduleData = z.output<typeof ScheduleDataSchema>;

/** Persisted schedule record. */
export const ScheduleRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    agent_id: z.string(),
    data: ScheduleDataSchema,
});
export type ScheduleRecord = z.output<typeof ScheduleRecordSchema>;

/** One member in a team roster. */
export const TeamMemberSchema = z.object({
    owner_id: z.string(),
    agent_id: z.string(),
    session_id: z.string(),
    role: z.enum(['created', 'invited']),
});
export type TeamMember = z.output<typeof TeamMemberSchema>;

/** Persisted team payload. */
export const TeamDataSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    member_ids: z.array(z.string()).default([]),
    members: z.array(TeamMemberSchema).default([]),
});
export type TeamData = z.output<typeof TeamDataSchema>;

/** Persisted team record. */
export const TeamRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    session_id: z.string(),
    leader_agent_id: z.string().nullable().default(null),
    data: TeamDataSchema,
});
export type TeamRecord = z.output<typeof TeamRecordSchema>;

const HttpMCPConfigSchema = z.object({
    type: z.literal('http_mcp'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).nullable().default(null),
    timeout: z.number().nullable().default(30),
});
const StdioMCPConfigSchema = z.object({
    type: z.literal('stdio_mcp'),
    command: z.string(),
    args: z.array(z.string()).nullable().default(null),
    env: z.record(z.string(), z.string()).nullable().default(null),
    cwd: z.string().nullable().default(null),
    encoding_error_handler: z.enum(['strict', 'ignore', 'replace']).default('strict'),
});

/** Serializable MCP client configuration stored by the service. */
export const MCPClientWireSchema = z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    is_stateful: z.boolean(),
    mcp_config: z.discriminatedUnion('type', [HttpMCPConfigSchema, StdioMCPConfigSchema]),
    enable_tools: z.array(z.string()).nullable().default(null),
    disable_tools: z.array(z.string()).nullable().default(null),
    execution_timeout: z.number().nullable().default(null),
});
export type MCPClientWire = z.output<typeof MCPClientWireSchema>;

/** Persisted installed-MCP record. */
export const MCPRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    client: MCPClientWireSchema,
    display_name: z.string().nullable().default(null),
    description: z.string().default(''),
    author: z.string().nullable().default(null),
    icon_url: z.string().nullable().default(null),
    url: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    values: JsonObjectSchema.default({}),
    hub_id: z.string().nullable().default(null),
    card_id: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
});
export type MCPRecord = z.output<typeof MCPRecordSchema>;

/** Persisted installed-skill record. */
export const SkillRecordSchema = RecordEnvelopeSchema.extend({
    user_id: z.string(),
    name: z.string(),
    display_name: z.string().nullable().default(null),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    author: z.string().nullable().default(null),
    icon_url: z.string().nullable().default(null),
    url: z.string().nullable().default(null),
    markdown: z.string().default(''),
    hub_id: z.string().nullable().default(null),
    card_id: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
});
export type SkillRecord = z.output<typeof SkillRecordSchema>;

/** How a channel groups inbound conversations into sessions. */
export const SessionScopeSchema = z.enum(['per_chat', 'per_chat_user']);
export type SessionScope = z.output<typeof SessionScopeSchema>;

/** One ordered channel routing rule. */
export const ChannelBindingSchema = z.object({
    match_key: z.string().default('chat_id'),
    match_value: z.string().default('*'),
    agent_id: z.string(),
    session_scope: SessionScopeSchema.default('per_chat'),
});
export type ChannelBinding = z.output<typeof ChannelBindingSchema>;

/** Validated total routing configuration for a channel. */
export const RoutingConfigSchema = z
    .object({ bindings: z.array(ChannelBindingSchema) })
    .superRefine((value, context) => {
        const catchAll = value.bindings
            .map((binding, index) => ({ binding, index }))
            .filter(item => item.binding.match_value === '*');
        if (catchAll.length !== 1) {
            context.addIssue({
                code: 'custom',
                message:
                    "routing.bindings must contain exactly one catch-all rule (match_value='*').",
                path: ['bindings'],
            });
        } else if (catchAll[0].index !== value.bindings.length - 1) {
            context.addIssue({
                code: 'custom',
                message: "The catch-all rule (match_value='*') must be the last binding.",
                path: ['bindings'],
            });
        }
        const seen = new Set<string>();
        value.bindings.forEach((binding, index) => {
            const key = JSON.stringify([binding.match_key, binding.match_value]);
            if (seen.has(key)) {
                context.addIssue({
                    code: 'custom',
                    message: `Duplicate routing rule for ${key}.`,
                    path: ['bindings', index],
                });
            }
            seen.add(key);
        });
    });
export type RoutingConfig = z.output<typeof RoutingConfigSchema>;

/** Settings used for channel-created sessions. */
export const SessionSettingsSchema = z.object({
    chat_model_config: JsonObjectSchema,
    fallback_chat_model_config: JsonObjectSchema.nullable().default(null),
    permission_mode: z
        .enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'])
        .default('default'),
});
export type SessionSettings = z.output<typeof SessionSettingsSchema>;

/** Persisted channel record. */
export const ChannelRecordSchema = RecordEnvelopeSchema.extend({
    channel_type: z.string(),
    name: z.string().nullable().default(null),
    user_id: z.string(),
    enabled: z.boolean().default(true),
    credentials: JsonObjectSchema.default({}),
    platform_config: JsonObjectSchema.default({}),
    routing: RoutingConfigSchema,
    session: SessionSettingsSchema,
});
export type ChannelRecord = z.output<typeof ChannelRecordSchema>;

/** Persisted chunker selection. */
export const ChunkerConfigSchema = z.object({
    type: z.string(),
    parameters: JsonObjectSchema.default({}),
});
export type ChunkerConfig = z.output<typeof ChunkerConfigSchema>;

/** Persisted knowledge-base payload. */
export const KnowledgeBaseDataSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    embedding_model_config: EmbeddingModelConfigSchema,
    chunker_config: ChunkerConfigSchema.nullable().default(null),
    collection_name: z.string(),
});
export type KnowledgeBaseData = z.output<typeof KnowledgeBaseDataSchema>;

const legacyKnowledgeBase = (input: unknown): unknown => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || 'data' in input)
        return input;
    const value = input as Record<string, unknown>;
    const keys = [
        'name',
        'description',
        'embedding_model_config',
        'chunker_config',
        'collection_name',
    ];
    if (!keys.some(key => key in value)) return input;
    const data = Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
    return {
        ...Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))),
        data,
    };
};

/** Persisted knowledge-base record, including legacy flat-payload migration. */
export const KnowledgeBaseRecordSchema = z.preprocess(
    legacyKnowledgeBase,
    RecordEnvelopeSchema.extend({
        user_id: z.string(),
        data: KnowledgeBaseDataSchema,
    })
);
export type KnowledgeBaseRecord = z.output<typeof KnowledgeBaseRecordSchema>;

/** Knowledge-document lifecycle state. */
export const KnowledgeDocumentStatusSchema = z.enum([
    'pending',
    'parsing',
    'chunking',
    'indexing',
    'ready',
    'error',
]);
export type KnowledgeDocumentStatus = z.output<typeof KnowledgeDocumentStatusSchema>;

/** Mutable non-indexed payload of a knowledge document. */
export const KnowledgeDocumentDataSchema = z.object({
    filename: z.string(),
    size: z.number().int().nonnegative(),
    content_type: z.string().nullable().default(null),
    blob_uri: z.string(),
    error: z.string().nullable().default(null),
    chunk_count: z.number().int().nonnegative().default(0),
});
export type KnowledgeDocumentData = z.output<typeof KnowledgeDocumentDataSchema>;

const legacyKnowledgeDocument = (input: unknown): unknown => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const value = structuredClone(input as Record<string, unknown>);
    if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return value;
    const data = value.data as Record<string, unknown>;
    for (const key of ['status', 'lease_expires_at']) {
        if (!(key in value) && key in data) value[key] = data[key];
        delete data[key];
    }
    return value;
};

/** Persisted knowledge-document record with legacy lifecycle migration. */
export const KnowledgeDocumentRecordSchema = z.preprocess(
    legacyKnowledgeDocument,
    RecordEnvelopeSchema.extend({
        user_id: z.string(),
        knowledge_base_id: z.string(),
        processing_node: z.string().nullable().default(null),
        status: KnowledgeDocumentStatusSchema.default('pending'),
        lease_expires_at: z.string().nullable().default(null),
        data: KnowledgeDocumentDataSchema,
    })
);
export type KnowledgeDocumentRecord = z.output<typeof KnowledgeDocumentRecordSchema>;

/** Persisted user identity record. */
export const UserRecordSchema = RecordEnvelopeSchema;
export type UserRecord = z.output<typeof UserRecordSchema>;

/**
 * Build a record from a schema while applying all Python-compatible defaults.
 * @param schema
 * @param input
 */
export function createRecord<S extends z.ZodType>(schema: S, input: z.input<S>): z.output<S> {
    return schema.parse(input);
}

/**
 * Refresh an existing record's update timestamp without changing its creation time.
 * @param record
 * @param now
 */
export function touchRecord<T extends RecordEnvelope>(record: T, now = timestamp()): T {
    return { ...record, updated_at: now };
}

/**
 * Clone a persisted value so callers cannot mutate backend state by reference.
 * @param value
 */
export function cloneRecord<T>(value: T): T {
    return structuredClone(value);
}
