/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '../agent';
import type { EmbeddingModelBase } from '../embedding';
import { EventType } from '../event';
import { logger } from '../logger';
import { AssistantMsg, HintBlock, getTextContent, type Msg } from '../message';
import type { ChatModelBase } from '../model';
import type { ToolBase } from '../tool';
import { MiddlewareBase } from './base';
import type { AgentStream, ReplyHookInput } from './base';
import {
    buildMem0Config,
    registerAgentScopeMem0Providers,
    type Mem0Config,
    type Mem0Message,
    type Mem0OssModule,
} from './mem0-adapter';
import { buildMem0MemoryTools } from './mem0-tools';
import {
    extractMem0MemoryTexts,
    extractMem0QueryText,
    isMem0Message,
    mem0ExtractedAnything,
} from './mem0-utils';

export const DEFAULT_MEMORY_SECTION_HEADER = '## Relevant memories from past conversations';
export const DEFAULT_MEMORY_SECTION_INTRO =
    'The following memories about the user may be relevant. ' +
    'Use them only if they are pertinent to the current request.';
export const DEFAULT_MEM0_TOOL_INSTRUCTIONS =
    '## Long-term memory\n\n' +
    'You have search_memory and add_memory tools available. Use them whenever the ' +
    'conversation depends on (search) or contributes (add) a durable fact about the ' +
    'user — see each tool own description for the exact input shape and usage guidance.';

export type Mem0Mode = 'static_control' | 'agent_control' | 'both';

export interface Mem0SearchOptions {
    filters: Record<string, unknown>;
    topK: number;
    threshold?: number;
}

export interface Mem0AddOptions {
    userId: string;
    agentId?: string;
    infer?: boolean;
}

export interface Mem0AsyncClient {
    search(query: string, options: Mem0SearchOptions): Promise<unknown>;
    add(messages: Mem0Message[], options: Mem0AddOptions): Promise<unknown>;
}

export interface Mem0MiddlewareOptions {
    userId?: string;
    user_id?: string;
    client?: Mem0AsyncClient | null;
    chatModel?: ChatModelBase | null;
    chat_model?: ChatModelBase | null;
    embeddingModel?: EmbeddingModelBase | null;
    embedding_model?: EmbeddingModelBase | null;
    mem0Config?: Mem0Config | null;
    mem0_config?: Mem0Config | null;
    mode?: Mem0Mode;
    agentId?: string | null;
    agent_id?: string | null;
    topK?: number;
    top_k?: number;
    threshold?: number | null;
    scopeSearchByAgent?: boolean;
    scope_search_by_agent?: boolean;
    awaitWrite?: boolean;
    await_write?: boolean;
    memorySectionHeader?: string;
    memory_section_header?: string;
    memorySectionIntro?: string;
    memory_section_intro?: string;
    toolInstructions?: string;
    tool_instructions?: string;
}

/** mem0-backed long-term memory with static and agent-controlled modes. */
export class Mem0Middleware extends MiddlewareBase {
    readonly userId: string;
    readonly agentId: string | null;
    readonly mode: Mem0Mode;
    readonly topK: number;
    readonly threshold: number | null;
    readonly scopeSearchByAgent: boolean;
    readonly awaitWrite: boolean;
    readonly memorySectionHeader: string;
    readonly memorySectionIntro: string;
    readonly toolInstructions: string;
    private readonly client: Mem0AsyncClient;

