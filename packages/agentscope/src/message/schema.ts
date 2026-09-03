import { z } from 'zod';

import { ErrorType, ReplyFinishedReason } from '../type';
import {
    Base64Source,
    DataBlock,
    HintBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
    URLSource,
} from './block';
import type { ContentBlock } from './block';
import { createMsg } from './message';
import type { Msg } from './message';

const entityFields = {
    id: z.string().optional(),
    created_at: z.string().optional(),
    finished_at: z.string().nullable().optional(),
};

const jsonRecordSchema = z.record(z.string(), z.json());

/** Runtime schema for Python-compatible text blocks. */
export const TextBlockSchema = z
    .object({
        type: z.literal('text'),
        text: z.string(),
        ...entityFields,
    })
    .transform(value => TextBlock(value));

/** Runtime schema for thinking blocks, including provider-specific fields. */
export const ThinkingBlockSchema = z
    .object({
        type: z.literal('thinking'),
        thinking: z.string(),
        ...entityFields,
    })
    .passthrough()
    .transform(value => ThinkingBlock(value));

/** Runtime schema for inline base64 sources. */
export const Base64SourceSchema = z
    .object({
        type: z.literal('base64'),
        data: z.string(),
        media_type: z.string(),
    })
    .transform(value => Base64Source(value));

/** Runtime schema for URL sources. */
export const URLSourceSchema = z
    .object({
        type: z.literal('url'),
        url: z.url(),
        media_type: z.string(),
    })
    .transform(value => URLSource(value));

export const DataSourceSchema = z.union([Base64SourceSchema, URLSourceSchema]);

/** Runtime schema for binary data blocks. */
export const DataBlockSchema = z
    .object({
        type: z.literal('data'),
        source: DataSourceSchema,
        name: z.string().nullable().optional(),
        ...entityFields,
    })
    .transform(value => DataBlock(value));

const hintContentSchema = z.union([
    z.string(),
    z.array(z.union([TextBlockSchema, DataBlockSchema])),
]);

/** Runtime schema for one-shot hint blocks. */
export const HintBlockSchema = z
    .object({
        type: z.literal('hint'),
        hint: hintContentSchema,
        source: z.string().nullable().optional(),
        ...entityFields,
    })
    .transform(value => HintBlock(value));

/** Runtime schema for tool-call blocks. */
export const ToolCallBlockSchema = z
    .object({
        type: z.literal('tool_call'),
        id: z.string(),
        name: z.string(),
        input: z.string(),
        state: z.enum(['pending', 'asking', 'allowed', 'submitted', 'finished']).optional(),
        suggested_rules: z.array(z.unknown()).optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => ToolCallBlock(value as Parameters<typeof ToolCallBlock>[0]));

/** Runtime schema for tool-result blocks. */
export const ToolResultBlockSchema = z
    .object({
        type: z.literal('tool_result'),
        id: z.string(),
        name: z.string(),
        output: z.union([z.string(), z.array(z.union([TextBlockSchema, DataBlockSchema]))]),
        state: z.enum(['success', 'error', 'interrupted', 'denied', 'running']).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => ToolResultBlock(value));

/** Runtime schema for all message content blocks. */
export const ContentBlockSchema = z.union([
    TextBlockSchema,
    ThinkingBlockSchema,
    HintBlockSchema,
    ToolCallBlockSchema,
    ToolResultBlockSchema,
    DataBlockSchema,
]);

export const UsageSchema = z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_input_tokens: z.number().int().default(0),
    cache_creation_input_tokens: z.number().int().default(0),
});

export const MsgSchema = z
    .object({
        name: z.string(),
        content: z.array(ContentBlockSchema),
        role: z.enum(['user', 'assistant', 'system']),
        id: z.string().optional(),
        metadata: jsonRecordSchema.optional(),
        created_at: z.string().optional(),
        usage: UsageSchema.nullable().optional(),
        finished_at: z.string().nullable().optional(),
        finished_reason: z.nativeEnum(ReplyFinishedReason).nullable().optional(),
        structured_output: jsonRecordSchema.nullable().optional(),
        error: z
            .object({
                type: z.nativeEnum(ErrorType).default(ErrorType.UNKNOWN),
                message: z.string(),
            })
            .nullable()
            .optional(),
    })
    .transform(value => createMsg(value));

/**
 * Parse an untrusted snake_case content-block payload.
 * @param input
 * @returns A validated content block.
 */
export function parseContentBlock(input: unknown): ContentBlock {
    return ContentBlockSchema.parse(input) as ContentBlock;
}

/**
 * Parse an untrusted snake_case message payload.
 * @param input
 * @returns A validated message.
 */
export function parseMsg(input: unknown): Msg {
    return MsgSchema.parse(input) as Msg;
}
