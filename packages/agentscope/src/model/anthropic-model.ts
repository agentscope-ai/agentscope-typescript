/* eslint-disable jsdoc/require-jsdoc */

import { AnthropicCredential } from '../credential';
import { AnthropicChatFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import { postJSON, postSSE } from './http-transport';
import { ChatResponse, StreamAccumulator } from './response';
import { ChatUsage } from './usage';

export interface AnthropicParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    thinkingBudget?: number | null;
    thinkingMode?: 'adaptive' | 'enabled' | 'disabled' | null;
    thinkingDisplay?: 'summarized' | 'omitted' | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
}

export interface AnthropicClient {
    create(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AnthropicChatModelOptions {
    credential: AnthropicCredential;
    model: string;
    parameters?: AnthropicParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: AnthropicClient;
    fetch?: FetchLike;
}

/** Anthropic Messages API model with streaming and thinking parity. */
export class AnthropicChatModel extends ChatModelBase {
    readonly type = 'anthropic_chat' as const;
    readonly anthropicParameters: AnthropicParameters;
    private readonly client: AnthropicClient;

    constructor(options: AnthropicChatModelOptions) {
        const parameters = options.parameters ?? {};
        const formatter = options.formatter ?? new AnthropicChatFormatter();
        super({
            modelName: options.model,
            credential: options.credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 200000,
            formatter,
        });
        this.anthropicParameters = parameters;
        this.client =
            options.client ??
            createAnthropicHTTPClient(options.credential, options.fetch, this.stream);
    }

    protected isRetryableError(error: unknown): boolean {
        return (
            error instanceof TypeError ||
            (error instanceof Error &&
                (error.name === 'TimeoutError' ||
                    error.name === 'RateLimitError' ||
                    /^HTTP5\d\dError$/.test(error.name)))
        );
    }

    protected isStructuredOutputFallbackError(error: unknown): boolean {
        return (
            super.isStructuredOutputFallbackError(error) ||
            (error instanceof Error && error.name === 'HTTP400Error')
        );
    }

    protected getDisableThinkingOptions(): Record<string, unknown> {
        return { thinking: { type: 'disabled' } };
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...generateOptions } = options;
        delete generateOptions.toolChoice;
        delete generateOptions.schema;

        let maxTokens = this.anthropicParameters.maxTokens ?? 8192;
        const body: Record<string, unknown> = {
            model: modelName,
            max_tokens: maxTokens,
            stream: this.stream,
            ...generateOptions,
        };
        const mode = this.thinkingMode();
        if (mode && body.thinking === undefined) {
            const thinking: Record<string, unknown> = { type: mode };
            if (mode === 'enabled') {
                const budget = this.anthropicParameters.thinkingBudget ?? Math.floor(maxTokens / 2);
                if (budget >= maxTokens) {
                    maxTokens = budget + 1024;
                    body.max_tokens = maxTokens;
                }
                thinking.budget_tokens = budget;
            }
            if (mode !== 'disabled' && this.anthropicParameters.thinkingDisplay) {
                thinking.display = this.anthropicParameters.thinkingDisplay;
            }
            body.thinking = thinking;
        }
        if (this.anthropicParameters.reasoningEffort && body.output_config === undefined) {
            body.output_config = { effort: this.anthropicParameters.reasoningEffort };
        }
        const [formattedTools, formattedChoice] = this.formatTools(
            tools,
            normalizedToolChoice ?? null
        );
        if (formattedTools?.length) body.tools = formattedTools;
        if (formattedChoice) body.tool_choice = formattedChoice;

        const formattedMessages = [...messages] as Array<Record<string, unknown>>;
        if (formattedMessages[0]?.role === 'system') {
            body.system = formattedMessages.shift()!.content;
        }
        body.messages = formattedMessages;
        const raw = await this.client.create(body, signal as AbortSignal | undefined);
        if (this.stream) {
            return this.parseStream(raw as AsyncIterable<Record<string, unknown>>, startedAt);
        }
        return this.parseCompletion(raw as Record<string, unknown>, startedAt);
    }

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return this.formatTools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): unknown[] {
        return this.formatTools(tools, null)[0] ?? [];
    }

    private thinkingMode(): AnthropicParameters['thinkingMode'] {
        if (this.anthropicParameters.thinkingMode !== undefined) {
            return this.anthropicParameters.thinkingMode;
        }
        return this.anthropicParameters.thinkingEnable ? 'enabled' : null;
    }

