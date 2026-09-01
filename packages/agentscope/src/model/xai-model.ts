/* eslint-disable jsdoc/require-jsdoc */

import { XAICredential } from '../credential/providers';
import { XAIChatFormatter } from '../formatter';
import type { XAIMessage } from '../formatter';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import { postJSON, postSSE } from './http-transport';
import { ChatResponse, StreamAccumulator } from './response';
import { ChatUsage } from './usage';

export interface XAIParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high' | null;
    temperature?: number | null;
    topP?: number | null;
}

export interface XAIClient {
    create(body: Record<string, unknown>, stream: boolean, signal?: AbortSignal): Promise<unknown>;
    close?(): Promise<void>;
}

export interface XAIChatModelOptions {
    credential: XAICredential;
    model: string;
    parameters?: XAIParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: XAIChatFormatter;
    client?: XAIClient;
    fetch?: FetchLike;
}

/** xAI model with typed SDK contracts and a Responses API transport. */
export class XAIChatModel extends ChatModelBase {
    readonly type = 'xai_chat' as const;
    readonly xaiParameters: XAIParameters;
    private readonly client: XAIClient;

    constructor(options: XAIChatModelOptions) {
        const parameters = options.parameters ?? {};
        super({
            modelName: options.model,
            credential: options.credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 131072,
            formatter: options.formatter ?? new XAIChatFormatter(),
        });
        this.xaiParameters = parameters;
        this.client = options.client ?? createXAIResponsesClient(options.credential, options.fetch);
    }

    protected isRetryableError(error: unknown): boolean {
        return error instanceof Error;
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        const serverTools = asArray(callOptions.serverTools ?? callOptions.server_tools);
        delete callOptions.serverTools;
        delete callOptions.server_tools;
        const parameters = this.xaiParameters;
        const [formattedTools, formattedChoice] = formatXAITools(
            tools,
            normalizedToolChoice ?? null
        );
        const body: Record<string, unknown> = { model: modelName, messages, ...callOptions };
        if (parameters.maxTokens != null) body.max_tokens = parameters.maxTokens;
        if (parameters.temperature != null) body.temperature = parameters.temperature;
        if (parameters.topP != null) body.top_p = parameters.topP;
        if (parameters.thinkingEnable && parameters.reasoningEffort) {
            body.reasoning_effort = parameters.reasoningEffort;
        }
        const allTools = [...(formattedTools ?? []), ...serverTools];
        if (allTools.length > 0) body.tools = allTools;
        if (formattedChoice) body.tool_choice = formattedChoice;
        const raw = await this.client.create(body, this.stream, signal as AbortSignal | undefined);
        if (this.stream) {
            return this.parseStream(raw as AsyncIterable<Record<string, unknown>>, startedAt);
        }
        try {
            return parseCompletion(raw, startedAt);
        } finally {
            await this.client.close?.();
        }
    }

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return formatXAITools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): unknown[] {
        return formatXAITools(tools, null)[0] ?? [];
    }

    private async *parseStream(
        values: AsyncIterable<Record<string, unknown>>,
        startedAt: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let responseId: string = crypto.randomUUID();
        const textId = crypto.randomUUID();
        const thinkingId = crypto.randomUUID();
        const responseToolCalls = new Map<string, { id: string; name: string }>();
        const accumulator = new StreamAccumulator();
        let lastResponse: Record<string, unknown> | null = null;
        try {
            for await (const value of values) {
                if (value.type) {
                    const parsed = parseResponsesEvent(
                        value,
                        responseId,
                        textId,
                        thinkingId,
                        startedAt,
                        responseToolCalls
                    );
                    if (parsed.responseId) responseId = parsed.responseId;
                    if (parsed.response) lastResponse = parsed.response;
                    if (parsed.chunk) {
                        accumulator.appendChatResponse(parsed.chunk);
                        accumulator.id = responseId;
                        yield parsed.chunk;
                    }
                    continue;
                }
                const response = asRecord(value.response);
                const chunk = asRecord(value.chunk);
                if (Object.keys(response).length > 0) {
                    lastResponse = response;
                    responseId = stringValue(response.id) || responseId;
                }
                const delta = new ChatResponse({ id: responseId, content: [], isLast: false });
                const thinking = stringValue(chunk.reasoning_content);
                if (thinking) delta.appendThinking(thinking, thinkingId);
                const text = stringValue(chunk.content);
                if (text) delta.appendText(text, textId);
                if (delta.content.length > 0) {
                    accumulator.appendChatResponse(delta);
                    accumulator.id = responseId;
                    yield delta;
                }
            }
        } finally {
            await this.client.close?.();
        }
        if (lastResponse) {
            const trailing = responseCarrier(lastResponse, responseId, startedAt);
            if (trailing.content.length > 0 || trailing.usage) {
                accumulator.appendChatResponse(trailing);
                accumulator.id = responseId;
                yield trailing;
            }
        }
        accumulator.id = responseId;
        return accumulator.build();
    }
}

