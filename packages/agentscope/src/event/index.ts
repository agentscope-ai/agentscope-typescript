import type { DataBlock, TextBlock, ToolCallBlock, ToolResultBlock } from '../message/block';
import type { PermissionRule } from '../permission';

export enum EventType {
    REPLY_START = 'REPLY_START',
    REPLY_END = 'REPLY_END',

    MODEL_CALL_START = 'MODEL_CALL_START',
    MODEL_CALL_END = 'MODEL_CALL_END',

    TEXT_BLOCK_START = 'TEXT_BLOCK_START',
    TEXT_BLOCK_DELTA = 'TEXT_BLOCK_DELTA',
    TEXT_BLOCK_END = 'TEXT_BLOCK_END',

    DATA_BLOCK_START = 'DATA_BLOCK_START',
    DATA_BLOCK_DELTA = 'DATA_BLOCK_DELTA',
    DATA_BLOCK_END = 'DATA_BLOCK_END',

    THINKING_BLOCK_START = 'THINKING_BLOCK_START',
    THINKING_BLOCK_DELTA = 'THINKING_BLOCK_DELTA',
    THINKING_BLOCK_END = 'THINKING_BLOCK_END',

    HINT_BLOCK = 'HINT_BLOCK',

    TOOL_CALL_START = 'TOOL_CALL_START',
    TOOL_CALL_DELTA = 'TOOL_CALL_DELTA',
    TOOL_CALL_END = 'TOOL_CALL_END',

    TOOL_RESULT_START = 'TOOL_RESULT_START',
    TOOL_RESULT_TEXT_DELTA = 'TOOL_RESULT_TEXT_DELTA',
    TOOL_RESULT_DATA_DELTA = 'TOOL_RESULT_DATA_DELTA',
    TOOL_RESULT_END = 'TOOL_RESULT_END',

    EXCEED_MAX_ITERS = 'EXCEED_MAX_ITERS',

    REQUIRE_USER_CONFIRM = 'REQUIRE_USER_CONFIRM',
    REQUIRE_EXTERNAL_EXECUTION = 'REQUIRE_EXTERNAL_EXECUTION',

    USER_CONFIRM_RESULT = 'USER_CONFIRM_RESULT',
    EXTERNAL_EXECUTION_RESULT = 'EXTERNAL_EXECUTION_RESULT',

    CUSTOM = 'CUSTOM',
}

export interface EventBase {
    id: string;
    created_at: string;
    metadata?: Record<string, unknown>;
}

export interface ReplyStartEvent extends EventBase {
    type: EventType.REPLY_START;
    session_id: string;
    reply_id: string;
    name: string;
    role: 'user' | 'assistant' | 'system';
}

/** The reason a reply finished. */
export enum ReplyFinishedReason {
    COMPLETED = 'completed',
    INTERRUPTED = 'interrupted',
    EXCEED_MAX_ITERS = 'exceed_max_iters',
    ERROR = 'error',
}

/**
 * Classification of a fatal error that terminated a reply.
 *
 * Not model-specific: the status-derived members apply to any upstream
 * service reached during a reply (chat model, embedding, TTS, MCP).
 */
export enum ErrorType {
    /** 401 — credential missing or wrong. */
    AUTHENTICATION = 'authentication',
    /** 403 — authenticated but not allowed. */
    PERMISSION = 'permission',
    /** 429 — rate/quota exceeded. */
    RATE_LIMIT = 'rate_limit',
    /** 400 / 422 — malformed request. */
    INVALID_REQUEST = 'invalid_request',
    /** 5xx — an upstream service failed. */
    UPSTREAM = 'upstream',
    /** Network error / timeout — no HTTP status available. */
    CONNECTION = 'connection',
    /** Framework bug or otherwise unexpected exception. */
    INTERNAL = 'internal',
    /** Fallback when no better classification is possible. */
    UNKNOWN = 'unknown',
}

/** Structured, UI-facing description of a fatal reply error. */
export interface ErrorInfo {
    /** Stable classification key; the frontend localizes off it. */
    type: ErrorType;
    /** Short, sanitized, human-readable description. */
    message: string;
}

export interface ReplyEndEvent extends EventBase {
    type: EventType.REPLY_END;
    session_id: string;
    reply_id: string;
    /** The reason this reply finished. */
    finished_reason: ReplyFinishedReason;
    /**
     * Structured error info, populated only when
     * `finished_reason === ReplyFinishedReason.ERROR`.
     */
    error?: ErrorInfo | null;
}

export interface ModelCallStartEvent extends EventBase {
    type: EventType.MODEL_CALL_START;
    reply_id: string;
    model_name: string;
}

export interface ModelCallEndEvent extends EventBase {
    type: EventType.MODEL_CALL_END;
    reply_id: string;
    input_tokens: number;
    output_tokens: number;
}

export interface TextBlockStartEvent extends EventBase {
    type: EventType.TEXT_BLOCK_START;
    block_id: string;
    reply_id: string;
}

export interface TextBlockDeltaEvent extends EventBase {
    type: EventType.TEXT_BLOCK_DELTA;
    reply_id: string;
    block_id: string;
    delta: string;
}

export interface TextBlockEndEvent extends EventBase {
    type: EventType.TEXT_BLOCK_END;
    reply_id: string;
    block_id: string;
}

export interface DataBlockStartEvent extends EventBase {
    type: EventType.DATA_BLOCK_START;
    reply_id: string;
    block_id: string;
    media_type: string;
}

