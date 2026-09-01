import { z } from 'zod';

import { JsonObjectSchema } from './foundation';
import {
    ChatModelConfigSchema,
    SessionKnowledgeConfigSchema,
    TTSModelConfigSchema,
} from '../../storage';

const optionalModel = ChatModelConfigSchema.nullable().optional();

export const CreateSessionRequestSchema = z.object({
    agent_id: z.string(),
    workspace_id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    chat_model_config: optionalModel,
    fallback_chat_model_config: optionalModel,
    tts_model_config: TTSModelConfigSchema.nullable().optional(),
    knowledge_config: SessionKnowledgeConfigSchema.nullable().optional(),
});

export const UpdateSessionRequestSchema = z.object({
    name: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    chat_model_config: optionalModel,
    fallback_chat_model_config: optionalModel,
    tts_model_config: TTSModelConfigSchema.nullable().optional(),
    knowledge_config: SessionKnowledgeConfigSchema.nullable().optional(),
    permission_mode: z
        .enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'])
        .nullable()
        .optional(),
});

export const AgentQuerySchema = z.object({ agent_id: z.string() });
export const MessageQuerySchema = AgentQuerySchema.extend({
    before: z.string().optional(),
    offset: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ChatRequestSchema = z.object({
    agent_id: z.string(),
    session_id: z.string(),
    input: z.union([JsonObjectSchema, z.array(JsonObjectSchema), z.null()]),
});

export const CreateScheduleRequestSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    cron_expression: z.string(),
    timezone: z.string().default('UTC'),
    enabled: z.boolean().default(true),
    stateful: z.boolean().default(false),
    permission_mode: z
        .enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'])
        .default('dont_ask'),
    agent_id: z.string(),
    chat_model_config: ChatModelConfigSchema,
});

export const UpdateScheduleRequestSchema = z.object({
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    cron_expression: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    stateful: z.boolean().nullable().optional(),
    permission_mode: z
        .enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask'])
        .nullable()
        .optional(),
});
