/* eslint-disable jsdoc/require-jsdoc */

import { _generateId, _generateTimestamp } from '../_utils/common';
import { Base64Source, DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message/block';
import type {
    DataBlock as DataBlockType,
    TextBlock as TextBlockType,
    ThinkingBlock as ThinkingBlockType,
    ToolCallBlock as ToolCallBlockType,
} from '../message/block';
import type { JSONSerializableObject } from '../type';
import type { ChatUsage } from './usage';

export type ChatResponseBlock =
    | TextBlockType
    | ToolCallBlockType
    | ThinkingBlockType
    | DataBlockType;

/** The terminal reason of a model response. */
export enum FinishedReason {
    INTERRUPTED = 'interrupted',
    COMPLETED = 'completed',
}

export interface ChatResponseOptions {
    content: ChatResponseBlock[];
    isLast: boolean;
    id?: string;
    createdAt?: string;
    usage?: ChatUsage | null;
    finishedReason?: FinishedReason;
    metadata?: Record<string, JSONSerializableObject>;
}

/** Mutable Python-compatible chat response with delta append helpers. */
export class ChatResponse {
    readonly type = 'chat_response' as const;
    content: ChatResponseBlock[];
    isLast: boolean;
    id: string;
    createdAt: string;
    usage: ChatUsage | null;
    finishedReason: FinishedReason;
    metadata: Record<string, JSONSerializableObject>;

    constructor(options: ChatResponseOptions) {
        this.content = options.content;
        this.isLast = options.isLast;
        this.id = options.id ?? _generateId();
        this.createdAt = options.createdAt ?? _generateTimestamp();
        this.usage = options.usage ?? null;
        this.finishedReason = options.finishedReason ?? FinishedReason.COMPLETED;
        this.metadata = options.metadata ?? {};
    }

    static from(value: ChatResponse | LegacyChatResponse): ChatResponse {
        if (value instanceof ChatResponse) return value;
        return new ChatResponse({
            content: value.content,
            isLast: value.isLast ?? false,
            id: value.id,
            createdAt: value.createdAt,
            usage: value.usage ?? null,
            finishedReason: value.finishedReason,
            metadata: value.metadata,
        });
    }

    appendText(text: string, blockId?: string): this {
        const block = this.content.find(item => {
            return item.type === 'text' && (blockId === undefined || item.id === blockId);
        }) as TextBlockType | undefined;
        if (block) block.text += text;
        else this.content.push(TextBlock({ text, id: blockId }));
        return this;
    }

    appendThinking(
        thinking: string,
        blockId?: string,
        extraFields: Record<string, unknown> = {}
    ): this {
        const block = this.content.find(item => {
            return item.type === 'thinking' && (blockId === undefined || item.id === blockId);
        }) as ThinkingBlockType | undefined;
        if (block) {
            block.thinking += thinking;
            copyExtras(block, extraFields);
        } else {
            this.content.push(
                ThinkingBlock({ thinking, id: blockId, ...nonNullEntries(extraFields) })
            );
        }
        return this;
    }

    appendToolCall(
        blockId: string,
        name: string,
        input: string,
        extraFields: Record<string, unknown> = {}
    ): this {
        const block = this.content.find(item => {
            return item.type === 'tool_call' && item.id === blockId;
        }) as ToolCallBlockType | undefined;
        if (block) {
            block.input += input;
            copyExtras(block, extraFields);
        } else {
            this.content.push(
                Object.assign(
                    ToolCallBlock({ id: blockId, name, input }),
                    nonNullEntries(extraFields)
                )
            );
        }
        return this;
    }

    appendDataBlock(blockId: string, data: Uint8Array, mediaType: string, name?: string): this {
        const block = this.content.find(item => {
            return (
                item.type === 'data' &&
                item.id === blockId &&
                item.source.type === 'base64' &&
                item.source.media_type === mediaType
            );
        }) as DataBlockType | undefined;
        if (block && block.source.type === 'base64') {
            const bytes = Buffer.concat([
                Buffer.from(block.source.data, 'base64'),
                Buffer.from(data),
            ]);
            block.source.data = bytes.toString('base64');
        } else {
            this.content.push(
                DataBlock({
                    id: blockId,
                    name,
                    source: Base64Source({
                        data: Buffer.from(data).toString('base64'),
                        media_type: mediaType,
                    }),
                })
            );
        }
        return this;
    }

    appendChatResponse(delta: ChatResponse): this {
        const incoming = new Map(delta.content.map(block => [block.id, block]));
        for (const block of this.content) {
            const next = incoming.get(block.id);
            if (!next) continue;
            incoming.delete(block.id);
            if (block.type !== next.type) continue;
            if (block.type === 'text' && next.type === 'text') block.text += next.text;
            else if (block.type === 'thinking' && next.type === 'thinking') {
                block.thinking += next.thinking;
                copyExtras(block, next);
            } else if (block.type === 'tool_call' && next.type === 'tool_call') {
                block.input += next.input;
                copyExtras(block, next);
            } else if (block.type === 'data' && next.type === 'data') {
                mergeDataBlock(block, next);
            }
        }
        for (const block of incoming.values()) this.content.push(structuredClone(block));
        if (delta.usage) this.usage = delta.usage;
        return this;
    }

    toJSON(): Record<string, unknown> {
        return {
            content: this.content,
            is_last: this.isLast,
            id: this.id,
            created_at: this.createdAt,
            type: this.type,
            usage: this.usage,
            finished_reason: this.finishedReason,
            metadata: this.metadata,
        };
    }
}

export interface LegacyChatResponse {
    type?: string;
    id: string;
    createdAt: string;
    content: ChatResponseBlock[];
    isLast?: boolean;
    usage?: ChatUsage | null;
    finishedReason?: FinishedReason;
    metadata?: Record<string, JSONSerializableObject>;
}

export interface StructuredResponseOptions {
    content: Record<string, JSONSerializableObject>;
    id?: string;
    createdAt?: string;
    usage?: ChatUsage | null;
    metadata?: Record<string, JSONSerializableObject>;
    finishedReason?: FinishedReason;
}

export class StructuredResponse {
    readonly type = 'structured_response' as const;
    content: Record<string, JSONSerializableObject>;
    id: string;
    createdAt: string;
    usage: ChatUsage | null;
    metadata: Record<string, JSONSerializableObject>;
    finishedReason: FinishedReason;

    constructor(options: StructuredResponseOptions) {
        this.content = options.content;
        this.id = options.id ?? _generateId();
        this.createdAt = options.createdAt ?? _generateTimestamp();
        this.usage = options.usage ?? null;
        this.metadata = options.metadata ?? {};
        this.finishedReason = options.finishedReason ?? FinishedReason.COMPLETED;
    }

    toJSON(): Record<string, unknown> {
        return {
            content: this.content,
            id: this.id,
            created_at: this.createdAt,
            type: this.type,
            usage: this.usage,
            metadata: this.metadata,
            finished_reason: this.finishedReason,
        };
    }
}

interface AccumulatorBlock {
    seed: ChatResponseBlock;
    fragments: Array<string | Uint8Array>;
}

/** O(n) accumulator for streamed response blocks. */
export class StreamAccumulator {
    private readonly blocks = new Map<string, AccumulatorBlock>();
    id: string | null = null;
    usage: ChatUsage | null = null;
    finishedReason = FinishedReason.COMPLETED;

    appendChatResponse(response: ChatResponse): this {
        for (const block of response.content) {
            let accumulator = this.blocks.get(block.id);
            if (accumulator && accumulator.seed.type !== block.type) {
                accumulator = undefined;
            }
            if (!accumulator) {
                accumulator = { seed: structuredClone(block), fragments: [] };
                this.blocks.set(block.id, accumulator);
            }
            appendFragment(accumulator, block);
        }
        if (response.usage) this.usage = response.usage;
        return this;
    }

    build(): ChatResponse {
        return new ChatResponse({
            content: [...this.blocks.values()].map(buildBlock),
            isLast: true,
            id: this.id ?? undefined,
            usage: this.usage,
            finishedReason: this.finishedReason,
        });
    }
}

function appendFragment(accumulator: AccumulatorBlock, block: ChatResponseBlock): void {
    if (block.type === 'text') accumulator.fragments.push(block.text);
    else if (block.type === 'thinking') {
        accumulator.fragments.push(block.thinking);
        copyExtras(accumulator.seed, block);
    } else if (block.type === 'tool_call') {
        accumulator.fragments.push(block.input);
        if (accumulator.seed.type === 'tool_call' && !accumulator.seed.name && block.name) {
            accumulator.seed.name = block.name;
        }
        copyExtras(accumulator.seed, block);
    } else if (block.source.type === 'base64' && block.source.media_type.startsWith('audio/')) {
        const seed = accumulator.seed;
        if (
            seed.type !== 'data' ||
            seed.source.type !== 'base64' ||
            seed.source.media_type !== block.source.media_type
        ) {
            accumulator.seed = structuredClone(block);
            accumulator.fragments = [];
        }
        accumulator.fragments.push(Buffer.from(block.source.data, 'base64'));
    } else {
        accumulator.seed = structuredClone(block);
        accumulator.fragments = [];
    }
}

function buildBlock(accumulator: AccumulatorBlock): ChatResponseBlock {
    const block = structuredClone(accumulator.seed);
    if (block.type === 'text') block.text = accumulator.fragments.join('');
    else if (block.type === 'thinking') block.thinking = accumulator.fragments.join('');
    else if (block.type === 'tool_call') block.input = accumulator.fragments.join('');
    else if (block.source.type === 'base64' && block.source.media_type.startsWith('audio/')) {
        const buffers = accumulator.fragments.map(fragment => Buffer.from(fragment));
        block.source.data = Buffer.concat(buffers).toString('base64');
    }
    return block;
}

function mergeDataBlock(block: DataBlockType, delta: DataBlockType): void {
    if (
        block.source.type !== 'base64' ||
        delta.source.type !== 'base64' ||
        block.source.media_type !== delta.source.media_type
    ) {
        block.source = structuredClone(delta.source);
    } else if (block.source.media_type.startsWith('audio/')) {
        block.source.data = Buffer.concat([
            Buffer.from(block.source.data, 'base64'),
            Buffer.from(delta.source.data, 'base64'),
        ]).toString('base64');
    } else {
        block.source.data = delta.source.data;
    }
}

function copyExtras(target: object, source: object): void {
    const writable = target as Record<string, unknown>;
    for (const [key, value] of Object.entries(source)) {
        if (value !== null && value !== undefined && !BASE_BLOCK_FIELDS.has(key)) {
            writable[key] = value;
        }
    }
}

function nonNullEntries(source: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(source).filter(([, value]) => value != null));
}

const BASE_BLOCK_FIELDS = new Set([
    'type',
    'id',
    'created_at',
    'finished_at',
    'text',
    'thinking',
    'name',
    'input',
    'state',
    'suggested_rules',
    'source',
]);
