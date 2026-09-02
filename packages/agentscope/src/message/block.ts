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
    name?: string;
    /** ISO-8601 creation timestamp of the block. */
    created_at: string;
    /** ISO-8601 finished timestamp of the block. */
    finished_at?: string | null;
}

export type ContentBlock =
    | TextBlock
    | ThinkingBlock
    | HintBlock
    | ToolCallBlock
    | ToolResultBlock
    | DataBlock;
