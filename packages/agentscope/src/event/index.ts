import { z } from 'zod';

import { _generateId, _generateTimestamp } from '../_utils/common';
import {
    Base64Source,
    DataBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    URLSource,
} from '../message/block';
import { FinishedReason } from '../model/response';
import type { PermissionRule } from '../permission';
import { PermissionBehavior } from '../permission';
import { ErrorInfo, ErrorType, ReplyFinishedReason } from '../type';

export { ErrorType, ReplyFinishedReason } from '../type';
export type { ErrorInfo } from '../type';

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
    USER_INTERRUPT = 'USER_INTERRUPT',
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
    cache_input_tokens?: number;
    cache_creation_input_tokens?: number;
    finished_reason?: FinishedReason;
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
    block_id: string;
    media_type: string;
    data?: string | null;
    url?: string | null;
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

export interface UserInterruptEvent extends EventBase {
    type: EventType.USER_INTERRUPT;
    reply_id: string;
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
    | UserInterruptEvent
    | ExternalExecutionResultEvent
    // Custom events
    | CustomEvent;

/** @deprecated Use {@link ReplyFinishedReason} instead. */
export enum ReplyEndReason {
    COMPLETED = 'completed',
    INTERRUPTED = 'interrupted',
    EXCEED_MAX_ITERS = 'exceed_max_iters',
}

type BaseDefaults<T extends AgentEvent> = T extends AgentEvent
    ? Omit<T, keyof EventBase> & Partial<EventBase>
    : never;

type EventWithDefaults<T extends AgentEvent, K extends keyof T> = Omit<T, keyof EventBase | K> &
    Partial<EventBase> &
    Partial<Pick<T, K>>;

type SpecialDefaultEvent =
    | ReplyStartEvent
    | ReplyEndEvent
    | ModelCallEndEvent
    | ToolResultDataDeltaEvent
    | CustomEvent;

/** Input accepted by {@link createEvent}; output-only defaults are optional. */
export type AgentEventInput =
    | EventWithDefaults<ReplyStartEvent, 'role'>
    | EventWithDefaults<ReplyEndEvent, 'finished_reason' | 'error'>
    | EventWithDefaults<
          ModelCallEndEvent,
          'cache_input_tokens' | 'cache_creation_input_tokens' | 'finished_reason'
      >
    | EventWithDefaults<ToolResultDataDeltaEvent, 'block_id' | 'data' | 'url'>
    | EventWithDefaults<CustomEvent, 'value'>
    | BaseDefaults<Exclude<AgentEvent, SpecialDefaultEvent>>;

/**
 * Create a wire-compatible agent event and fill Python model defaults.
 *
 * Runtime construction is intentionally centralized so events crossing
 * process and persistence boundaries cannot silently omit protocol fields.
 * @param input
 * @returns A normalized agent event.
 */
export function createEvent(input: AgentEventInput): AgentEvent {
    const event = {
        ...input,
        id: input.id ?? _generateId(),
        created_at: input.created_at ?? _generateTimestamp(),
        metadata: input.metadata ?? {},
    } as AgentEvent;

    switch (event.type) {
        case EventType.REPLY_START:
            event.role ??= 'assistant';
            break;
        case EventType.REPLY_END:
            event.finished_reason ??= ReplyFinishedReason.COMPLETED;
            event.error ??= null;
            break;
        case EventType.MODEL_CALL_END:
            event.cache_input_tokens ??= 0;
            event.cache_creation_input_tokens ??= 0;
            event.finished_reason ??= FinishedReason.COMPLETED;
            break;
        case EventType.TOOL_RESULT_DATA_DELTA:
            if ((event.data == null) === (event.url == null)) {
                throw new Error('Exactly one of `data` or `url` must be provided.');
            }
            event.block_id ??= _generateId();
            event.data ??= null;
            event.url ??= null;
            break;
        case EventType.CUSTOM:
            event.value ??= {};
            break;
    }

    return event;
}

const eventBaseShape = {
    id: z.string().optional(),
    created_at: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
};

const permissionRuleSchema = z.object({
    tool_name: z.string(),
    rule_content: z.string().nullable(),
    behavior: z.nativeEnum(PermissionBehavior),
    source: z.string(),
});

const textBlockSchema = z
    .object({
        type: z.literal('text'),
        text: z.string(),
        id: z.string().optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => TextBlock(value));

const dataSourceSchema = z.union([
    z
        .object({
            type: z.literal('base64'),
            data: z.string(),
            media_type: z.string(),
        })
        .transform(value => Base64Source(value)),
    z
        .object({
            type: z.literal('url'),
            url: z.url(),
            media_type: z.string(),
        })
        .transform(value => URLSource(value)),
]);

const dataBlockSchema = z
    .object({
        type: z.literal('data'),
        source: dataSourceSchema,
        id: z.string().optional(),
        name: z.string().nullable().optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => DataBlock(value));

const toolCallBlockSchema = z
    .object({
        type: z.literal('tool_call'),
        id: z.string(),
        name: z.string(),
        input: z.string(),
        state: z.enum(['pending', 'asking', 'allowed', 'submitted', 'finished']).optional(),
        suggested_rules: z.array(permissionRuleSchema).optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => ToolCallBlock(value));

const toolResultBlockSchema = z
    .object({
        type: z.literal('tool_result'),
        id: z.string(),
        name: z.string(),
        output: z.union([z.string(), z.array(z.union([textBlockSchema, dataBlockSchema]))]),
        state: z.enum(['success', 'error', 'interrupted', 'denied', 'running']).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        created_at: z.string().optional(),
        finished_at: z.string().nullable().optional(),
    })
    .transform(value => ToolResultBlock(value));

const errorInfoSchema = z
    .object({
        type: z.nativeEnum(ErrorType).optional(),
        message: z.string(),
    })
    .transform(value => new ErrorInfo(value));

/**
 * Build a concrete event schema from its discriminator and payload shape.
 * @param type
 * @param shape
 * @returns A Zod object schema for the event.
 */
function eventSchema<T extends EventType, S extends z.ZodRawShape>(type: T, shape: S) {
    return z.object({ type: z.literal(type), ...eventBaseShape, ...shape });
}

const rawAgentEventSchema = z
    .union([
        eventSchema(EventType.REPLY_START, {
            session_id: z.string(),
            reply_id: z.string(),
            name: z.string(),
            role: z.enum(['user', 'assistant', 'system']).optional(),
        }),
        eventSchema(EventType.REPLY_END, {
            session_id: z.string(),
            reply_id: z.string(),
            finished_reason: z.nativeEnum(ReplyFinishedReason).optional(),
            error: errorInfoSchema.nullable().optional(),
        }),
        eventSchema(EventType.MODEL_CALL_START, {
            reply_id: z.string(),
            model_name: z.string(),
        }),
        eventSchema(EventType.MODEL_CALL_END, {
            reply_id: z.string(),
            input_tokens: z.number().int(),
            output_tokens: z.number().int(),
            cache_input_tokens: z.number().int().optional(),
            cache_creation_input_tokens: z.number().int().optional(),
            finished_reason: z.nativeEnum(FinishedReason).optional(),
        }),
        eventSchema(EventType.TEXT_BLOCK_START, {
            reply_id: z.string(),
            block_id: z.string(),
        }),
        eventSchema(EventType.TEXT_BLOCK_DELTA, {
            reply_id: z.string(),
            block_id: z.string(),
            delta: z.string(),
        }),
        eventSchema(EventType.TEXT_BLOCK_END, {
            reply_id: z.string(),
            block_id: z.string(),
        }),
        eventSchema(EventType.DATA_BLOCK_START, {
            reply_id: z.string(),
            block_id: z.string(),
            media_type: z.string(),
        }),
        eventSchema(EventType.DATA_BLOCK_DELTA, {
            reply_id: z.string(),
            block_id: z.string(),
            data: z.string(),
            media_type: z.string(),
        }),
        eventSchema(EventType.DATA_BLOCK_END, {
            reply_id: z.string(),
            block_id: z.string(),
        }),
        eventSchema(EventType.THINKING_BLOCK_START, {
            reply_id: z.string(),
            block_id: z.string(),
        }),
        eventSchema(EventType.THINKING_BLOCK_DELTA, {
            reply_id: z.string(),
            block_id: z.string(),
            delta: z.string(),
        }),
        eventSchema(EventType.THINKING_BLOCK_END, {
            reply_id: z.string(),
            block_id: z.string(),
        }),
        eventSchema(EventType.HINT_BLOCK, {
            reply_id: z.string(),
            block_id: z.string(),
            source: z.string().nullable().optional(),
            hint: z.union([z.string(), z.array(z.union([textBlockSchema, dataBlockSchema]))]),
        }),
        eventSchema(EventType.TOOL_CALL_START, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            tool_call_name: z.string(),
        }),
        eventSchema(EventType.TOOL_CALL_DELTA, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            delta: z.string(),
        }),
        eventSchema(EventType.TOOL_CALL_END, {
            reply_id: z.string(),
            tool_call_id: z.string(),
        }),
        eventSchema(EventType.TOOL_RESULT_START, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            tool_call_name: z.string(),
        }),
        eventSchema(EventType.TOOL_RESULT_TEXT_DELTA, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            delta: z.string(),
        }),
        eventSchema(EventType.TOOL_RESULT_DATA_DELTA, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            block_id: z.string().optional(),
            media_type: z.string(),
            data: z.string().nullable().optional(),
            url: z.url().nullable().optional(),
        }),
        eventSchema(EventType.TOOL_RESULT_END, {
            reply_id: z.string(),
            tool_call_id: z.string(),
            state: z.enum(['success', 'error', 'interrupted', 'denied', 'running']),
        }),
        eventSchema(EventType.EXCEED_MAX_ITERS, {
            reply_id: z.string(),
            name: z.string(),
        }),
        eventSchema(EventType.REQUIRE_USER_CONFIRM, {
            reply_id: z.string(),
            tool_calls: z.array(toolCallBlockSchema),
        }),
        eventSchema(EventType.REQUIRE_EXTERNAL_EXECUTION, {
            reply_id: z.string(),
            tool_calls: z.array(toolCallBlockSchema),
        }),
        eventSchema(EventType.USER_CONFIRM_RESULT, {
            reply_id: z.string(),
            confirm_results: z.array(
                z.object({
                    confirmed: z.boolean(),
                    tool_call: toolCallBlockSchema,
                    rules: z.array(permissionRuleSchema).nullable().optional(),
                })
            ),
        }),
        eventSchema(EventType.USER_INTERRUPT, { reply_id: z.string() }),
        eventSchema(EventType.EXTERNAL_EXECUTION_RESULT, {
            reply_id: z.string(),
            execution_results: z.array(toolResultBlockSchema),
        }),
        eventSchema(EventType.CUSTOM, {
            name: z.string(),
            value: z.record(z.string(), z.unknown()).optional(),
        }),
    ])
    .superRefine((event, context) => {
        if (
            event.type === EventType.TOOL_RESULT_DATA_DELTA &&
            (event.data == null) === (event.url == null)
        ) {
            context.addIssue({
                code: 'custom',
                message: 'Exactly one of `data` or `url` must be provided.',
            });
        }
    });

/** Runtime schema for untrusted snake_case agent event payloads. */
export const AgentEventSchema = rawAgentEventSchema.transform(value =>
    createEvent(value as AgentEventInput)
);

/**
 * Parse an untrusted snake_case agent event payload.
 * @param input
 * @returns A validated agent event.
 */
export function parseAgentEvent(input: unknown): AgentEvent {
    return AgentEventSchema.parse(input);
}
