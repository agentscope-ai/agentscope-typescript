/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

import { z } from 'zod';

import {
    ContextConfigDataSchema,
    defaultContextConfigData,
    defaultReActConfigData,
    InviteConfigSchema,
    ReActConfigDataSchema,
} from '../../storage';

export const JsonObjectSchema = z.record(z.string(), z.unknown());

const contextDefaults = defaultContextConfig();
const reactDefaults = defaultReactConfig();

/** Python-compatible context configuration accepted by agent routes. */
export const ContextConfigRequestSchema = ContextConfigDataSchema;

/** Python-compatible ReAct configuration accepted by agent routes. */
export const ReActConfigRequestSchema = ReActConfigDataSchema;

export const CreateAgentRequestSchema = z.object({
    name: z.string(),
    system_prompt: z.string().default("You're a helpful assistant."),
    context_config: ContextConfigRequestSchema.default(() => defaultContextConfig()),
    react_config: ReActConfigRequestSchema.default(() => defaultReactConfig()),
    invite_config: InviteConfigSchema.default({
        invitable: false,
        invite_description: null,
    }),
});

export const UpdateAgentRequestSchema = z.object({
    name: z.string().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    context_config: ContextConfigRequestSchema.nullable().optional(),
    react_config: ReActConfigRequestSchema.nullable().optional(),
    invite_config: InviteConfigSchema.nullable().optional(),
});

export const CreateCredentialRequestSchema = z.object({ data: JsonObjectSchema });
export const UpdateCredentialRequestSchema = CreateCredentialRequestSchema;
export const ProviderQuerySchema = z.object({ provider: z.string() });

/** Return the flattened AgentData JSON Schema exposed by Python. */
export function agentDataJSONSchema(): Record<string, unknown> {
    return {
        description: 'The agent data model.',
        properties: {
            name: {
                description: 'The name of the agent.',
                title: 'Name',
                type: 'string',
            },
            system_prompt: {
                default: "You're a helpful assistant.",
                description: 'The system prompt for the agent.',
                format: 'textarea',
                title: 'System Prompt',
                type: 'string',
            },
            context_config: {
                ...contextConfigJSONSchema('Context Config'),
                description: 'The context config for the agent.',
            },
            react_config: {
                ...reactConfigJSONSchema('React Config'),
                description: 'The react config for the agent.',
            },
            invite_config: inviteConfigJSONSchema(),
        },
        required: ['name', 'context_config', 'react_config'],
        title: 'AgentData',
        type: 'object',
    };
}

/** Return the ContextConfig JSON Schema without the internal summary schema. */
export function contextConfigJSONSchema(title = 'ContextConfig'): Record<string, unknown> {
    return {
        description: 'The context related configuration in AgentScope',
        properties: {
            trigger_ratio: {
                default: contextDefaults.trigger_ratio,
                exclusiveMinimum: 0,
                maximum: 0.9,
                title: 'Trigger Ratio',
                type: 'number',
            },
            reserve_ratio: {
                default: contextDefaults.reserve_ratio,
                exclusiveMaximum: 0.9,
                exclusiveMinimum: 0,
                title: 'Reserve Ratio',
                type: 'number',
            },
            compression_prompt: {
                default: contextDefaults.compression_prompt,
                format: 'textarea',
                title: 'Compression Prompt',
                type: 'string',
            },
            summary_template: {
                default: contextDefaults.summary_template,
                format: 'textarea',
                title: 'Summary Template',
                type: 'string',
            },
            tool_result_limit: {
                default: contextDefaults.tool_result_limit,
                description:
                    'The maximum length of the tool results in tokens. If exceeded, the tool result will be truncated.',
                title: 'Tool Result Limit',
                type: 'integer',
            },
            max_image_num: {
                default: contextDefaults.max_image_num,
                description:
                    'The maximum number of images kept in the context. The oldest images exceeding the limit will be removed.',
                minimum: 0,
                title: 'Max Image Number',
                type: 'integer',
            },
        },
        title,
        type: 'object',
    };
}

/** Return the ReActConfig JSON Schema exposed by Python. */
export function reactConfigJSONSchema(title = 'ReActConfig'): Record<string, unknown> {
    return {
        description: 'The reasoning related configuration',
        properties: {
            max_iters: {
                default: reactDefaults.max_iters,
                description: 'The maximum number of reasoning-acting iterations in one reply',
                title: 'Max Iterations',
                type: 'integer',
            },
            structured_output_grace_iters: {
                default: reactDefaults.structured_output_grace_iters,
                description:
                    'The grace iterations for structured output when exceeding the max iterations',
                exclusiveMinimum: 0,
                title: 'Grace Iters for Structured Output',
                type: 'integer',
            },
            stop_on_reject: {
                default: reactDefaults.stop_on_reject,
                description: 'Whether to stop replying when being rejected to execute tools.',
                title: 'Rejection Handling',
                type: 'boolean',
            },
            interruption_message: {
                default: reactDefaults.interruption_message,
                description: 'The quick reply message when interrupted.',
                title: 'Interruption Message',
                type: 'string',
            },
            interruption_raise_cancelled_error: {
                default: reactDefaults.interruption_raise_cancelled_error,
                description:
                    'Whether to re-raise ``asyncio.CancelledError`` after handling the interruption. When ``False``, the ``CancelledError`` is swallowed once the interruption context has been produced.',
                title: 'Raise CancelledError on Interruption',
                type: 'boolean',
            },
        },
        title,
        type: 'object',
    };
}

/** Return Python-style snake_case defaults for ContextConfig. */
export function defaultContextConfig() {
    return defaultContextConfigData();
}

/** Return Python-style snake_case defaults for ReActConfig. */
export function defaultReactConfig() {
    return defaultReActConfigData();
}

/** Return the flattened InviteConfig schema exposed under AgentData. */
function inviteConfigJSONSchema(): Record<string, unknown> {
    return {
        description: 'The invite config for the agent.',
        properties: {
            invitable: {
                default: false,
                description:
                    "Whether this agent may be borrowed into another agent's team via the ``AgentInvite`` tool. Independent from :attr:`invite_description` so the user can preserve an authored blurb while temporarily disabling the toggle. ``invitable=True`` requires a non-empty :attr:`invite_description` (enforced by validator).",
                title: 'Invitable',
                type: 'boolean',
            },
            invite_description: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
                default: null,
                description:
                    "Free-text blurb shown to a leader LLM in the ``AgentInvite`` tool description — used by the leader to decide whether to borrow this agent. Persisted across toggle off/on so the user's authored draft is not lost when :attr:`invitable` is temporarily disabled.",
                format: 'textarea',
                title: 'Invite Description',
            },
        },
        title: 'Invite Config',
        type: 'object',
    };
}
