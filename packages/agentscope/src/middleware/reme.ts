/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '../agent';
import type { EmbeddingModelBase } from '../embedding';
import { logger } from '../logger';
import { AssistantMsg, HintBlock, getTextContent, type Msg } from '../message';
import type { ChatModelBase } from '../model';
import type { ToolBase } from '../tool';
import { MiddlewareBase, type AgentStream, type ReplyHookInput } from './base';
import { ReMeHttpApp, type ReMeApp, type ReMeAppFactory } from './reme-app';
import { buildReMeAppConfig } from './reme-config';
import { buildReMeMemoryTools } from './reme-tools';
import { extractReMeMemoryTexts, extractReMeQueryText, isReMeMessage } from './reme-utils';

export const DEFAULT_REME_MEMORY_SECTION_HEADER = '## Relevant memories from past conversations';
export const DEFAULT_REME_MEMORY_SECTION_INTRO =
    'The following memories about the user may be relevant. ' +
    'Use them only if they are pertinent to the current request.';
export const DEFAULT_REME_TOOL_INSTRUCTIONS =
    '## Long-term memory\n\n' +
    'You have a `memory_search` tool available. Use it whenever the current ' +
    'conversation may depend on a durable fact from a past session (a preference, ' +
    'a name, a prior decision). Recording memory is handled automatically; there is no add tool.';

export type ReMeMode = 'static_control' | 'agent_control' | 'both';

export interface ReMeParametersOptions {
    chatModel?: ChatModelBase | null;
    chat_model?: ChatModelBase | null;
    embeddingModel?: EmbeddingModelBase | null;
    embedding_model?: EmbeddingModelBase | null;
    mode?: ReMeMode;
    topK?: number;
    top_k?: number;
}

export class ReMeParameters {
    readonly chatModel: ChatModelBase | null;
    readonly embeddingModel: EmbeddingModelBase | null;
    readonly mode: ReMeMode;
    readonly topK: number;

    constructor(options: ReMeParametersOptions = {}) {
        const mode = options.mode ?? 'both';
        if (!['static_control', 'agent_control', 'both'].includes(mode)) {
            throw new Error(
                'Unknown mode ' +
                    JSON.stringify(mode) +
                    '; expected one of static_control, agent_control, both.'
            );
        }
        this.chatModel = options.chatModel ?? options.chat_model ?? null;
        this.embeddingModel = options.embeddingModel ?? options.embedding_model ?? null;
        this.mode = mode;
        this.topK = options.topK ?? options.top_k ?? 5;
    }

    toJSON(): Record<string, unknown> {
        return {
            chat_model: this.chatModel,
            embedding_model: this.embeddingModel,
            mode: this.mode,
            top_k: this.topK,
        };
    }
}

export interface ReMeMiddlewareOptions {
    workspaceDir?: string;
    workspace_dir?: string;
    parameters?: ReMeParameters | ReMeParametersOptions;
    app?: ReMeApp | null;
    appFactory?: ReMeAppFactory;
    app_factory?: ReMeAppFactory;
    endpoint?: string;
    requestTimeoutMs?: number;
    request_timeout_ms?: number;
    backgroundTimeoutMs?: number;
    background_timeout_ms?: number;
    fetch?: typeof globalThis.fetch;
}

interface RetrievalTask {
    promise: Promise<string[]>;
    controller: AbortController;
    settled: boolean;
    result: string[];
    error: unknown;
}

/** ReMe-backed long-term memory with static and agent-controlled retrieval. */
export class ReMeMiddleware extends MiddlewareBase {
    readonly workspaceDir: string;
    readonly parameters: ReMeParameters;
    private app: ReMeApp | null;
    private readonly appFactory: ReMeAppFactory;
    private started = false;
    private readonly retrievalTasks = new Map<string | null, RetrievalTask>();

    constructor(options: ReMeMiddlewareOptions = {}) {
        super();
        this.workspaceDir = options.workspaceDir ?? options.workspace_dir ?? '.reme';
        this.parameters =
            options.parameters instanceof ReMeParameters
                ? options.parameters
                : new ReMeParameters(options.parameters);
        this.app = options.app ?? null;
        const endpoint = options.endpoint;
        const requestTimeoutMs = options.requestTimeoutMs ?? options.request_timeout_ms;
        const backgroundTimeoutMs = options.backgroundTimeoutMs ?? options.background_timeout_ms;
        this.appFactory =
            options.appFactory ??
            options.app_factory ??
            (() =>
                new ReMeHttpApp({
                    endpoint,
                    requestTimeoutMs,
                    backgroundTimeoutMs,
                    fetch: options.fetch,
                }));
    }

    static sessionIdOf(agent: Agent): string | null {
        const state = (
            agent as unknown as {
                state?: { sessionId?: string; session_id?: string };
            }
        ).state;
        return state?.sessionId ?? state?.session_id ?? null;
    }

    async close(): Promise<void> {
        if (this.app && this.started) await this.app.close();
        this.started = false;
    }

    async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        const sessionId = ReMeMiddleware.sessionIdOf(agent);
        const queryText = extractReMeQueryText(input.inputs);
        const stale = this.retrievalTasks.get(sessionId);
        if (stale) {
            this.retrievalTasks.delete(sessionId);
            stale.controller.abort();
        }
        if (this.parameters.mode !== 'agent_control' && queryText) {
            this.retrievalTasks.set(sessionId, this.startRetrieval(queryText));
        }
        const preIds = new Set(
            agent.state.context.filter(isReMeMessage).map(message => message.id)
        );

