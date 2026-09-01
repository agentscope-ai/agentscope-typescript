/* eslint-disable jsdoc/require-jsdoc */

import type { EmbeddingModelBase } from '../embedding';
import { AssistantMsg, SystemMsg, UserMsg, type Msg } from '../message';
import type { ChatResponse } from '../model';
import type { ChatModelBase } from '../model';

export interface Mem0Message {
    role: string;
    content: string;
    name?: string;
}

export interface Mem0ToolCall {
    name: string;
    arguments: Record<string, unknown> | unknown[] | string | number | boolean | null;
}

export interface Mem0ToolResponse {
    content: string;
    tool_calls: Mem0ToolCall[];
}

export interface Mem0Config {
    llm?: { provider: string; config: Record<string, unknown> };
    embedder?: { provider: string; config: Record<string, unknown> };
    [key: string]: unknown;
}

export interface BuildMem0ConfigOptions {
    chatModel?: ChatModelBase | null;
    chat_model?: ChatModelBase | null;
    embeddingModel?: EmbeddingModelBase | null;
    embedding_model?: EmbeddingModelBase | null;
    mem0Config?: Mem0Config | null;
    mem0_config?: Mem0Config | null;
}

interface Mem0Factory<T> {
    create(provider: string, config: Record<string, unknown>): T;
}

export interface Mem0OssModule {
    Memory: new (config?: Record<string, unknown>) => unknown;
    LLMFactory: Mem0Factory<unknown>;
    EmbedderFactory: Mem0Factory<unknown>;
}

const registeredModules = new WeakSet<object>();

/** Native async mem0 LLM adapter backed by an AgentScope chat model. */
export class AgentScopeLLM {
    readonly model: ChatModelBase;

    constructor(config: { model?: unknown } | null = {}) {
        if (config?.model == null) {
            throw new Error(
                'AgentScopeLLM requires model in the config to be an AgentScope ChatModelBase instance.'
            );
        }
        if (!isChatModel(config.model)) {
            throw new TypeError(
                'AgentScopeLLM model must be a ChatModelBase, got ' + typeName(config.model) + '.'
            );
        }
        this.model = config.model;
    }

    async generateResponse(
        messages: Mem0Message[],
        _responseFormat?: unknown,
        tools?: Array<Record<string, unknown>>
    ): Promise<string | Mem0ToolResponse> {
        const converted = convertMessagesToAgentScope(messages);
        if (converted.length === 0) {
            throw new Error(
                'AgentScopeLLM received no usable messages (empty list or all roles unrecognized).'
            );
        }
        const response = await awaitChat(this.model, converted, tools);
        return parseChatResponse(response, Boolean(tools?.length));
    }

    async generateChat(messages: Mem0Message[]): Promise<{
        content: string;
        role: string;
        toolCalls?: Array<{ name: string; arguments: string }>;
    }> {
        const converted = convertMessagesToAgentScope(messages);
        if (converted.length === 0) {
            throw new Error(
                'AgentScopeLLM received no usable messages (empty list or all roles unrecognized).'
            );
        }
        const result = parseChatResponse(await awaitChat(this.model, converted), true);
        if (typeof result === 'string') return { content: result, role: 'assistant' };
        return {
            content: result.content,
            role: 'assistant',
            toolCalls: result.tool_calls.map(call => ({
                name: call.name,
                arguments:
                    typeof call.arguments === 'string'
                        ? call.arguments
                        : JSON.stringify(call.arguments),
            })),
        };
    }
}

/** Native async mem0 embedder backed by an AgentScope embedding model. */
export class AgentScopeEmbedding {
    readonly model: EmbeddingModelBase;

    constructor(config: { model?: unknown } | null = {}) {
        if (config?.model == null) {
            throw new Error(
                'AgentScopeEmbedding requires model in the config to be an AgentScope EmbeddingModelBase instance.'
            );
        }
        if (!isEmbeddingModel(config.model)) {
            throw new TypeError(
                'AgentScopeEmbedding model must be an EmbeddingModelBase, got ' +
                    typeName(config.model) +
                    '.'
            );
        }
        this.model = config.model;
    }

    async embed(text: string | string[]): Promise<number[]> {
        const response = await this.model.call(Array.isArray(text) ? text : [text]);
        if (response.embeddings.length === 0) {
            throw new Error('AgentScope embedding model returned no embeddings.');
        }
        return response.embeddings[0];
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        return (await this.model.call(texts)).embeddings;
    }
}

/**
 * Convert mem0 OpenAI-shaped messages to AgentScope messages.
 * @param messages Messages to convert.
 * @returns Converted AgentScope messages.
 */