function formatXAITools(
    tools: ToolSchema[] | undefined,
    choice: ToolChoice | null
): [Record<string, unknown>[] | null, string | Record<string, unknown> | null] {
    let selected = tools;
    if (choice?.tools?.length && selected) {
        const allowed = new Set(choice.tools);
        selected = selected.filter(tool => allowed.has(tool.function.name));
    }
    const formatted = selected?.length
        ? selected.map(tool => ({
              type: 'client_side_tool',
              function: {
                  name: tool.function.name,
                  description: tool.function.description ?? '',
                  parameters: tool.function.parameters ?? {},
              },
          }))
        : null;
    if (!choice) return [formatted, null];
    if (['auto', 'none', 'required'].includes(choice.mode)) return [formatted, choice.mode];
    return [formatted, { type: 'required_tool', name: choice.mode }];
}

function parseCompletion(value: unknown, startedAt: number): ChatResponse {
    const response = asRecord(value);
    if (Array.isArray(response.output)) return parseResponsesCompletion(response, startedAt);
    const content = [] as ChatResponse['content'];
    const thinking = stringValue(response.reasoning_content);
    if (thinking) content.push(ThinkingBlock({ thinking }));
    const text = stringValue(response.content);
    if (text) content.push(TextBlock({ text }));
    appendToolCalls(content, response.tool_calls);
    return new ChatResponse({
        id: stringValue(response.id) || crypto.randomUUID(),
        content,
        isLast: true,
        usage: extractXAIUsage(response.usage, startedAt),
    });
}

function parseResponsesCompletion(
    response: Record<string, unknown>,
    startedAt: number
): ChatResponse {
    const content = [] as ChatResponse['content'];
    for (const value of asArray(response.output)) {
        const item = asRecord(value);
        if (item.type === 'reasoning') {
            const summary = asArray(item.summary)
                .map(value => stringValue(asRecord(value).text))
                .filter(Boolean)
                .join(' ');
            if (summary) content.push(ThinkingBlock({ thinking: summary }));
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
                    input: stringValue(item.arguments),
                })
            );
        }
    }
    return new ChatResponse({
        id: stringValue(response.id) || crypto.randomUUID(),
        content,
        isLast: true,
        usage: extractResponsesUsage(response.usage, startedAt),
    });
}

function responseCarrier(
    response: Record<string, unknown>,
    responseId: string,
    startedAt: number
): ChatResponse {
    const carrier = new ChatResponse({ id: responseId, content: [], isLast: false });
    appendToolCalls(carrier.content, response.tool_calls);
    carrier.usage = extractXAIUsage(response.usage, startedAt);
    return carrier;
}

function appendToolCalls(content: ChatResponse['content'], calls: unknown): void {
    for (const value of asArray(calls)) {
        const call = asRecord(value);
        const fn = asRecord(call.function);
        content.push(
            ToolCallBlock({
                id: stringValue(call.id) || crypto.randomUUID(),
                name: stringValue(fn.name),
                input: stringValue(fn.arguments),
            })
        );
    }
}

