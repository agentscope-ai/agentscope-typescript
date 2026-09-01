/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import { GeminiChatFormatter } from '../formatter';
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

export interface GeminiParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    thinkingBudget?: number | null;
    temperature?: number | null;
    topP?: number | null;
}

export interface GeminiRequest {
    model: string;
    contents: unknown[];
    config: Record<string, unknown>;
}

export interface GeminiClient {
    generateContent(
        request: GeminiRequest,
        stream: boolean,
        signal?: AbortSignal
    ): Promise<unknown>;
}

export interface GeminiChatModelOptions {
    credential: GeminiCredential;
    model: string;
    parameters?: GeminiParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: GeminiClient;
    fetch?: FetchLike;
}

/** Google Gemini model with SDK-shape contracts and fetch transport. */
export class GeminiChatModel extends ChatModelBase {
    readonly type = 'gemini_chat' as const;
    readonly geminiParameters: GeminiParameters;
    private readonly client: GeminiClient;

    constructor(options: GeminiChatModelOptions) {
        const parameters = options.parameters ?? {};
        super({
            modelName: options.model,
            credential: options.credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 1048576,
            formatter: options.formatter ?? new GeminiChatFormatter(),
        });
        this.geminiParameters = parameters;
        this.client = options.client ?? createGeminiHTTPClient(options.credential, options.fetch);
    }

    protected isRetryableError(error: unknown): boolean {
        return error instanceof Error;
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...generateOptions } = options;
        delete generateOptions.toolChoice;
        delete generateOptions.schema;
        const config: Record<string, unknown> = { ...generateOptions };
        if (this.geminiParameters.maxTokens != null) {
            config.max_output_tokens = this.geminiParameters.maxTokens;
        }
        if (this.geminiParameters.temperature != null) {
            config.temperature = this.geminiParameters.temperature;
        }
        if (this.geminiParameters.topP != null) config.top_p = this.geminiParameters.topP;
        config.thinking_config = this.geminiParameters.thinkingEnable
            ? {
                  include_thoughts: true,
                  thinking_budget: this.geminiParameters.thinkingBudget || 1024,
              }
            : { include_thoughts: false, thinking_budget: 0 };

        const [formattedTools, formattedChoice] = this.formatTools(
            tools,
            normalizedToolChoice ?? null
        );
        if (formattedTools) config.tools = formattedTools;
        if (formattedChoice) config.tool_config = formattedChoice;
        const request = { model: modelName, contents: messages, config };
        const raw = await this.client.generateContent(
            request,
            this.stream,
            signal as AbortSignal | undefined
        );
        return this.stream
            ? this.parseStream(raw as AsyncIterable<Record<string, unknown>>, startedAt)
            : this.parseCompletion(asRecord(raw), startedAt);
    }

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return this.formatTools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): unknown[] {
        return this.formatTools(tools, null)[0] ?? [];
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
        const declarations = (selected ?? []).map(tool => {
            const declaration: Record<string, unknown> = { ...tool.function };
            if (tool.function.parameters) {
                declaration.parameters = sanitizeSchemaForGemini(
                    flattenJSONSchema(tool.function.parameters)
                );
            }
            return declaration;
        });
        const formatted =
            declarations.length > 0 ? [{ function_declarations: declarations }] : null;
        if (!choice) return [formatted, null];
        if (!['auto', 'none', 'required'].includes(choice.mode)) {
            return [
                formatted,
                {
                    function_calling_config: {
                        mode: 'ANY',
                        allowed_function_names: [choice.mode],
                    },
                },
            ];
        }
        const modes = { auto: 'AUTO', none: 'NONE', required: 'ANY' } as const;
        return [
            formatted,
            { function_calling_config: { mode: modes[choice.mode as keyof typeof modes] } },
        ];
    }

    private parseCompletion(raw: Record<string, unknown>, startedAt: number): ChatResponse {
        const content = [] as Array<
            ReturnType<typeof TextBlock | typeof ThinkingBlock | typeof ToolCallBlock>
        >;
        for (const part of responseParts(raw)) {
            const text = part.text;
            if (typeof text === 'string' && text) {
                content.push(
                    getValue(part, 'thought')
                        ? ThinkingBlock({ thinking: text })
                        : TextBlock({ text })
                );
            }
            const call = asRecord(getValue(part, 'function_call', 'functionCall'));
            if (Object.keys(call).length > 0) {
                content.push(
                    ToolCallBlock({
                        id: toolCallId(part, call),
                        name: String(call.name ?? ''),
                        input: JSON.stringify(call.args ?? {}),
                    })
                );
            }
        }
        return new ChatResponse({
            id: String(getValue(raw, 'response_id', 'responseId') ?? crypto.randomUUID()),
            content,
            isLast: true,
            usage: extractUsage(getValue(raw, 'usage_metadata', 'usageMetadata'), startedAt),
        });
    }

    private async *parseStream(
        chunks: AsyncIterable<Record<string, unknown>>,
        startedAt: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let responseId: string = crypto.randomUUID();
        const textId = crypto.randomUUID();
        const thinkingId = crypto.randomUUID();
        const accumulator = new StreamAccumulator();
        for await (const chunk of chunks) {
            responseId = String(getValue(chunk, 'response_id', 'responseId') ?? responseId);
            const delta = new ChatResponse({ content: [], isLast: false, id: responseId });
            for (const part of responseParts(chunk)) {
                if (typeof part.text === 'string' && part.text) {
                    if (getValue(part, 'thought')) {
                        delta.appendThinking(part.text, thinkingId);
                    } else delta.appendText(part.text, textId);
                }
                const call = asRecord(getValue(part, 'function_call', 'functionCall'));
                if (Object.keys(call).length > 0) {
                    delta.appendToolCall(
                        toolCallId(part, call),
                        String(call.name ?? ''),
                        JSON.stringify(call.args ?? {})
                    );
                }
            }
            const usage = extractUsage(
                getValue(chunk, 'usage_metadata', 'usageMetadata'),
                startedAt
            );
            delta.usage = usage;
            if (delta.content.length > 0) {
                accumulator.appendChatResponse(delta);
                accumulator.id = responseId;
                yield delta;
            } else if (usage) accumulator.usage = usage;
        }
        accumulator.id = responseId;
        return accumulator.build();
    }
}