export function convertMessagesToAgentScope(messages: Mem0Message[]): Msg[] {
    return messages.flatMap(message => {
        if (message.role === 'system') {
            return [SystemMsg({ name: 'system', content: message.content ?? '' })];
        }
        if (message.role === 'user') {
            return [UserMsg({ name: 'user', content: message.content ?? '' })];
        }
        if (message.role === 'assistant') {
            return [AssistantMsg({ name: 'assistant', content: message.content ?? '' })];
        }
        return [];
    });
}

/**
 * Flatten an AgentScope response into mem0 text/tool response contract.
 * @param response AgentScope response.
 * @param hasTool Whether mem0 requested tool output.
 * @returns Mem0-compatible text or tool response.
 */
export function parseChatResponse(
    response: ChatResponse,
    hasTool: boolean
): string | Mem0ToolResponse {
    const text: string[] = [];
    const thinking: string[] = [];
    const toolCalls: Mem0ToolCall[] = [];
    for (const block of response.content ?? []) {
        if (block.type === 'text') text.push(block.text || '');
        else if (block.type === 'thinking')
            thinking.push('[Thinking: ' + (block.thinking || '') + ']');
        else if (block.type === 'tool_call') {
            toolCalls.push({
                name: block.name,
                arguments: parseToolArguments(block.input || '{}'),
            });
        }
    }
    const content = [...thinking, ...text].join('\n');
    return hasTool ? { content, tool_calls: toolCalls } : content;
}

/**
 * Build or partially override a mem0 OSS config with AgentScope providers.
 * @param options Models and optional base configuration.
 * @returns The configured mem0 object.
 */
export function buildMem0Config(options: BuildMem0ConfigOptions): Mem0Config {
    const chatModel = options.chatModel ?? options.chat_model ?? null;
    const embeddingModel = options.embeddingModel ?? options.embedding_model ?? null;
    const base = options.mem0Config ?? options.mem0_config ?? null;
    if (!base && (!chatModel || !embeddingModel)) {
        throw new Error(
            'buildMem0Config requires chatModel and embeddingModel when mem0Config is not given.'
        );
    }
    const config = base ?? {};
    if (chatModel) {
        config.llm = { provider: 'agentscope', config: { model: chatModel } };
    }
    if (embeddingModel) {
        config.embedder = {
            provider: 'agentscope',
            config: {
                model: embeddingModel,
                embeddingDims: embeddingModel.dimensions,
            },
        };
    }
    return config;
}

/**
 * Register AgentScope model providers in mem0 factory layer.
 *
 * Registration is lazy and idempotent so importing AgentScope never initializes
 * mem0 optional OSS infrastructure.
 * @param module Loaded mem0 OSS module.
 */
export function registerAgentScopeMem0Providers(module: Mem0OssModule): void {
    if (registeredModules.has(module as object)) return;
    registeredModules.add(module as object);
    const originalLlmCreate = module.LLMFactory.create.bind(module.LLMFactory);
    const originalEmbedderCreate = module.EmbedderFactory.create.bind(module.EmbedderFactory);
    module.LLMFactory.create = (provider, config) =>
        provider.toLowerCase() === 'agentscope'
            ? new AgentScopeLLM(config)
            : originalLlmCreate(provider, config);
    module.EmbedderFactory.create = (provider, config) =>
        provider.toLowerCase() === 'agentscope'
            ? new AgentScopeEmbedding(config)
            : originalEmbedderCreate(provider, config);
}

async function awaitChat(
    model: ChatModelBase,
    messages: Msg[],
    tools?: Array<Record<string, unknown>>
): Promise<ChatResponse> {
    const result = await model.call({
        messages,
        tools: tools as never,
    });
    if (!isAsyncIterable<ChatResponse>(result)) return result;
    let last: ChatResponse | null = null;
    for await (const chunk of result) last = chunk;
    if (!last) throw new Error('AgentScope streaming model yielded no chunks.');
    return last;
}

function parseToolArguments(value: string): Mem0ToolCall['arguments'] {
    try {
        return JSON.parse(value) as Mem0ToolCall['arguments'];
    } catch {
        return value;
    }
}

function isChatModel(value: unknown): value is ChatModelBase {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { call?: unknown }).call === 'function' &&
        typeof (value as { generateStructuredOutput?: unknown }).generateStructuredOutput ===
            'function'
    );
}

function isEmbeddingModel(value: unknown): value is EmbeddingModelBase {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { call?: unknown }).call === 'function' &&
        Number.isInteger((value as { dimensions?: unknown }).dimensions)
    );
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
    return (
        value !== null &&
        typeof value === 'object' &&
        Symbol.asyncIterator in value &&
        typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
    );
}

function typeName(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return typeof value;
    return value.constructor?.name ?? 'Object';
}
