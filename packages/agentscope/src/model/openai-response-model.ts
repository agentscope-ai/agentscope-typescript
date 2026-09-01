/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential/providers';
import { OpenAIResponseFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import { createOpenAICompatibleHTTPClient, OpenAICompatibleClient } from './openai-compatible';
import { ChatResponse, StreamAccumulator } from './response';
import { ChatUsage } from './usage';

export interface OpenAIResponseParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
    temperature?: number | null;
}

export interface OpenAIResponseModelOptions {
    credential: OpenAICredential;
    model: string;
    parameters?: OpenAIResponseParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: OpenAICompatibleClient;
    fetch?: FetchLike;
}

/** OpenAI Responses API model. */
export class OpenAIResponseModel extends ChatModelBase {
    readonly type = 'openai_response' as const;
    readonly responseParameters: OpenAIResponseParameters;
    private readonly client: OpenAICompatibleClient;

    constructor(options: OpenAIResponseModelOptions) {
        const parameters = options.parameters ?? {};
        super({
            modelName: options.model,
            credential: options.credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 200000,
            formatter: options.formatter ?? new OpenAIResponseFormatter(),
        });
        this.responseParameters = parameters;
        this.client =
            options.client ??
            createOpenAICompatibleHTTPClient({
                apiKey: options.credential.apiKey,
                baseUrl: options.credential.baseUrl ?? 'https://api.openai.com/v1',
                endpoint: 'responses',
                headers: options.credential.organization
                    ? { 'openai-organization': options.credential.organization }
                    : undefined,
                fetch: options.fetch,
            });
    }

    protected isRetryableError(error: unknown): boolean {
        return (
            error instanceof TypeError ||
            (error instanceof Error &&
                ['RateLimitError', 'HTTP500Error', 'HTTP502Error', 'HTTP503Error'].includes(
                    error.name
                ))
        );
    }

    protected isStructuredOutputFallbackError(error: unknown): boolean {
        return (
            super.isStructuredOutputFallbackError(error) ||
            (error instanceof Error && error.name === 'HTTP400Error')
        );
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        delete callOptions.modalities;
        delete callOptions.audio;
        const parameters = this.responseParameters;
        const body: Record<string, unknown> = {
            model: modelName,
            input: messages,
            stream: this.stream,
        };
        if (parameters.maxTokens != null) body.max_output_tokens = parameters.maxTokens;
        if (parameters.temperature != null) body.temperature = parameters.temperature;
        if (parameters.thinkingEnable && parameters.reasoningEffort) {
            body.reasoning = { effort: parameters.reasoningEffort };
        }
        Object.assign(body, callOptions);
        const [formattedTools, formattedChoice] = formatResponseTools(
            tools,
            normalizedToolChoice ?? null
        );
        if (formattedTools) body.tools = formattedTools;
        if (formattedChoice) body.tool_choice = formattedChoice;
        const raw = await this.client.create(body, signal as AbortSignal | undefined);
        return this.stream
            ? this.parseStream(raw as AsyncIterable<Record<string, unknown>>, startedAt)
            : parseCompletion(raw, startedAt);
    }

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return formatResponseTools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): unknown[] {
        return formatResponseTools(tools, null)[0] ?? [];
    }

    private async *parseStream(
        events: AsyncIterable<Record<string, unknown>>,
        startedAt: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const responseId = crypto.randomUUID();
        const textId = crypto.randomUUID();
        const reasoningIds = new Map<string, string>();
        const toolCalls = new Map<string, { id: string; name: string }>();
        const accumulator = new StreamAccumulator();
        for await (const event of events) {
            const delta = new ChatResponse({ id: responseId, content: [], isLast: false });
            let usage: ChatUsage | null = null;
            const type = stringValue(event.type);
            if (type === 'response.reasoning_summary_text.delta') {
                const itemId = stringValue(event.item_id);
                const blockId = getOrCreate(reasoningIds, itemId);
                delta.appendThinking(stringValue(event.delta), blockId);
            } else if (type === 'response.output_text.delta') {
                delta.appendText(stringValue(event.delta), textId);
            } else if (type === 'response.output_item.added') {
                const item = asRecord(event.item);
                if (item.type === 'function_call') {
                    toolCalls.set(stringValue(item.id), {
                        id: stringValue(item.call_id) || crypto.randomUUID(),
                        name: stringValue(item.name) || 'unknown',
                    });
                }
            } else if (type === 'response.function_call_arguments.delta') {
                const call = toolCalls.get(stringValue(event.item_id));
                if (call) {
                    delta.appendToolCall(call.id, call.name, stringValue(event.delta));
                }
            } else if (type === 'response.completed') {
                const response = asRecord(event.response);
                usage = extractUsage(response.usage, startedAt);
                for (const value of asArray(response.output)) {
                    const item = asRecord(value);
                    const itemId = stringValue(item.id);
                    if (item.type === 'reasoning' && itemId) {
                        delta.appendThinking('', getOrCreate(reasoningIds, itemId), {
                            reasoning_item_id: itemId,
                            reasoning_item_raw: withoutNull(item),
                        });
                    }
                }
            }
            delta.usage = usage;
            if (delta.content.length > 0 || usage) {
                accumulator.appendChatResponse(delta);
                accumulator.id = responseId;
                yield delta;
            }
        }
        return accumulator.build();
    }
}