    constructor(options: Mem0MiddlewareOptions) {
        super();
        const userId = options.userId ?? options.user_id;
        if (userId == null || !userId.trim()) {
            throw new Error('Mem0Middleware requires a non-empty userId.');
        }
        const mode = options.mode ?? 'both';
        if (!['static_control', 'agent_control', 'both'].includes(mode)) {
            throw new Error(
                'Unknown mode ' +
                    JSON.stringify(mode) +
                    '; expected one of static_control, agent_control, both.'
            );
        }
        this.userId = userId;
        this.agentId = options.agentId ?? options.agent_id ?? null;
        this.mode = mode;
        this.topK = options.topK ?? options.top_k ?? 5;
        this.threshold = options.threshold ?? null;
        this.scopeSearchByAgent =
            options.scopeSearchByAgent ?? options.scope_search_by_agent ?? true;
        this.awaitWrite = options.awaitWrite ?? options.await_write ?? true;
        this.memorySectionHeader =
            options.memorySectionHeader ??
            options.memory_section_header ??
            DEFAULT_MEMORY_SECTION_HEADER;
        this.memorySectionIntro =
            options.memorySectionIntro ??
            options.memory_section_intro ??
            DEFAULT_MEMORY_SECTION_INTRO;
        this.toolInstructions =
            options.toolInstructions ?? options.tool_instructions ?? DEFAULT_MEM0_TOOL_INSTRUCTIONS;
        this.client = resolveMem0Client(options);
    }

    get searchAgentId(): string | null {
        return this.scopeSearchByAgent ? this.agentId : null;
    }

    async *onReply(agent: Agent, input: ReplyHookInput, next: () => AgentStream): AgentStream {
        if (this.mode === 'agent_control') {
            yield* next();
            return;
        }
        const queryText = extractMem0QueryText(input.inputs);
        let memories: string[] = [];
        if (queryText) {
            try {
                memories = await this.searchMemory(queryText, {
                    userId: this.userId,
                    agentId: this.searchAgentId,
                });
            } catch (error) {
                logger.warning(
                    'mem0 search failed for user_id=%s: %s',
                    this.userId,
                    errorMessage(error)
                );
            }
        }

        let finalMessage: Msg | null = null;
        let injected = false;
        try {
            for await (const item of next()) {
                if (
                    !injected &&
                    memories.length > 0 &&
                    !isMem0Message(item) &&
                    item.type === EventType.REPLY_START
                ) {
                    agent.state.context.push(this.buildMemoryMessage(memories));
                    injected = true;
                }
                if (isMem0Message(item) && item.role === 'assistant') finalMessage = item;
                yield item;
            }
        } finally {
            if (queryText && finalMessage) {
                const assistantText = getTextContent(finalMessage);
                if (assistantText) {
                    await this.dispatchWrite(
                        [
                            { role: 'user', content: queryText },
                            { role: 'assistant', content: assistantText },
                        ],
                        { userId: this.userId, agentId: this.agentId }
                    );
                }
            }
        }
    }

    async onSystemPrompt(_agent: Agent, currentPrompt: string): Promise<string> {
        return this.mode === 'static_control'
            ? currentPrompt
            : currentPrompt + '\n\n' + this.toolInstructions;
    }

    async listTools(): Promise<ToolBase[]> {
        return this.mode === 'static_control' ? [] : buildMem0MemoryTools(this);
    }

    async searchMemory(
        query: string,
        options: { userId: string; agentId: string | null; topK?: number }
    ): Promise<string[]> {
        const filters: Record<string, unknown> = { user_id: options.userId };
        if (options.agentId) filters.agent_id = options.agentId;
        const request: Mem0SearchOptions = {
            filters,
            topK: options.topK ?? this.topK,
        };
        if (this.threshold !== null) request.threshold = this.threshold;
        return extractMem0MemoryTexts(await this.client.search(query, request));
    }

    async addMemory(
        messages: Mem0Message[],
        options: { userId: string; agentId: string | null; infer?: boolean }
    ): Promise<unknown> {
        const request: Mem0AddOptions = { userId: options.userId };
        if (options.agentId) request.agentId = options.agentId;
        if (options.infer === false) request.infer = false;
        return this.client.add(messages, request);
    }

    async addMemoryWithFallback(
        text: string,
        options: { userId: string; agentId: string | null }
    ): Promise<unknown> {
        const messages = [{ role: 'user', content: text, name: 'user' }];
        const result = await this.addMemory(messages, options);
        if (mem0ExtractedAnything(result)) return result;
        return this.addMemory(messages, { ...options, infer: false });
    }

    private buildMemoryMessage(memories: string[]): Msg {
        const bullets = memories.map(memory => '- ' + memory).join('\n');
        const content = this.memorySectionHeader + '\n' + this.memorySectionIntro + '\n' + bullets;
        return AssistantMsg({
            name: 'memory',
            content: [HintBlock({ hint: content })],
        });
    }