export interface DataBlockDeltaEvent extends EventBase {
    type: EventType.DATA_BLOCK_DELTA;
    reply_id: string;
    block_id: string;
    data: string;
    media_type: string;
}

export interface DataBlockEndEvent extends EventBase {
    type: EventType.DATA_BLOCK_END;
    reply_id: string;
    block_id: string;
}

export interface ThinkingBlockStartEvent extends EventBase {
    type: EventType.THINKING_BLOCK_START;
    reply_id: string;
    block_id: string;
}

export interface ThinkingBlockDeltaEvent extends EventBase {
    type: EventType.THINKING_BLOCK_DELTA;
    reply_id: string;
    block_id: string;
    delta: string;
}

export interface ThinkingBlockEndEvent extends EventBase {
    type: EventType.THINKING_BLOCK_END;
    reply_id: string;
    block_id: string;
}

/**
 * One-shot hint block event.
 *
 * Unlike text/thinking blocks, hint blocks are not streamed — the
 * full content is available at creation time (team messages,
 * background tool results, user interruptions, …). A single event
 * carries the complete {@link HintBlock} content.
 */
export interface HintBlockEvent extends EventBase {
    type: EventType.HINT_BLOCK;
    reply_id: string;
    block_id: string;
    /** Sender or origin of this hint (e.g. `"alice"`, `"system"`). */
    source?: string | null;
    /** Complete hint content — `string` or `(TextBlock | DataBlock)[]`. */
    hint: string | (TextBlock | DataBlock)[];
}

export interface ToolCallStartEvent extends EventBase {
    type: EventType.TOOL_CALL_START;
    reply_id: string;
    tool_call_id: string;
    tool_call_name: string;
}

export interface ToolCallDeltaEvent extends EventBase {
    type: EventType.TOOL_CALL_DELTA;
    reply_id: string;
    tool_call_id: string;
    delta: string;
}

export interface ToolCallEndEvent extends EventBase {
    type: EventType.TOOL_CALL_END;
    reply_id: string;
    tool_call_id: string;
}

export interface ToolResultStartEvent extends EventBase {
    type: EventType.TOOL_RESULT_START;
    reply_id: string;
    tool_call_id: string;
    tool_call_name: string;
}

export interface ToolResultTextDeltaEvent extends EventBase {
    type: EventType.TOOL_RESULT_TEXT_DELTA;
    reply_id: string;
    tool_call_id: string;
    delta: string;
}

export interface ToolResultDataDeltaEvent extends EventBase {
    type: EventType.TOOL_RESULT_DATA_DELTA;
    reply_id: string;
    tool_call_id: string;
    /** Auto-generated in {@link appendEvent} when not provided. */
    block_id?: string;
    media_type: string;
    data?: string;
    url?: string;
}

export interface ToolResultEndEvent extends EventBase {
    type: EventType.TOOL_RESULT_END;
    reply_id: string;
    tool_call_id: string;
    state: ToolResultBlock['state'];
    metadata?: Record<string, unknown>;
}

export interface ExceedMaxItersEvent extends EventBase {
    type: EventType.EXCEED_MAX_ITERS;
    reply_id: string;
    name: string;
}

export interface RequireUserConfirmEvent extends EventBase {
    type: EventType.REQUIRE_USER_CONFIRM;
    reply_id: string;
    tool_calls: ToolCallBlock[];
}

export interface RequireExternalExecutionEvent extends EventBase {
    type: EventType.REQUIRE_EXTERNAL_EXECUTION;
    reply_id: string;
    tool_calls: ToolCallBlock[];
}

export interface ConfirmResult {
    confirmed: boolean;
    tool_call: ToolCallBlock;
    rules?: PermissionRule[] | null;
}

export interface UserConfirmResultEvent extends EventBase {
    type: EventType.USER_CONFIRM_RESULT;
    reply_id: string;
    confirm_results: ConfirmResult[];
}

export interface ExternalExecutionResultEvent extends EventBase {
    type: EventType.EXTERNAL_EXECUTION_RESULT;
    reply_id: string;
    execution_results: ToolResultBlock[];
}

/**
 * A custom event carrying an arbitrary name and payload.
 * Mirrors the Python `agentscope.event.CustomEvent` model.
 */
export interface CustomEvent extends EventBase {
    type: EventType.CUSTOM;
    name: string;
    value: Record<string, unknown>;
}

export type AgentEvent =
    // The control events for the whole run
    | ReplyStartEvent
    | ReplyEndEvent
    | ExceedMaxItersEvent
    | RequireUserConfirmEvent
    | RequireExternalExecutionEvent
    | ModelCallStartEvent
    | ModelCallEndEvent
    // The data events for different block types
    | TextBlockStartEvent
    | TextBlockDeltaEvent
    | TextBlockEndEvent
    | DataBlockStartEvent
    | DataBlockDeltaEvent
    | DataBlockEndEvent
    | ThinkingBlockStartEvent
    | ThinkingBlockDeltaEvent
    | ThinkingBlockEndEvent
    | HintBlockEvent
    | ToolCallStartEvent
    | ToolCallDeltaEvent
    | ToolCallEndEvent
    | ToolResultStartEvent
    | ToolResultTextDeltaEvent
    | ToolResultDataDeltaEvent
    | ToolResultEndEvent
    // The events from the external execution or user confirmation
    | UserConfirmResultEvent
    | ExternalExecutionResultEvent
    // Custom events
    | CustomEvent;