    private formatTools(
        tools: ToolSchema[] | undefined,
        choice: ToolChoice | null
    ): [Record<string, unknown>[] | null, Record<string, unknown> | null] {
        let selected = tools;
        if (choice?.tools?.length && selected) {
            const allowed = new Set(choice.tools);
            selected = selected.filter(tool => allowed.has(tool.function.name));
        }
        const formatted = selected?.map(tool => ({
            name: tool.function.name,
            description: tool.function.description ?? '',
            input_schema: tool.function.parameters ?? {},
        }));
        if (!choice) return [formatted ?? null, null];
        if (choice.mode === 'auto') return [formatted ?? null, { type: 'auto' }];
        if (choice.mode === 'none') return [formatted ?? null, { type: 'none' }];
        if (choice.mode === 'required') return [formatted ?? null, { type: 'any' }];
        return [formatted ?? null, { type: 'tool', name: choice.mode }];
    }

    private parseCompletion(raw: Record<string, unknown>, startedAt: number): ChatResponse {
        const response = new ChatResponse({
            id: typeof raw.id === 'string' ? raw.id : undefined,
            content: [],
            isLast: true,
        });
        for (const block of arrayOfRecords(raw.content)) {
            if (block.type === 'thinking') {
                response.content.push(
                    ThinkingBlock({
                        thinking: String(block.thinking ?? ''),
                        signature: String(block.signature ?? ''),
                    })
                );
            } else if (block.type === 'redacted_thinking') {
                response.content.push(
                    ThinkingBlock({
                        thinking: '',
                        redacted_thinking_data: String(block.data ?? ''),
                    })
                );
            } else if (block.type === 'text') {
                response.content.push(TextBlock({ text: String(block.text ?? '') }));
            } else if (block.type === 'tool_use') {
                response.content.push(
                    ToolCallBlock({
                        id: String(block.id ?? ''),
                        name: String(block.name ?? ''),
                        input: JSON.stringify(block.input ?? {}),
                    })
                );
            }
        }
        response.usage = parseUsage(raw.usage, startedAt);
        return response;
    }

    private async *parseStream(
        events: AsyncIterable<Record<string, unknown>>,
        startedAt: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let responseId: string = crypto.randomUUID();
        const textId = crypto.randomUUID();
        const thinkingId = crypto.randomUUID();
        const toolCalls = new Map<number, [string, string]>();
        const accumulator = new StreamAccumulator();
        let usage: ChatUsage | null = null;
        for await (const event of events) {
            const delta = new ChatResponse({ content: [], isLast: false, id: responseId });
            if (event.type === 'message_start') {
                const message = asRecord(event.message);
                if (typeof message.id === 'string') responseId = message.id;
                delta.id = responseId;
                usage = parseUsage(message.usage, startedAt);
            } else if (event.type === 'content_block_start') {
                const block = asRecord(event.content_block);
                const index = Number(event.index);
                if (block.type === 'tool_use') {
                    const id = String(block.id ?? '');
                    const name = String(block.name ?? '');
                    toolCalls.set(index, [id, name]);
                    delta.appendToolCall(id, name, '');
                } else if (block.type === 'redacted_thinking') {
                    delta.appendThinking('', crypto.randomUUID(), {
                        redacted_thinking_data: String(block.data ?? ''),
                    });
                }
            } else if (event.type === 'content_block_delta') {
                const value = asRecord(event.delta);
                const index = Number(event.index);
                if (value.type === 'text_delta') {
                    delta.appendText(String(value.text ?? ''), textId);
                } else if (value.type === 'thinking_delta') {
                    delta.appendThinking(String(value.thinking ?? ''), thinkingId);
                } else if (value.type === 'signature_delta') {
                    delta.appendThinking('', thinkingId, {
                        signature: String(value.signature ?? ''),
                    });
                } else if (value.type === 'input_json_delta' && toolCalls.has(index)) {
                    const [id, name] = toolCalls.get(index)!;
                    delta.appendToolCall(id, name, String(value.partial_json ?? ''));
                }
            } else if (event.type === 'message_delta' && usage) {
                const value = asRecord(event.usage);
                usage.outputTokens = Number(value.output_tokens ?? usage.outputTokens);
            }
            if (delta.content.length > 0) {
                delta.usage = usage;
                accumulator.appendChatResponse(delta);
                accumulator.id = responseId;
                yield delta;
            }
        }
        accumulator.id = responseId;
        accumulator.usage = usage;
        return accumulator.build();
    }
}

function createAnthropicHTTPClient(
    credential: AnthropicCredential,
    fetcher: FetchLike | undefined,
    stream: boolean
): AnthropicClient {
    const base = (credential.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const url = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`;
    const request = {
        headers: {
            'x-api-key': credential.apiKey,
            'anthropic-version': '2023-06-01',
        },
        fetch: fetcher,
    };
    return {
        create: (body, signal) => {
            const options = { ...request, signal };
            return stream ? postSSE(url, body, options) : postJSON(url, body, options);
        },
    };
}

function parseUsage(value: unknown, startedAt: number): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    return new ChatUsage({
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        time: (Date.now() - startedAt) / 1000,
        cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
        cacheInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    });
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(asRecord) : [];
}
