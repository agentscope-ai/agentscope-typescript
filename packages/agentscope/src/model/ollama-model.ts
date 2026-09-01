/* eslint-disable jsdoc/require-jsdoc */

import { OllamaCredential } from '../credential/providers';
import { OllamaChatFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import { postJSON, postNDJSON } from './http-transport';
import { ChatResponse, StreamAccumulator } from './response';
import { ChatUsage } from './usage';

export interface OllamaParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    temperature?: number | null;
}

export interface OllamaClient {
    chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface OllamaChatModelOptions {
    credential?: OllamaCredential;
    model?: string;
    parameters?: OllamaParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: OllamaClient;
    fetch?: FetchLike;
    modelName?: string;
    host?: string;
    options?: Record<string, unknown>;
    keepAlive?: string;
    thinkingConfig?: { enableThinking: boolean; thinkingLevel?: string };
    generateKwargs?: Record<string, unknown>;
    fallbackModelName?: string;
    clientKwargs?: Record<string, unknown>;
}

/** Ollama chat model backed by the native HTTP protocol. */
export class OllamaChatModel extends ChatModelBase {
    readonly type = 'ollama_chat' as const;
    readonly ollamaParameters: OllamaParameters;
    private readonly client: OllamaClient;
    private readonly legacyOptions: Record<string, unknown>;
    private readonly generationOptions: Record<string, unknown>;
    private readonly keepAlive?: string;

    constructor(options: OllamaChatModelOptions = {}) {
        const credential = options.credential ?? new OllamaCredential({ host: options.host });
        const model = options.model ?? options.modelName ?? '';
        const parameters = {
            ...(options.parameters ?? {}),
            ...(options.thinkingConfig
                ? { thinkingEnable: options.thinkingConfig.enableThinking }
                : {}),
        };
        super({
            modelName: model,
            credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 32768,
            fallbackModelName: options.fallbackModelName,
            formatter: options.formatter ?? new OllamaChatFormatter(),
        });
        this.ollamaParameters = parameters;
        this.legacyOptions = options.options ?? {};
        this.generationOptions = options.generateKwargs ?? {};
        this.keepAlive = options.keepAlive;
        const host = credential.host ?? 'http://localhost:11434';
        this.client = options.client ?? {
            chat: async (body, signal) => {
                const requestOptions = { fetch: options.fetch, signal };
                return body.stream
                    ? postNDJSON(`${host.replace(/\/$/, '')}/api/chat`, body, requestOptions)
                    : postJSON(`${host.replace(/\/$/, '')}/api/chat`, body, requestOptions);
            },
        };
    }

    protected isRetryableError(error: unknown): boolean {
        return error instanceof TypeError;
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        const configured: Record<string, unknown> = { ...this.legacyOptions };
        if (this.ollamaParameters.maxTokens != null) {
            configured.num_predict = this.ollamaParameters.maxTokens;
        }
        if (this.ollamaParameters.temperature != null) {
            configured.temperature = this.ollamaParameters.temperature;
        }
        const body: Record<string, unknown> = {
            model: modelName,
            messages,
            stream: this.stream,
            think: this.ollamaParameters.thinkingEnable ?? false,
            ...this.generationOptions,
            ...callOptions,
        };
        if (Object.keys(configured).length > 0) body.options = configured;
        if (this.keepAlive) body.keep_alive = this.keepAlive;
        const selectedTools = filterTools(tools, normalizedToolChoice?.tools);
        if (selectedTools?.length) body.tools = selectedTools;
        const raw = await this.client.chat(body, signal as AbortSignal | undefined);
        return this.stream
            ? this.parseStream(raw as AsyncIterable<Record<string, unknown>>, startedAt)
            : parseCompletion(raw, startedAt);
    }

    _formatToolChoice(_toolChoice?: LegacyToolChoice): undefined {
        return undefined;
    }

    _formatToolSchemas(tools?: ToolSchema[]): ToolSchema[] {
        return tools ?? [];
    }

    private async *parseStream(
        chunks: AsyncIterable<Record<string, unknown>>,
        startedAt: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const responseId = crypto.randomUUID();
        const textId = crypto.randomUUID();
        const thinkingId = crypto.randomUUID();
        const accumulator = new StreamAccumulator();
        for await (const chunk of chunks) {
            const message = asRecord(chunk.message);
            const delta = new ChatResponse({ id: responseId, content: [], isLast: false });
            const thinking = stringValue(message.thinking);
            if (thinking) delta.appendThinking(thinking, thinkingId);
            const text = stringValue(message.content);
            if (text) delta.appendText(text, textId);
            asArray(message.tool_calls).forEach((value, index) => {
                const fn = asRecord(asRecord(value).function);
                const name = stringValue(fn.name);
                delta.appendToolCall(`${index}_${name}`, name, JSON.stringify(fn.arguments ?? {}));
            });
            delta.usage = new ChatUsage({
                inputTokens: Number(chunk.prompt_eval_count ?? 0),
                outputTokens: Number(chunk.eval_count ?? 0),
                time: (Date.now() - startedAt) / 1000,
            });
            accumulator.appendChatResponse(delta);
            accumulator.id = responseId;
            yield delta;
        }
        return accumulator.build();
    }
}

function parseCompletion(value: unknown, startedAt: number): ChatResponse {
    const response = asRecord(value);
    const message = asRecord(response.message);
    const content = [] as ChatResponse['content'];
    const thinking = stringValue(message.thinking);
    if (thinking) content.push(ThinkingBlock({ thinking }));
    const text = stringValue(message.content);
    if (text) content.push(TextBlock({ text }));
    asArray(message.tool_calls).forEach((value, index) => {
        const fn = asRecord(asRecord(value).function);
        const name = stringValue(fn.name);
        content.push(
            ToolCallBlock({
                id: `${index}_${name}`,
                name,
                input: JSON.stringify(fn.arguments ?? {}),
            })
        );
    });
    const hasUsage = response.prompt_eval_count != null && response.eval_count != null;
    return new ChatResponse({
        id: stringValue(response.id) || crypto.randomUUID(),
        content,
        isLast: true,
        usage: hasUsage
            ? new ChatUsage({
                  inputTokens: Number(response.prompt_eval_count),
                  outputTokens: Number(response.eval_count),
                  time: (Date.now() - startedAt) / 1000,
              })
            : null,
    });
}

function filterTools(
    tools: ToolSchema[] | undefined,
    names: string[] | null | undefined
): ToolSchema[] | undefined {
    if (!names?.length) return tools;
    const allowed = new Set(names);
    return tools?.filter(tool => allowed.has(tool.function.name));
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