function extractXAIUsage(value: unknown, startedAt: number): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    return new ChatUsage({
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0) + Number(usage.reasoning_tokens ?? 0),
        time: (Date.now() - startedAt) / 1000,
        cacheInputTokens: Number(usage.cached_prompt_text_tokens ?? 0),
    });
}

function extractResponsesUsage(value: unknown, startedAt: number): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    return new ChatUsage({
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        time: (Date.now() - startedAt) / 1000,
        cacheInputTokens: Number(asRecord(usage.input_tokens_details).cached_tokens ?? 0),
    });
}

function parseResponsesEvent(
    event: Record<string, unknown>,
    responseId: string,
    textId: string,
    thinkingId: string,
    startedAt: number,
    toolCalls: Map<string, { id: string; name: string }>
): { chunk: ChatResponse | null; response: Record<string, unknown> | null; responseId?: string } {
    const type = stringValue(event.type);
    const chunk = new ChatResponse({ id: responseId, content: [], isLast: false });
    if (type === 'response.reasoning_summary_text.delta') {
        chunk.appendThinking(stringValue(event.delta), thinkingId);
    } else if (type === 'response.output_text.delta') {
        chunk.appendText(stringValue(event.delta), textId);
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
        if (call) chunk.appendToolCall(call.id, call.name, stringValue(event.delta));
    } else if (type === 'response.completed') {
        const response = asRecord(event.response);
        chunk.usage = extractResponsesUsage(response.usage, startedAt);
        return {
            chunk: chunk.usage ? chunk : null,
            response: null,
            responseId: stringValue(response.id) || responseId,
        };
    }
    return { chunk: chunk.content.length > 0 ? chunk : null, response: null };
}

function createXAIResponsesClient(credential: XAICredential, fetcher?: FetchLike): XAIClient {
    const url = `https://${credential.apiHost}/v1/responses`;
    const headers = { authorization: `Bearer ${credential.apiKey}` };
    return {
        create: async (body, stream, signal) => {
            const tools = asArray(body.tools).map(toResponsesTool);
            const wire: Record<string, unknown> = {
                ...body,
                input: toResponsesInput(body.messages as XAIMessage[]),
                stream,
            };
            delete wire.messages;
            if (tools.length > 0) wire.tools = tools;
            const choice = asRecord(wire.tool_choice);
            if (choice.type === 'required_tool') {
                wire.tool_choice = { type: 'function', name: choice.name };
            }
            if (wire.max_tokens !== undefined) {
                wire.max_output_tokens = wire.max_tokens;
                delete wire.max_tokens;
            }
            if (wire.reasoning_effort !== undefined) {
                wire.reasoning = { effort: wire.reasoning_effort };
                delete wire.reasoning_effort;
            }
            const options = { fetch: fetcher, headers, signal };
            return stream ? postSSE(url, wire, options) : postJSON(url, wire, options);
        },
    };
}

function toResponsesTool(value: unknown): unknown {
    const tool = asRecord(value);
    if (tool.type !== 'client_side_tool') return tool;
    return { type: 'function', ...asRecord(tool.function) };
}

function toResponsesInput(messages: XAIMessage[]): unknown[] {
    const input: unknown[] = [];
    for (const message of messages) {
        if ('args' in message) {
            if (message.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: message.tool_call_id,
                    output: message.args[0],
                });
                continue;
            }
            const content = message.args.map(value =>
                typeof value === 'string'
                    ? {
                          type: message.role === 'assistant' ? 'output_text' : 'input_text',
                          text: value,
                      }
                    : { type: 'input_image', image_url: value.url }
            );
            input.push({ role: message.role, content });
            continue;
        }
        input.push({ role: 'assistant', content: message.content });
        input.push(
            ...message.tool_calls.map(call => ({
                type: 'function_call',
                call_id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
            }))
        );
    }
    return input;
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
