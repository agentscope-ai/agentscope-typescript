import { z } from 'zod';

import { _generateId } from '../_utils/common';
import {
    DataBlockSchema,
    MsgSchema,
    TextBlockSchema,
    createMsg,
    getContentBlocks,
} from '../message';
import type {
    ContentBlock,
    DataBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
} from '../message';
import type { Msg } from '../message';
import { createPermissionContext } from '../permission';
import type { PermissionContext } from '../permission';
import { TaskSchema } from './task';
import type { Task } from './task';
import { ToolContext } from './tool-context';
import type { ToolContextWire } from './tool-context';

export type JSONSchema = Record<string, unknown>;
export type StructuredSchema = z.ZodType | JSONSchema | null;

export interface ReplyContextWire {
    reply_id: string;
    cur_iter: number;
    structured_schema: JSONSchema | null;
    structured_output: Record<string, unknown> | null;
}

/** Reply-scoped iteration and structured-output state. */
export class ReplyContext {
    replyId: string;
    curIter: number;
    structuredSchema: StructuredSchema;
    structuredOutput: Record<string, unknown> | null;

    /**
     * Create a reply context.
     * @param options
     * @param options.replyId
     * @param options.curIter
     * @param options.structuredSchema
     * @param options.structuredOutput
     */
    constructor(
        options: {
            replyId?: string;
            curIter?: number;
            structuredSchema?: StructuredSchema;
            structuredOutput?: Record<string, unknown> | null;
        } = {}
    ) {
        this.replyId = options.replyId ?? _generateId();
        this.curIter = options.curIter ?? 0;
        this.structuredSchema = options.structuredSchema ?? null;
        this.structuredOutput = options.structuredOutput ?? null;
    }

    /**
     * Serialize the reply context.
     * @returns The Python-compatible reply-context representation.
     */
    toJSON(): ReplyContextWire {
        const structuredSchema =
            this.structuredSchema instanceof z.ZodType
                ? (z.toJSONSchema(this.structuredSchema) as JSONSchema)
                : this.structuredSchema;
        return {
            reply_id: this.replyId,
            cur_iter: this.curIter,
            structured_schema: structuredSchema,
            structured_output: this.structuredOutput,
        };
    }
}

export interface TaskContextWire {
    tasks: Task[];
}

/** Collection of tasks persisted in agent state. */
export class TaskContext {
    tasks: Task[];

    /**
     * Create a task context.
     * @param options
     * @param options.tasks
     */
    constructor(options: { tasks?: Task[] } = {}) {
        this.tasks = options.tasks ?? [];
    }

    /**
     * Serialize the task context.
     * @returns The Python-compatible task-context representation.
     */
    toJSON(): TaskContextWire {
        return { tasks: this.tasks };
    }
}

export type StateSummary = string | Array<TextBlock | DataBlock>;

export interface AgentStateWire {
    session_id: string;
    summary: StateSummary;
    context: Msg[];
    reply_context: ReplyContextWire;
    permission_context: PermissionContext;
    tool_context: ToolContextWire;
    tasks_context: TaskContextWire;
    middle_context: Record<string, unknown>;
}

export interface AgentStateOptions {
    sessionId?: string;
    summary?: StateSummary;
    context?: Msg[];
    replyContext?: ReplyContext;
    permissionContext?: PermissionContext;
    toolContext?: ToolContext;
    tasksContext?: TaskContext;
    middleContext?: Record<string, unknown>;
}

/** Complete serializable state owned by one agent session. */
export class AgentState {
    sessionId: string;
    summary: StateSummary;
    context: Msg[];
    replyContext: ReplyContext;
    permissionContext: PermissionContext;
    toolContext: ToolContext;
    tasksContext: TaskContext;
    middleContext: Record<string, unknown>;

    /**
     * Create complete agent state.
     * @param options
     */
    constructor(options: AgentStateOptions = {}) {
        this.sessionId = options.sessionId ?? _generateId();
        this.summary = options.summary ?? '';
        this.context = options.context ?? [];
        this.replyContext = options.replyContext ?? new ReplyContext();
        this.permissionContext = options.permissionContext ?? createPermissionContext();
        this.toolContext = options.toolContext ?? new ToolContext();
        this.tasksContext = options.tasksContext ?? new TaskContext();
        this.middleContext = options.middleContext ?? {};
    }

    /**
     * Read the current reply identifier.
     * @returns The current reply identifier.
     */
    get replyId(): string {
        return this.replyContext.replyId;
    }

    /** Set the current reply identifier. */
    set replyId(value: string) {
        this.replyContext.replyId = value;
    }

    /**
     * Read the current reasoning-acting iteration.
     * @returns The current reasoning-acting iteration.
     */
    get curIter(): number {
        return this.replyContext.curIter;
    }

    /** Set the current reasoning-acting iteration. */
    set curIter(value: number) {
        this.replyContext.curIter = value;
    }

    /**
     * Append blocks to this reply's tail assistant message.
     * @param options Agent name and blocks.
     * @param options.name
     * @param options.blocks
     */
    appendContext(options: {
        name: string;
        blocks: Array<
            | TextBlock
            | DataBlock
            | ToolCallBlock
            | ToolResultBlock
            | Extract<ContentBlock, { type: 'hint' }>
        >;
    }): void {
        const latest = this.context.at(-1);
        if (
            latest?.role === 'assistant' &&
            latest.name === options.name &&
            latest.id === this.replyId
        ) {
            latest.content.push(...options.blocks);
            return;
        }
        this.context.push(
            createMsg({
                id: this.replyId,
                role: 'assistant',
                name: options.name,
                content: options.blocks,
            })
        );
    }

