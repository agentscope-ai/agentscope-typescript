import { _generateId, _generateTimestamp } from '../_utils/common';
import type { PermissionRule } from '../permission';

export interface TextBlock {
    type: 'text';
    text: string;
    id: string;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

export interface ThinkingBlock {
    [key: string]: unknown;
    type: 'thinking';
    thinking: string;
    id: string;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

/**
 * A block used to provide instructions or hints to the LLM during the
 * reasoning-acting loop. When passed to the LLM API, the hint block is
 * converted into a user message.
 *
 * The `hint` field can be a plain string (text-only) or a list of
 * {@link TextBlock} / {@link DataBlock} for multimodal content
 * (e.g. a background tool result containing both text and an image).
 */
export interface HintBlock {
    type: 'hint';
    /** Plain text, or a list of content blocks for multimodal data. */
    hint: string | (TextBlock | DataBlock)[];
    id: string;
    /**
     * The sender or origin of this hint. For team messages this is the
     * sender's display name (e.g. `"alice"`); for system notifications
     * it may be `"system"` or `null`/omitted.
     */
    source?: string | null;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

export type ToolCallState = 'pending' | 'asking' | 'allowed' | 'submitted' | 'finished';

export interface ToolCallBlock {
    type: 'tool_call';
    name: string;
    id: string;
    input: string;
    state: ToolCallState;
    suggested_rules?: PermissionRule[];
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

export type ToolResultState = 'success' | 'error' | 'interrupted' | 'denied' | 'running';

export interface ToolResultBlock {
    type: 'tool_result';
    id: string;
    name: string;
    output: string | (TextBlock | DataBlock)[];
    state: ToolResultState;
    metadata?: Record<string, unknown>;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

export interface Base64Source {
    type: 'base64';
    data: string;
    media_type: string;
}

export interface URLSource {
    type: 'url';
    url: string;
    media_type: string;
}

export interface DataBlock {
    type: 'data';
    source: Base64Source | URLSource;
    id: string;
    name?: string | null;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

type GeneratedBlockFields = 'type' | 'id' | 'created_at' | 'finished_at';

/**
 * Create a text block with the same defaults as Python's `TextBlock`.
 * @param input
 * @returns A normalized text block.
 */
export function TextBlock(
    input: Omit<TextBlock, GeneratedBlockFields> &
        Partial<Pick<TextBlock, 'id' | 'created_at' | 'finished_at'>>
): TextBlock {
    return {
        type: 'text',
        text: input.text,
        id: input.id ?? _generateId(),
        created_at: input.created_at ?? _generateTimestamp(),
        finished_at: input.finished_at ?? null,
    };
}

/**
 * Create a thinking block while preserving provider-specific fields.
 * @param input
 * @param input.thinking
 * @param input.id
 * @param input.created_at
 * @param input.finished_at
 * @returns A normalized thinking block.
 */
export function ThinkingBlock(input: {
    thinking: string;
    id?: string;
    created_at?: string;
    finished_at?: string | null;
    [key: string]: unknown;
}): ThinkingBlock {
    return {
        ...input,
        type: 'thinking',
        thinking: input.thinking,
        id: input.id ?? _generateId(),
        created_at: input.created_at ?? _generateTimestamp(),
        finished_at: input.finished_at ?? null,
    };
}

/**
 * Create an inline base64 data source.
 * @param input
 * @returns A normalized base64 source.
 */
export function Base64Source(input: Omit<Base64Source, 'type'>): Base64Source {
    return { type: 'base64', data: input.data, media_type: input.media_type };
}

/**
 * Create and validate a URL data source.
 * @param input
 * @returns A normalized URL source.
 */
export function URLSource(input: Omit<URLSource, 'type'>): URLSource {
    const url = new URL(input.url).toString();
    return { type: 'url', url, media_type: input.media_type };
}

/**
 * Create a binary data block with Python-compatible defaults.
 * @param input
 * @returns A normalized data block.
 */
export function DataBlock(
    input: Omit<DataBlock, GeneratedBlockFields | 'name'> &
        Partial<Pick<DataBlock, 'id' | 'name' | 'created_at' | 'finished_at'>>
): DataBlock {
    return {
        type: 'data',
        id: input.id ?? _generateId(),
        source: input.source,
        name: input.name ?? null,
        created_at: input.created_at ?? _generateTimestamp(),
        finished_at: input.finished_at ?? null,
    };
}

/**
 * Create a one-shot hint block with Python-compatible defaults.
 * @param input
 * @returns A normalized hint block.
 */
export function HintBlock(
    input: Omit<HintBlock, GeneratedBlockFields | 'source'> &
        Partial<Pick<HintBlock, 'id' | 'source' | 'created_at' | 'finished_at'>>
): HintBlock {
    const createdAt = input.created_at ?? _generateTimestamp();
    return {
        type: 'hint',
        hint: input.hint,
        id: input.id ?? _generateId(),
        source: input.source ?? null,
        created_at: createdAt,
        finished_at: input.finished_at === undefined ? _generateTimestamp() : input.finished_at,
    };
}

/**
 * Create a tool-call block with Python-compatible defaults.
 * @param input
 * @returns A normalized tool-call block.
 */
export function ToolCallBlock(
    input: Omit<
        ToolCallBlock,
        'type' | 'state' | 'suggested_rules' | 'created_at' | 'finished_at'
    > &
        Partial<Pick<ToolCallBlock, 'state' | 'suggested_rules' | 'created_at' | 'finished_at'>>
): ToolCallBlock {
    return {
        type: 'tool_call',
        id: input.id,
        name: input.name,
        input: input.input,
        state: input.state ?? 'pending',
        suggested_rules: input.suggested_rules ?? [],
        created_at: input.created_at ?? _generateTimestamp(),
        finished_at: input.finished_at ?? null,
    };
}

/**
 * Create a tool-result block with Python-compatible defaults.
 * @param input
 * @returns A normalized tool-result block.
 */
export function ToolResultBlock(
    input: Omit<ToolResultBlock, 'type' | 'state' | 'metadata' | 'created_at' | 'finished_at'> &
        Partial<Pick<ToolResultBlock, 'state' | 'metadata' | 'created_at' | 'finished_at'>>
): ToolResultBlock {
    return {
        type: 'tool_result',
        id: input.id,
        name: input.name,
        output: input.output,
        state: input.state ?? 'running',
        metadata: input.metadata ?? {},
        created_at: input.created_at ?? _generateTimestamp(),
        finished_at: input.finished_at ?? null,
    };
}

export type ContentBlock =
    | TextBlock
    | ThinkingBlock
    | HintBlock
    | ToolCallBlock
    | ToolResultBlock
    | DataBlock;

export type ContentBlockType = ContentBlock['type'];