export function sanitizeSchemaForGemini(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
    if (typeof schema !== 'object' || schema === null) return schema;
    const result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
    delete result.$schema;
    delete result.additionalProperties;
    if (result.const !== undefined) {
        if (result.enum === undefined) result.enum = [result.const];
        delete result.const;
    }
    if (isNullSchema(result)) result.type = 'object';
    else if (Array.isArray(result.type)) {
        const types = result.type.filter(type => type !== 'null');
        if (types.length === 1) result.type = types[0];
        else if (types.length > 0) {
            if (result.anyOf !== undefined) {
                throw new Error(
                    'Cannot safely sanitize Gemini schema with both a multi-type nullable type array and anyOf.'
                );
            }
            delete result.type;
            result.anyOf = types.map(type => ({ type }));
        } else result.type = 'object';
    }
    if (Array.isArray(result.anyOf)) {
        const values = result.anyOf.filter(value => !isNullSchema(value));
        if (values.length < result.anyOf.length) {
            if (values.length === 1) {
                const merged = asRecord(sanitizeSchemaForGemini(values[0]));
                for (const [key, value] of Object.entries(result)) {
                    if (key !== 'anyOf' && merged[key] === undefined) merged[key] = value;
                }
                return merged;
            }
            if (values.length > 0) result.anyOf = values.map(sanitizeSchemaForGemini);
            else delete result.anyOf;
        }
    }
    for (const key of ['properties', 'patternProperties', '$defs']) {
        const value = asRecord(result[key]);
        if (Object.keys(value).length > 0) {
            result[key] = Object.fromEntries(
                Object.entries(value).map(([name, item]) => [name, sanitizeSchemaForGemini(item)])
            );
        }
    }
    for (const key of ['items', 'not', 'if', 'then', 'else']) {
        if (result[key] !== undefined) result[key] = sanitizeSchemaForGemini(result[key]);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
        if (Array.isArray(result[key])) {
            result[key] = result[key].map(sanitizeSchemaForGemini);
        }
    }
    return result;
}

