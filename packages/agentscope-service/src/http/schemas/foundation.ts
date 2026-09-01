import { ContextConfig, ReActConfig } from '@agentscope-ai/agentscope/agent';
import { z } from 'zod';

import { AgentDataSchema, InviteConfigSchema } from '../../storage';

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const CreateAgentRequestSchema = z.object({
    name: z.string(),
    system_prompt: z.string().default("You're a helpful assistant."),
    context_config: JsonObjectSchema.default(() => defaultContextConfig()),
    react_config: JsonObjectSchema.default(() => defaultReactConfig()),
    invite_config: InviteConfigSchema.default({
        invitable: false,
        invite_description: null,
    }),
});

export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial();

export const CreateCredentialRequestSchema = z.object({ data: JsonObjectSchema });
export const UpdateCredentialRequestSchema = CreateCredentialRequestSchema;
export const ProviderQuerySchema = z.object({ provider: z.string() });

/**
 *
 */
export function agentDataJSONSchema(): Record<string, unknown> {
    const schema = z.toJSONSchema(AgentDataSchema) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    delete properties?.id;
    const required = schema.required;
    if (Array.isArray(required)) schema.required = required.filter(item => item !== 'id');
    const context = properties?.context_config as
        | { properties?: Record<string, unknown> }
        | undefined;
    delete context?.properties?.summary_schema;
    return schema;
}

/**
 *
 */
export function defaultContextConfig(): Record<string, unknown> {
    const config = new ContextConfig();
    return {
        trigger_ratio: config.triggerRatio,
        reserve_ratio: config.reserveRatio,
        compression_prompt: config.compressionPrompt,
        summary_template: config.summaryTemplate,
        summary_schema: config.summarySchema,
        tool_result_limit: config.toolResultLimit,
        max_image_num: config.maxImageNum,
    };
}

/**
 *
 */
export function defaultReactConfig(): Record<string, unknown> {
    const config = new ReActConfig();
    return {
        max_iters: config.maxIters,
        structured_output_grace_iters: config.structuredOutputGraceIters,
        stop_on_reject: config.stopOnReject,
        interruption_message: config.interruptionMessage,
        interruption_raise_cancelled_error: config.interruptionRaiseCancelledError,
    };
}
