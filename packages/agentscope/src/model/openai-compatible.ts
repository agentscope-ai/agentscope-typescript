/* eslint-disable jsdoc/require-jsdoc */

import { _buildStreamingWavHeader } from '../_utils/audio';
import { Base64Source, DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import type { ToolSchema } from '../type';
import type { FetchLike } from './http-transport';
import { postJSON, postSSE } from './http-transport';
import { ChatResponse, StreamAccumulator } from './response';
import { ChatUsage } from './usage';

export interface OpenAICompatibleClient {
    create(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface OpenAICompatibleParseOptions {
    cacheTokens?: (usage: Record<string, unknown>) => number;
    audioFormat?: string;
    includeAudio?: boolean;
}

export function createOpenAICompatibleHTTPClient(options: {
    apiKey?: string;
    baseUrl: string;
    endpoint?: string;
    headers?: Record<string, string>;
    fetch?: FetchLike;
}): OpenAICompatibleClient {
    const url = joinURL(options.baseUrl, options.endpoint ?? 'chat/completions');
    const headers = {
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
    };
    return {
        create: async (body, signal) => {
            const wireBody = { ...body };
            const extraBody = asRecord(wireBody.extra_body);
            delete wireBody.extra_body;
            Object.assign(wireBody, extraBody);
            const requestOptions = { headers, signal, fetch: options.fetch };
            return wireBody.stream
                ? postSSE(url, wireBody, requestOptions)
                : postJSON(url, wireBody, requestOptions);
        },
    };
}

export function formatOpenAITools(
    tools: ToolSchema[] | undefined,
    toolChoice: { mode: string; tools?: string[] | null } | null,
    transform?: (tools: ToolSchema[]) => ToolSchema[]
): [ToolSchema[] | null, string | Record<string, unknown> | null] {
    let selected = tools;
    if (toolChoice?.tools?.length && selected) {
        const allowed = new Set(toolChoice.tools);
        selected = selected.filter(tool => allowed.has(tool.function.name));
    }
    if (selected && transform) selected = transform(selected);
    const formatted = selected?.length ? selected : null;
    if (!toolChoice) return [formatted, null];
    if (!['auto', 'none', 'required'].includes(toolChoice.mode)) {
        return [formatted, { type: 'function', function: { name: toolChoice.mode } }];
    }
    return [formatted, toolChoice.mode];
}

export function parseOpenAICompletion(
    rawValue: unknown,
    startedAt: number,
    options: OpenAICompatibleParseOptions = {}
): ChatResponse {
    const raw = asRecord(rawValue);
    const message = asRecord(asRecord((raw.choices as unknown[] | undefined)?.[0]).message);
    const content = [] as ChatResponse['content'];
    const reasoning = firstString(message.reasoning_content, message.reasoning);
    if (reasoning) content.push(ThinkingBlock({ thinking: reasoning }));
    const text = firstString(message.content);
    if (text) content.push(TextBlock({ text }));

    if (options.includeAudio) {
        const audio = asRecord(message.audio);
        const transcript = firstString(audio.transcript);
        if (!text && transcript) content.push(TextBlock({ text: transcript }));
        const data = firstString(audio.data);
        if (data) {
            content.push(
                DataBlock({
                    source: Base64Source({
                        data,
                        media_type: `audio/${options.audioFormat ?? 'wav'}`,
                    }),
                })
            );
        }
    }

    for (const value of asArray(message.tool_calls)) {
        const call = asRecord(value);
        const fn = asRecord(call.function);
        content.push(
            ToolCallBlock({
                id: firstString(call.id) || crypto.randomUUID(),
                name: firstString(fn.name) || 'unknown',
                input: firstString(fn.arguments) || '',
            })
        );
    }
    return new ChatResponse({
        id: firstString(raw.id) || crypto.randomUUID(),
        content,
        isLast: true,
        usage: extractOpenAIUsage(raw.usage, startedAt, options.cacheTokens),
    });
}

export async function* parseOpenAIStream(
    chunks: AsyncIterable<Record<string, unknown>>,
    startedAt: number,
    options: OpenAICompatibleParseOptions = {}
): AsyncGenerator<ChatResponse, ChatResponse> {
    let responseId: string = crypto.randomUUID();
    const textId = crypto.randomUUID();
    const thinkingId = crypto.randomUUID();
    const audioId = crypto.randomUUID();
    const toolCalls = new Map<number, { id: string; name: string }>();
    const accumulator = new StreamAccumulator();
    let audioHeaderSent = false;

    for await (const chunk of chunks) {
        responseId = firstString(chunk.id) || responseId;
        const deltaResponse = new ChatResponse({ id: responseId, content: [], isLast: false });
        const usage = extractOpenAIUsage(chunk.usage, startedAt, options.cacheTokens);
        const choice = asRecord(asArray(chunk.choices)[0]);
        const delta = asRecord(choice.delta);
        const reasoning = firstString(delta.reasoning_content, delta.reasoning);
        if (reasoning) deltaResponse.appendThinking(reasoning, thinkingId);

        let text = firstString(delta.content);
        if (options.includeAudio) {
            const audio = asRecord(delta.audio);
            text += firstString(audio.transcript);
            const encoded = firstString(audio.data);
            if (encoded) {
                const pcm = Buffer.from(encoded, 'base64');
                const payload = audioHeaderSent
                    ? pcm
                    : Buffer.concat([Buffer.from(_buildStreamingWavHeader()), pcm]);
                audioHeaderSent = true;
                deltaResponse.appendDataBlock(audioId, payload, 'audio/wav');
            }
        }
        if (text) deltaResponse.appendText(text, textId);

        for (const value of asArray(delta.tool_calls)) {
            const call = asRecord(value);
            const index = Number(call.index ?? 0);
            const fn = asRecord(call.function);
            const stored = toolCalls.get(index) ?? {
                id: firstString(call.id) || crypto.randomUUID(),
                name: firstString(fn.name) || 'unknown',
            };
            if (firstString(call.id)) stored.id = firstString(call.id);
            if (firstString(fn.name)) stored.name = firstString(fn.name);
            toolCalls.set(index, stored);
            deltaResponse.appendToolCall(stored.id, stored.name, firstString(fn.arguments));
        }

        deltaResponse.usage = usage;
        if (deltaResponse.content.length > 0 || usage) {
            accumulator.appendChatResponse(deltaResponse);
            accumulator.id = responseId;
            yield deltaResponse;
        }
    }
    accumulator.id = responseId;
    return accumulator.build();
}

export function extractOpenAIUsage(
    value: unknown,
    startedAt: number,
    cacheTokens?: (usage: Record<string, unknown>) => number
): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    return new ChatUsage({
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        time: (Date.now() - startedAt) / 1000,
        cacheInputTokens: cacheTokens?.(usage) ?? 0,
    });
}

export function nestedNumber(value: unknown, ...path: string[]): number {
    let current = value;
    for (const key of path) current = asRecord(current)[key];
    return Number(current ?? 0);
}

function joinURL(baseUrl: string, endpoint: string): string {
    return `${baseUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string {
    return (values.find(value => typeof value === 'string') as string | undefined) ?? '';
}