export function flattenJSONSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const hasDefinitions = isRecord(schema.$defs) || isRecord(schema.definitions);
    if (!hasDefinitions) return schema;
    const copy = structuredClone(schema);
    const definitions = { ...asRecord(copy.$defs), ...asRecord(copy.definitions) };
    delete copy.$defs;
    delete copy.definitions;
    if (Object.keys(definitions).length === 0) return copy;
    const resolve = (value: unknown, visited = new Set<string>()): unknown => {
        if (Array.isArray(value)) return value.map(item => resolve(item, visited));
        if (typeof value !== 'object' || value === null) return value;
        const object = value as Record<string, unknown>;
        if (typeof object.$ref === 'string' && /^#\/(\$defs|definitions)\//.test(object.$ref)) {
            const name = object.$ref.split('/').at(-1)!;
            if (visited.has(name)) return { type: 'object', description: `(circular: ${name})` };
            if (definitions[name]) {
                const nextVisited = new Set(visited).add(name);
                return {
                    ...asRecord(resolve(definitions[name], nextVisited)),
                    ...Object.fromEntries(
                        Object.entries(object)
                            .filter(([key]) => key !== '$ref')
                            .map(([key, item]) => [key, resolve(item, nextVisited)])
                    ),
                };
            }
        }
        return Object.fromEntries(
            Object.entries(object)
                .filter(([key]) => key !== '$defs' && key !== 'definitions')
                .map(([key, item]) => [key, resolve(item, visited)])
        );
    };
    return asRecord(resolve(copy));
}

function createGeminiHTTPClient(credential: GeminiCredential, fetcher?: FetchLike): GeminiClient {
    return {
        generateContent: async (request, stream, signal) => {
            const method = stream ? 'streamGenerateContent' : 'generateContent';
            const url =
                `https://generativelanguage.googleapis.com/v1beta/models/` +
                `${encodeURIComponent(request.model)}:${method}?key=${encodeURIComponent(credential.apiKey)}` +
                (stream ? '&alt=sse' : '');
            const config = asRecord(snakeToCamel(request.config));
            const { tools, toolConfig, ...generationConfig } = config;
            const body: Record<string, unknown> = {
                contents: snakeToCamel(request.contents),
                generationConfig,
            };
            if (tools !== undefined) body.tools = tools;
            if (toolConfig !== undefined) body.toolConfig = toolConfig;
            const options = { fetch: fetcher, signal };
            return stream ? postSSE(url, body, options) : postJSON(url, body, options);
        },
    };
}

function extractUsage(value: unknown, startedAt: number): ChatUsage | null {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return null;
    const promptValue = getValue(usage, 'prompt_token_count', 'promptTokenCount');
    const totalValue = getValue(usage, 'total_token_count', 'totalTokenCount');
    if (promptValue == null || totalValue == null) return null;
    const prompt = Number(promptValue);
    const tools = Number(
        getValue(usage, 'tool_use_prompt_token_count', 'toolUsePromptTokenCount') ?? 0
    );
    const total = Number(totalValue);
    const candidates = getValue(usage, 'candidates_token_count', 'candidatesTokenCount');
    const thoughts = Number(getValue(usage, 'thoughts_token_count', 'thoughtsTokenCount') ?? 0);
    const input = prompt + tools;
    return new ChatUsage({
        inputTokens: input,
        outputTokens: candidates == null ? total - input : Number(candidates) + thoughts,
        time: (Date.now() - startedAt) / 1000,
        cacheInputTokens: Number(
            getValue(usage, 'cached_content_token_count', 'cachedContentTokenCount') ?? 0
        ),
    });
}

function responseParts(raw: Record<string, unknown>): Record<string, unknown>[] {
    const candidate = asRecord((raw.candidates as unknown[] | undefined)?.[0]);
    const content = asRecord(candidate.content);
    return Array.isArray(content.parts) ? content.parts.map(asRecord) : [];
}

function toolCallId(part: Record<string, unknown>, call: Record<string, unknown>): string {
    const signature = getValue(part, 'thought_signature', 'thoughtSignature');
    if (signature instanceof Uint8Array) return Buffer.from(signature).toString('base64');
    if (typeof signature === 'string' && signature) return signature;
    return typeof call.id === 'string' && call.id ? call.id : crypto.randomUUID();
}

function isNullSchema(value: unknown): boolean {
    const schema = asRecord(value);
    return (
        schema.type === 'null' ||
        (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null')
    );
}

function getValue(object: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) if (object[key] !== undefined) return object[key];
    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snakeToCamel(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(snakeToCamel);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
            key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            snakeToCamel(item),
        ])
    );
}
