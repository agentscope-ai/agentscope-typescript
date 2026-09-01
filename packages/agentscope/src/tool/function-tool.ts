import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionContext, PermissionDecision } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission/runtime';
import type { ToolInputSchema } from '../type';
import { ToolBase, ToolBaseOptions, ToolChunkStream } from './base';
import { ToolChunk } from './response';
import { removeSchemaTitles } from './utils';

export type FunctionToolResult = unknown;
export type FunctionToolHandler<TInput extends Record<string, unknown>> = (
    input: TInput
) =>
    | FunctionToolResult
    | Promise<FunctionToolResult>
    | Generator<FunctionToolResult, void, void>
    | AsyncGenerator<FunctionToolResult, void, void>;

export interface FunctionToolOptions<
    TInput extends Record<string, unknown>,
> extends ToolBaseOptions {
    func: FunctionToolHandler<TInput>;
    name?: string;
    description?: string;
    inputSchema?: z.ZodObject | ToolInputSchema;
    isConcurrencySafe?: boolean;
    isReadOnly?: boolean;
    isStateInjected?: boolean;
}

/** Adapt an idiomatic TypeScript function to the ToolBase protocol. */
export class FunctionTool<
    TInput extends Record<string, unknown> = Record<string, unknown>,
> extends ToolBase {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodObject | ToolInputSchema;
    readonly isConcurrencySafe: boolean;
    readonly isReadOnly: boolean;
    override isStateInjected: boolean;
    private readonly func: FunctionToolHandler<TInput>;

    /**
     * Create a function adapter.
     * @param options Adapter configuration.
     */
    constructor(options: FunctionToolOptions<TInput>) {
        super({ middlewares: options.middlewares });
        this.func = options.func;
        this.name = options.name ?? options.func.name;
        this.description = options.description ?? '';
        this.inputSchema = normalizeSchema(options.inputSchema ?? z.object({}));
        this.isConcurrencySafe = options.isConcurrencySafe ?? true;
        this.isReadOnly = options.isReadOnly ?? false;
        this.isStateInjected = options.isStateInjected ?? false;
    }

    /**
     * Custom functions require explicit user approval by default.
     * @param _toolInput Tool input.
     * @param _context Permission context.
     * @returns An ASK decision.
     */
    checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): PermissionDecision {
        return createPermissionDecision({
            behavior: PermissionBehavior.ASK,
            message: 'Custom function tools must be explicitly allowed by the user.',
        });
    }

    /**
     * Invoke and normalize the wrapped function.
     * @param input Validated input object.
     * @returns One chunk or an asynchronous chunk stream.
     */
    override async call(input: Record<string, unknown>): Promise<ToolChunk | ToolChunkStream> {
        const result = await this.func(input as TInput);
        if (isAsyncIterable(result)) return this.convertAsyncIterable(result);
        if (isIterable(result)) return this.convertIterable(result);
        return toToolChunk(result);
    }

    /**
     * Convert an async iterable without buffering it.
     * @param iterable
     */
    private async *convertAsyncIterable(iterable: AsyncIterable<unknown>): ToolChunkStream {
        for await (const value of iterable) yield toToolChunk(value);
    }

    /**
     * Convert a synchronous iterable without buffering it.
     * @param iterable
     */
    private async *convertIterable(iterable: Iterable<unknown>): ToolChunkStream {
        for (const value of iterable) yield toToolChunk(value);
    }
}

/**
 * Normalize one arbitrary function result into a tool chunk.
 * @param result
 * @returns A normalized chunk.
 */
function toToolChunk(result: unknown): ToolChunk {
    if (result instanceof ToolChunk) return result;
    let text: string;
    if (typeof result === 'string') text = result;
    else if (result === undefined) text = 'null';
    else {
        try {
            text = JSON.stringify(result) ?? String(result);
        } catch {
            text = String(result);
        }
    }
    return new ToolChunk({ content: [TextBlock({ text })] });
}

/**
 * Return whether a value is an asynchronous iterable.
 * @param value
 * @returns Whether the value is async iterable.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Return whether a non-string value is a synchronous iterable.
 * @param value
 * @returns Whether the value is iterable.
 */
function isIterable(value: unknown): value is Iterable<unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        Symbol.iterator in value &&
        typeof value !== 'string'
    );
}

/**
 * Normalize JSON schemas while preserving Zod validation at invocation sites.
 * @param schema
 * @returns A normalized schema.
 */
function normalizeSchema(schema: z.ZodObject | ToolInputSchema): z.ZodObject | ToolInputSchema {
    return schema instanceof z.ZodObject ? schema : removeSchemaTitles(structuredClone(schema));
}
