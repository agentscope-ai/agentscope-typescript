import { z } from 'zod';

import { _generateId, _generateTimestamp, base64ToBytes, bytesToBase64 } from '../_utils/common';
import type { DataBlock, TextBlock, ToolResultState } from '../message/block';
import { DataBlockSchema, TextBlockSchema } from '../message/schema';

export type ToolContentBlock = TextBlock | DataBlock;

/** Options for constructing one incremental tool chunk. */
export interface ToolChunkOptions {
    content: ToolContentBlock[];
    state?: ToolResultState;
    isLast?: boolean;
    metadata?: Record<string, unknown>;
    id?: string;
}

/** Python-compatible wire representation of a tool chunk. */
export interface ToolChunkWire {
    content: ToolContentBlock[];
    state: ToolResultState;
    is_last: boolean;
    metadata: Record<string, unknown>;
    id: string;
}

/** Incremental result emitted while a tool executes. */
export class ToolChunk {
    content: ToolContentBlock[];
    state: ToolResultState;
    isLast: boolean;
    metadata: Record<string, unknown>;
    id: string;

    /**
     * Create a tool chunk using Python defaults.
     * @param options Chunk fields.
     */
    constructor(options: ToolChunkOptions) {
        this.content = options.content;
        this.state = options.state ?? 'running';
        this.isLast = options.isLast ?? true;
        this.metadata = options.metadata ?? {};
        this.id = options.id ?? _generateId();
    }

    /**
     * Serialize the chunk for cross-language transport.
     * @returns Python-compatible snake-case data.
     */
    toJSON(): ToolChunkWire {
        return {
            content: this.content,
            state: this.state,
            is_last: this.isLast,
            metadata: this.metadata,
            id: this.id,
        };
    }
}

type FinalToolState = 'success' | 'error' | 'interrupted' | 'denied';

/** Python-compatible wire representation of a completed tool response. */
export interface ToolResponseWire {
    content: ToolContentBlock[];
    state: FinalToolState;
    metadata: Record<string, unknown>;
    id: string;
}

/** Construction options supporting both parity and legacy Toolkit fields. */
export interface ToolResponseOptions {
    content?: ToolContentBlock[];
    state?: ToolResultState;
    metadata?: Record<string, unknown>;
    id?: string;
    createdAt?: string;
    stream?: boolean;
    isLast?: boolean;
    isInterrupted?: boolean;
}

/** Completed result accumulated from one or more tool chunks. */
export class ToolResponse {
    content: ToolContentBlock[];
    state: ToolResultState;
    metadata: Record<string, unknown>;
    id: string;

    /** @deprecated Retained until the legacy Toolkit migration is complete. */
    createdAt: string;
    /** @deprecated Chunk streaming metadata belongs on {@link ToolChunk}. */
    stream: boolean;
    /** @deprecated Chunk streaming metadata belongs on {@link ToolChunk}. */
    isLast: boolean;
    /** @deprecated Use `state === "interrupted"`. */
    isInterrupted: boolean;

    /**
     * Create a completed response using Python defaults.
     * @param options Initial response fields.
     */
    constructor(options: ToolResponseOptions = {}) {
        this.content = options.content ?? [];
        this.state = options.state ?? 'success';
        this.metadata = options.metadata ?? {};
        this.id = options.id ?? _generateId();
        this.createdAt = options.createdAt ?? _generateTimestamp();
        this.stream = options.stream ?? false;
        this.isLast = options.isLast ?? true;
        this.isInterrupted = options.isInterrupted ?? false;
    }

    /**
     * Accumulate one chunk using Python block and state semantics.
     * @param chunk Incremental tool output.
     * @returns This response for fluent accumulation.
     */
    appendChunk(chunk: ToolChunk): this {
        const indices = new Map(this.content.map((block, index) => [block.id, index]));
        for (const incoming of chunk.content) {
            const index = indices.get(incoming.id);
            if (index === undefined) {
                this.content.push(structuredClone(incoming));
                indices.set(incoming.id, this.content.length - 1);
                continue;
            }

            const existing = this.content[index];
            if (existing.type === 'text' && incoming.type === 'text') {
                existing.text += incoming.text;
            } else if (existing.type === 'data' && incoming.type === 'data') {
                if (existing.source.type !== 'base64' || incoming.source.type !== 'base64') {
                    throw new Error(
                        'Cannot append DataBlock with URL source or different source types: ' +
                            `${JSON.stringify(existing.source)} vs ${JSON.stringify(incoming.source)}`
                    );
                }
                existing.source.data = mergeBase64Chunks(
                    existing.source.data,
                    incoming.source.data
                );
                existing.name = incoming.name || existing.name;
                existing.source.media_type =
                    incoming.source.media_type || existing.source.media_type;
            } else {
                const copy = structuredClone(incoming);
                copy.id = _generateId();
                this.content.push(copy);
            }
        }

        if (chunk.state === 'error') this.state = 'error';
        else if (this.state !== 'error' && chunk.state === 'interrupted') {
            this.state = 'interrupted';
        } else if (this.state !== 'error' && chunk.state === 'denied') {
            this.state = 'denied';
        }
        Object.assign(this.metadata, chunk.metadata);
        this.mergeAdjacentTextBlocks();
        return this;
    }