        try {
            yield* next(input);
        } finally {
            const task = this.retrievalTasks.get(sessionId);
            if (task) {
                this.retrievalTasks.delete(sessionId);
                if (!task.settled) task.controller.abort();
                await task.promise.catch(() => undefined);
            }
            const increment = agent.state.context.filter(
                message =>
                    isReMeMessage(message) && !preIds.has(message.id) && message.name !== 'memory'
            );
            if (
                queryText &&
                increment.some(
                    message => message.role === 'assistant' && Boolean(getTextContent(message))
                )
            ) {
                await this.writeBack(increment, sessionId);
            }
        }
    }

    async *onReasoning(
        agent: Agent,
        input: Record<string, unknown>,
        next: (input?: Record<string, unknown>) => AgentStream
    ): AgentStream {
        const sessionId = ReMeMiddleware.sessionIdOf(agent);
        const task = this.retrievalTasks.get(sessionId);
        if (task?.settled) {
            this.retrievalTasks.delete(sessionId);
            if (task.error) {
                logger.warning('ReMe search failed: %s', errorMessage(task.error));
            } else if (task.result.length) {
                agent.state.context.push(this.buildMemoryMessage(task.result));
            }
        }
        yield* next(input);
    }

    async onSystemPrompt(_agent: Agent, currentPrompt: string): Promise<string> {
        return this.parameters.mode === 'static_control'
            ? currentPrompt
            : currentPrompt + '\n\n' + DEFAULT_REME_TOOL_INSTRUCTIONS;
    }

    async listTools(): Promise<ToolBase[]> {
        return this.parameters.mode === 'static_control' ? [] : buildReMeMemoryTools(this);
    }

    async runJob(
        name: string,
        parameters: Record<string, unknown>,
        options: { signal?: AbortSignal } = {}
    ): Promise<unknown> {
        await this.ensureStarted();
        const response = await this.app!.runJob(name, parameters, options);
        if (response.success === false) {
            throw new Error("ReMe '" + name + "' failed: " + String(response.answer ?? ''));
        }
        return response;
    }

    async searchMemory(
        query: string,
        limit?: number | null,
        signal?: AbortSignal
    ): Promise<string[]> {
        const response = await this.runJob(
            'search',
            { query, limit: limit ?? this.parameters.topK },
            { signal }
        );
        const metadata = isRecord(response) ? response.metadata : {};
        return extractReMeMemoryTexts(metadata);
    }

    async writeBack(messages: Msg[], sessionId: string | null): Promise<void> {
        if (!sessionId) {
            logger.warning('ReMe write skipped: no session_id captured from the agent.');
            return;
        }
        try {
            await this.runJob('auto_memory', {
                messages: JSON.parse(JSON.stringify(messages)),
                session_id: sessionId,
            });
        } catch (error) {
            logger.warning(
                'ReMe auto_memory failed for session_id=%s: %s',
                sessionId,
                errorMessage(error)
            );
        }
    }

    private async ensureStarted(): Promise<void> {
        if (!this.app) {
            this.app = await this.appFactory(
                buildReMeAppConfig({
                    workspaceDir: this.workspaceDir,
                    embeddingDimensions: this.parameters.embeddingModel?.dimensions,
                })
            );
        }
        if (this.started) return;
        if (this.parameters.chatModel) {
            await this.app.updateComponent('as_llm', 'default', {
                model: this.parameters.chatModel,
            });
        }
        if (this.parameters.embeddingModel) {
            await this.app.updateComponent('as_embedding', 'default', {
                model: this.parameters.embeddingModel,
            });
        }
        await this.app.start();
        this.started = true;
    }

    private startRetrieval(query: string): RetrievalTask {
        const controller = new AbortController();
        const task: RetrievalTask = {
            promise: Promise.resolve([]),
            controller,
            settled: false,
            result: [],
            error: null,
        };
        const aborted = new Promise<string[]>((_, reject) => {
            controller.signal.addEventListener(
                'abort',
                () => reject(new Error('ReMe retrieval cancelled.')),
                { once: true }
            );
        });
        task.promise = Promise.race([
            this.searchMemory(query, undefined, controller.signal),
            aborted,
        ]).then(
            result => {
                task.result = result;
                task.settled = true;
                return result;
            },
            error => {
                task.error = error;
                task.settled = true;
                throw error;
            }
        );
        void task.promise.catch(() => undefined);
        return task;
    }

    private buildMemoryMessage(memories: string[]): Msg {
        const bullets = memories.map(memory => '- ' + memory).join('\n');
        return AssistantMsg({
            name: 'memory',
            content: [
                HintBlock({
                    hint:
                        DEFAULT_REME_MEMORY_SECTION_HEADER +
                        '\n' +
                        DEFAULT_REME_MEMORY_SECTION_INTRO +
                        '\n' +
                        bullets,
                }),
            ],
        });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export { ReMeHttpApp, buildReMeAppConfig, extractReMeMemoryTexts, extractReMeQueryText };
export type { ReMeApp, ReMeAppFactory, ReMeResponse } from './reme-app';