function parseCompletion(value: unknown, startedAt: number): ChatResponse {
    const response = asRecord(value);
    const content = [] as ChatResponse['content'];
    for (const value of asArray(response.output)) {
        const item = asRecord(value);
        if (item.type === 'reasoning') {
            const id = stringValue(item.id);
            const summary = asArray(item.summary)
                .map(value => stringValue(asRecord(value).text))
                .filter(Boolean)
                .join(' ');
            if (summary || id) {
                content.push(
                    ThinkingBlock({
                        thinking: summary,
                        reasoning_item_id: id || null,
                        reasoning_item_raw: withoutNull(item),
                    })
                );
            }
        } else if (item.type === 'message') {
            for (const value of asArray(item.content)) {
                const part = asRecord(value);
                if (part.type === 'output_text') {
                    content.push(TextBlock({ text: stringValue(part.text) }));
                }
            }
        } else if (item.type === 'function_call') {
            content.push(
                ToolCallBlock({
                    id: stringValue(item.call_id) || crypto.randomUUID(),
                    name: stringValue(item.name),
                    input: stringValue(item.arguments) || '{}',
                })
            );
        }
    }
    return new ChatResponse({
        id: stringValue(response.id) || crypto.randomUUID(),
        content,
        isLast: true,
        usage: extractUsage(response.usage, startedAt),
    });
}

function formatResponseTools(
    tools: ToolSchema[] | undefined,
    choice: ToolChoice | null
): [Record<string, unknown>[] | null, string | Record<string, unknown> | null] {
    const formatted = tools?.length
        ? tools.map(tool => ({ type: 'function', ...tool.function }))
        : null;
    if (!choice) return [formatted, null];
    if (!['auto', 'none', 'required'].includes(choice.mode)) {
        return [formatted, { type: 'function', name: choice.mode }];
    }
    if (choice.tools?.length) {
        return [
            formatted,
            {
                type: 'allowed_tools',
                mode: choice.mode,
                tools: choice.tools.map(name => ({ type: 'function', name })),
            },
        ];
    }
    return [formatted, choice.mode];
}

function extractUsage(value: unknown, startedAt: number): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    return new ChatUsage({
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        time: (Date.now() - startedAt) / 1000,
        cacheInputTokens: Number(asRecord(usage.input_tokens_details).cached_tokens ?? 0),
    });
}

function getOrCreate(values: Map<string, string>, key: string): string {
    const current = values.get(key);
    if (current) return current;
    const created = crypto.randomUUID();
    values.set(key, created);
    return created;
}

function withoutNull(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutNull);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== null && item !== undefined)
            .map(([key, item]) => [key, withoutNull(item)])
    );
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