    private async dispatchWrite(
        messages: Mem0Message[],
        options: { userId: string; agentId: string | null }
    ): Promise<void> {
        const write = async (): Promise<void> => {
            try {
                await this.addMemory(messages, options);
            } catch (error) {
                logger.warning(
                    'mem0 add failed for user_id=%s: %s',
                    options.userId,
                    errorMessage(error)
                );
            }
        };
        if (this.awaitWrite) await write();
        else void write();
    }
}

function resolveMem0Client(options: Mem0MiddlewareOptions): Mem0AsyncClient {
    const chatModel = options.chatModel ?? options.chat_model ?? null;
    const embeddingModel = options.embeddingModel ?? options.embedding_model ?? null;
    const mem0Config = options.mem0Config ?? options.mem0_config ?? null;
    if (options.client) {
        const ignored = [
            chatModel ? 'chat_model' : null,
            embeddingModel ? 'embedding_model' : null,
            mem0Config ? 'mem0_config' : null,
        ].filter((value): value is string => value !== null);
        if (ignored.length) {
            logger.warning(
                'Mem0Middleware: client was provided, so %s %s ignored.',
                ignored.join(', '),
                ignored.length === 1 ? 'is' : 'are'
            );
        }
        if (!looksAsync(options.client.search) || !looksAsync(options.client.add)) {
            throw new TypeError(
                'Mem0Middleware requires an async mem0 client. Synchronous clients are not supported.'
            );
        }
        return options.client;
    }
    if (!mem0Config && !chatModel && !embeddingModel) {
        throw new Error(
            'Mem0Middleware needs one of: a pre-built client, a mem0Config, or both chatModel and embeddingModel.'
        );
    }
    if (!mem0Config && Boolean(chatModel) !== Boolean(embeddingModel)) {
        throw new Error(
            'Mem0Middleware: chatModel and embeddingModel must be passed together when mem0Config is not given.'
        );
    }
    const config = buildMem0Config({ chatModel, embeddingModel, mem0Config });
    return new LazyMem0OssClient(config);
}

class LazyMem0OssClient implements Mem0AsyncClient {
    private readonly config: Mem0Config;
    private instance: Promise<{
        search(query: string, options: Record<string, unknown>): Promise<unknown>;
        add(messages: Mem0Message[], options: Record<string, unknown>): Promise<unknown>;
    }> | null = null;

    constructor(config: Mem0Config) {
        this.config = config;
    }

    async search(query: string, options: Mem0SearchOptions): Promise<unknown> {
        return (await this.get()).search(query, { ...options });
    }

    async add(messages: Mem0Message[], options: Mem0AddOptions): Promise<unknown> {
        const filters: Record<string, unknown> = { user_id: options.userId };
        if (options.agentId) filters.agent_id = options.agentId;
        return (await this.get()).add(messages, {
            filters,
            ...(options.infer === false ? { infer: false } : {}),
        });
    }

    private get(): Promise<{
        search(query: string, options: Record<string, unknown>): Promise<unknown>;
        add(messages: Mem0Message[], options: Record<string, unknown>): Promise<unknown>;
    }> {
        this.instance ??= import('mem0ai/oss').then(module => {
            registerAgentScopeMem0Providers(module as unknown as Mem0OssModule);
            return new module.Memory(this.config as never);
        });
        return this.instance;
    }
}

function looksAsync(method: unknown): boolean {
    if (typeof method !== 'function') return false;
    if (method.constructor.name === 'AsyncFunction') return true;
    const wrapped = (method as { __wrapped__?: unknown }).__wrapped__;
    return wrapped ? looksAsync(wrapped) : false;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export {
    AgentScopeEmbedding,
    AgentScopeLLM,
    buildMem0Config,
    convertMessagesToAgentScope,
    parseChatResponse,
    registerAgentScopeMem0Providers,
} from './mem0-adapter';
export type { Mem0Message } from './mem0-adapter';
export { extractMem0MemoryTexts, extractMem0QueryText, mem0ExtractedAnything } from './mem0-utils';