    /**
     * Check whether the tail has calls waiting on outside input.
     * @param options Agent name to inspect.
     * @param options.name
     * @returns Whether an awaiting call exists.
     */
    hasAwaitingToolCalls(options: { name: string }): boolean {
        return this.getAwaitingToolCalls(options).length > 0;
    }

    /**
     * Get asking or unresolved submitted tool calls from the tail message.
     * @param options Agent name to inspect.
     * @param options.name
     * @returns Awaiting tool calls.
     */
    getAwaitingToolCalls(options: { name: string }): ToolCallBlock[] {
        const latest = this.context.at(-1);
        if (latest?.role !== 'assistant' || latest.name !== options.name) return [];
        const resultIds = new Set(getContentBlocks(latest, 'tool_result').map(result => result.id));
        return getContentBlocks(latest, 'tool_call').filter(
            call =>
                call.state === 'asking' || (call.state === 'submitted' && !resultIds.has(call.id))
        );
    }

    /**
     * Get current-reply tool calls without matching results.
     * @param options Agent name to inspect.
     * @param options.name
     * @returns Unfinished tool calls.
     */
    getUnfinishedToolCalls(options: { name: string }): ToolCallBlock[] {
        const latest = this.context.at(-1);
        if (
            latest?.role !== 'assistant' ||
            latest.name !== options.name ||
            latest.id !== this.replyId
        ) {
            return [];
        }
        const resultIds = new Set(getContentBlocks(latest, 'tool_result').map(result => result.id));
        return getContentBlocks(latest, 'tool_call').filter(call => !resultIds.has(call.id));
    }

    /**
     * Serialize complete agent state.
     * @returns The Python-compatible persisted state.
     */
    toJSON(): AgentStateWire {
        return {
            session_id: this.sessionId,
            summary: this.summary,
            context: this.context,
            reply_context: this.replyContext.toJSON(),
            permission_context: this.permissionContext,
            tool_context: this.toolContext.toJSON(),
            tasks_context: this.tasksContext.toJSON(),
            middle_context: this.middleContext,
        };
    }
}

const permissionContextSchema = z.object({
    mode: z.enum(['default', 'accept_edits', 'explore', 'bypass', 'dont_ask']).default('default'),
    working_directories: z
        .record(z.string(), z.object({ path: z.string(), source: z.string() }))
        .default({}),
    allow_rules: z.record(z.string(), z.array(z.unknown())).default({}),
    deny_rules: z.record(z.string(), z.array(z.unknown())).default({}),
    ask_rules: z.record(z.string(), z.array(z.unknown())).default({}),
});

const replyContextSchema = z.object({
    reply_id: z.string().optional(),
    cur_iter: z.number().int().optional(),
    structured_schema: z.record(z.string(), z.unknown()).nullable().optional(),
    structured_output: z.record(z.string(), z.unknown()).nullable().optional(),
});

const toolContextSchema = z.object({
    max_cache_files: z.number().int().optional(),
    max_cache_bytes: z.number().optional(),
    read_file_cache: z
        .array(
            z.object({
                lines: z.array(z.string()),
                updated_at: z.number(),
                bytes: z.number(),
                file_path: z.string(),
            })
        )
        .optional(),
    activated_groups: z.array(z.string()).optional(),
});

const legacyStateSchema = z.preprocess(
    input => {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
        const data = { ...(input as Record<string, unknown>) };
        const replyContext =
            typeof data.reply_context === 'object' && data.reply_context !== null
                ? { ...(data.reply_context as Record<string, unknown>) }
                : {};
        if (replyContext.reply_id === undefined && data.reply_id !== undefined) {
            replyContext.reply_id = data.reply_id;
        }
        if (replyContext.cur_iter === undefined && data.cur_iter !== undefined) {
            replyContext.cur_iter = data.cur_iter;
        }
        data.reply_context = replyContext;
        return data;
    },
    z.object({
        session_id: z.string().optional(),
        summary: z
            .union([z.string(), z.array(z.union([TextBlockSchema, DataBlockSchema]))])
            .optional(),
        context: z.array(MsgSchema).optional(),
        reply_context: replyContextSchema.optional(),
        permission_context: permissionContextSchema.optional(),
        tool_context: toolContextSchema.optional(),
        tasks_context: z.object({ tasks: z.array(TaskSchema).optional() }).optional(),
        middle_context: z.record(z.string(), z.unknown()).optional(),
    })
);

/** Runtime schema for legacy and current Python state payloads. */
export const AgentStateSchema = legacyStateSchema.transform(value => {
    const reply = value.reply_context;
    return new AgentState({
        sessionId: value.session_id,
        summary: value.summary,
        context: value.context,
        replyContext: new ReplyContext({
            replyId: reply?.reply_id,
            curIter: reply?.cur_iter,
            structuredSchema: reply?.structured_schema,
            structuredOutput: reply?.structured_output,
        }),
        permissionContext: value.permission_context as PermissionContext | undefined,
        toolContext: ToolContext.fromJSON(value.tool_context),
        tasksContext: new TaskContext({ tasks: value.tasks_context?.tasks }),
        middleContext: value.middle_context,
    });
});

/**
 * Parse current or legacy Python-compatible agent state.
 * @param input Untrusted persisted state.
 * @returns A validated agent state.
 */
export function parseAgentState(input: unknown): AgentState {
    return AgentStateSchema.parse(input);
}