    /**
     * Serialize the completed response without legacy TS-only fields.
     * @returns Python-compatible response data.
     */
    toJSON(): ToolResponseWire {
        return {
            content: this.content,
            state: this.state as FinalToolState,
            metadata: this.metadata,
            id: this.id,
        };
    }

    /** Merge consecutive text blocks, preserving data-block boundaries. */
    private mergeAdjacentTextBlocks(): void {
        const merged: ToolContentBlock[] = [];
        for (const block of this.content) {
            const previous = merged.at(-1);
            if (block.type === 'text' && previous?.type === 'text') previous.text += block.text;
            else merged.push(block);
        }
        this.content = merged;
    }
}

const toolContentSchema = z.union([TextBlockSchema, DataBlockSchema]);

/** Runtime schema for a Python-compatible tool chunk. */
export const ToolChunkSchema = z
    .object({
        content: z.array(toolContentSchema),
        state: z.enum(['success', 'error', 'interrupted', 'denied', 'running']).default('running'),
        is_last: z.boolean().default(true),
        metadata: z.record(z.string(), z.unknown()).default(() => ({})),
        id: z.string().optional(),
    })
    .transform(
        value =>
            new ToolChunk({
                content: value.content,
                state: value.state,
                isLast: value.is_last,
                metadata: value.metadata,
                id: value.id,
            })
    );

/** Runtime schema for a completed Python-compatible tool response. */
export const ToolResponseSchema = z
    .object({
        content: z.array(toolContentSchema).default(() => []),
        state: z.enum(['success', 'error', 'interrupted', 'denied']).default('success'),
        metadata: z.record(z.string(), z.unknown()).default(() => ({})),
        id: z.string().optional(),
    })
    .transform(value => new ToolResponse(value));

/**
 * Parse an untrusted tool-chunk wire payload.
 * @param value Unknown input.
 * @returns A validated tool chunk.
 */
export function parseToolChunk(value: unknown): ToolChunk {
    return ToolChunkSchema.parse(value);
}

/**
 * Parse an untrusted completed-response wire payload.
 * @param value Unknown input.
 * @returns A validated tool response.
 */
export function parseToolResponse(value: unknown): ToolResponse {
    return ToolResponseSchema.parse(value);
}

/**
 * Merge independently encoded base64 chunks without corrupting padding.
 * @param existing
 * @param incoming
 * @returns The base64 encoding of the combined bytes.
 */
function mergeBase64Chunks(existing: string, incoming: string): string {
    try {
        const first = base64ToBytes(existing);
        const second = base64ToBytes(incoming);
        const merged = new Uint8Array(first.length + second.length);
        merged.set(first);
        merged.set(second, first.length);
        return bytesToBase64(merged);
    } catch {
        return existing + incoming;
    }
}

/**
 * Legacy response factory retained while existing tools migrate to ToolChunk.
 * @param options Response fields.
 * @returns A completed response.
 */
export function createToolResponse(options: ToolResponseOptions): ToolResponse {
    return new ToolResponse(options);
}

/**
 * Check whether a value is a tool response.
 * @param value Value to inspect.
 * @returns Whether the value follows the ToolResponse contract.
 */
export function isToolResponse(value: unknown): value is ToolResponse {
    if (value instanceof ToolResponse) return true;
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.createdAt === 'string' &&
        Array.isArray(candidate.content) &&
        typeof candidate.metadata === 'object' &&
        typeof candidate.stream === 'boolean' &&
        typeof candidate.isLast === 'boolean' &&
        typeof candidate.isInterrupted === 'boolean' &&
        ['success', 'error', 'interrupted', 'denied', 'running'].includes(String(candidate.state))
    );
}
