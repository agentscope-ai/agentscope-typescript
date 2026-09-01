/* eslint-disable jsdoc/require-jsdoc */

import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';

import type { JSONSchema } from './card';
import { ChatResponse, FinishedReason, StreamAccumulator, StructuredResponse } from './response';
import { _jsonLoadsWithRepair } from '../_utils/common';
import type { CredentialBase } from '../credential/base';
import { StructuredOutputError } from '../exception';
import type { FormatterBase } from '../formatter/base';
import { TextBlock, createMsg, getContentBlocks } from '../message';
import type { ContentBlock, DataBlock, Msg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolInputSchema, ToolSchema } from '../type';

const TOOL_CHOICE_MODES = new Set(['auto', 'none', 'required']);
const MULTIMODAL_TOKEN_ESTIMATE = 2000;

export interface ChatModelOptions {
    modelName: string;
    credential?: CredentialBase;
    parameters?: Record<string, unknown>;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    fallbackModelName?: string;
    formatter?: FormatterBase;
}

export interface ChatModelCallOptions {
    messages: Msg[];
    tools?: ToolSchema[];
    toolChoice?: LegacyToolChoice | ToolChoice;
    [key: string]: unknown;
}

export interface ChatModelCallStructuredOptions {
    messages: Msg[];
    schema: z.ZodObject | JSONSchema;
    toolChoice?: LegacyToolChoice | ToolChoice;
    [key: string]: unknown;
}

export interface ChatModelRequestOptions<T> {
    messages: T[];
    tools?: ToolSchema[];
    toolChoice?: LegacyToolChoice;
    normalizedToolChoice?: ToolChoice | null;
    [key: string]: unknown;
}

/** Python-compatible base class for chat models with TypeScript adapters. */
export abstract class ChatModelBase {
    public modelName: string;
    public credential?: CredentialBase;
    public parameters: Record<string, unknown>;
    public stream: boolean;
    public maxRetries: number;
    public retryDelay: number;
    public contextSize: number;
    public fallbackModelName?: string;
    public formatter?: FormatterBase;

    protected constructor(options: ChatModelOptions) {
        this.modelName = options.modelName;
        this.credential = options.credential;
        this.parameters = options.parameters ?? {};
        this.stream = options.stream ?? true;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 1;
        this.contextSize = options.contextSize ?? 32768;
        this.fallbackModelName = options.fallbackModelName;
        this.formatter = options.formatter;
    }

    async call(
        options: ChatModelCallOptions
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const toolChoice = normalizeToolChoice(options.toolChoice);
        this.validateToolChoice(toolChoice, options.tools);
        const formattedMessages = this.formatter
            ? await this.formatter.format({ msgs: options.messages })
            : (options.messages as unknown[]);
        const requestOptions: ChatModelRequestOptions<unknown> = {
            ...options,
            messages: formattedMessages,
            toolChoice: toolChoice?.mode as LegacyToolChoice | undefined,
            normalizedToolChoice: toolChoice,
        };

        let result: ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>;
        try {
            result = await this.callWithRetry(this.modelName, requestOptions);
        } catch (error) {
            if (isCancellationError(error)) {
                return new ChatResponse({
                    content: [],
                    isLast: true,
                    finishedReason: FinishedReason.INTERRUPTED,
                });
            }
            if (!this.fallbackModelName) throw error;
            result = await this.callWithRetry(this.fallbackModelName, requestOptions);
        }

        if (!isAsyncGenerator(result)) return ChatResponse.from(result);
        return this.wrapStream(result);
    }

    protected abstract _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>>;

    abstract _formatToolChoice(toolChoice: LegacyToolChoice): unknown;

    abstract _formatToolSchemas(tools: ToolSchema[]): unknown[];

    protected isRetryableError(_error: unknown): boolean {
        return false;
    }

    protected isStructuredOutputFallbackError(error: unknown): boolean {
        return error instanceof StructuredOutputError;
    }

    protected getDisableThinkingOptions(): Record<string, unknown> {
        return {};
    }

    async countTokens(options: { messages: Msg[]; tools?: ToolSchema[] }): Promise<number> {
        const texts: string[] = [];
        const dataBlocks: DataBlock[] = [];
        for (const message of options.messages) {
            for (const block of getContentBlocks(message)) {
                collectBlockTokens(block, texts, dataBlocks);
            }
        }
        if (options.tools) texts.push(JSON.stringify(options.tools));
        return (
            dataBlocks.length * MULTIMODAL_TOKEN_ESTIMATE +
            Math.floor((Buffer.byteLength(texts.join(''), 'utf8') + 2) / 4)
        );
    }

    async callStructured(options: ChatModelCallStructuredOptions): Promise<StructuredResponse> {
        return this.generateStructuredOutput(options);
    }

    async generateStructuredOutput(
        options: ChatModelCallStructuredOptions
    ): Promise<StructuredResponse> {
        if (options.messages.length === 0) {
            throw new Error('The input messages cannot be empty for generateStructuredOutput.');
        }
        const explicitChoice = normalizeToolChoice(options.toolChoice);
        const disableThinking = this.getDisableThinkingOptions();
        const forced = new ToolChoice({ mode: 'generate_structured_output' });
        const strategies: Array<{
            choice: ToolChoice | null;
            extra: Record<string, unknown>;
        }> = explicitChoice
            ? [{ choice: explicitChoice, extra: {} }]
            : [
                  { choice: forced, extra: {} },
                  { choice: new ToolChoice({ mode: 'auto' }), extra: {} },
                  ...(Object.keys(disableThinking).length > 0
                      ? [{ choice: forced, extra: disableThinking }]
                      : []),
                  { choice: null, extra: {} },
              ];

        let firstError: unknown;
        let lastError: unknown;
        for (const strategy of strategies) {
            try {
                return await this.callStructuredOnce(options, strategy.choice, strategy.extra);
            } catch (error) {
                firstError ??= error;
                lastError = error;
                if (!this.isStructuredOutputFallbackError(error)) throw error;
            }
        }
        const error =
            lastError instanceof Error ? lastError : new StructuredOutputError(String(lastError));
        if (firstError instanceof Error && firstError !== error) {
            Object.defineProperty(error, 'cause', { value: firstError, configurable: true });
        }
        throw error;
    }

    protected validateToolChoice(choice: ToolChoice | null, tools?: ToolSchema[]): void {
        if (!choice) return;
        const available = (tools ?? []).map(tool => tool.function.name);
        for (const name of choice.tools ?? []) {
            if (!available.includes(name)) {
                throw new Error(
                    `Invalid tool name '${name}' in toolChoice.tools. Available tools: ` +
                        available.slice().sort().join(', ')
                );
            }
        }
        if (!TOOL_CHOICE_MODES.has(choice.mode)) {
            const scope = choice.tools?.length ? choice.tools : available;
            if (!scope.includes(choice.mode)) {
                throw new Error(
                    `Invalid tool name '${choice.mode}' in toolChoice.mode. Available tools: ` +
                        scope.slice().sort().join(', ')
                );
            }
        }
    }

    private async callWithRetry(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await this._callAPI(modelName, options);
            } catch (error) {
                lastError = error;
                if (!this.isRetryableError(error) || attempt === this.maxRetries) throw error;
                if (this.retryDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay * 1000));
                }
            }
        }
        throw lastError;
    }

    private async *wrapStream(
        stream: AsyncGenerator<ChatResponse, ChatResponse>
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const accumulator = new StreamAccumulator();
        try {
            while (true) {
                const result = await stream.next();
                if (result.done) {
                    return result.value ? ChatResponse.from(result.value) : accumulator.build();
                }
                const chunk = ChatResponse.from(result.value);
                if (!chunk.isLast) {
                    accumulator.appendChatResponse(chunk);
                    accumulator.id = chunk.id;
                    if (chunk.content.length === 0) continue;
                } else {
                    return chunk;
                }
                yield chunk;
            }
        } catch (error) {
            if (!isCancellationError(error)) throw error;
            accumulator.finishedReason = FinishedReason.INTERRUPTED;
            return accumulator.build();
        }
    }

    private async callStructuredOnce(
        options: ChatModelCallStructuredOptions,
        choice: ToolChoice | null,
        extra: Record<string, unknown>
    ): Promise<StructuredResponse> {
        const schema = isZodSchema(options.schema)
            ? (z.toJSONSchema(options.schema, { target: 'openapi-3.0' }) as ToolInputSchema)
            : (options.schema as ToolInputSchema);
        const instruction =
            "<system-reminder>Now you **MUST** call the tool named 'generate_structured_output' " +
            "to generate the structured output required by the user. DON'T do anything else.</system-reminder>";
        const messages = structuredClone(options.messages);
        const last = messages.at(-1)!;
        if (last.role === 'user')
            last.content = [...getContentBlocks(last), TextBlock({ text: instruction })];
        else messages.push(createMsg({ name: 'user', role: 'user', content: instruction }));
        const formattedMessages = this.formatter
            ? await this.formatter.format({ msgs: messages })
            : (messages as unknown[]);
        const request: ChatModelRequestOptions<unknown> = {
            ...options,
            ...mergeNestedOptions(options, extra),
            messages: formattedMessages,
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'generate_structured_output',
                        description: 'Generate the structured output required by the user.',
                        parameters: schema,
                    },
                },
            ],
            toolChoice: choice?.mode as LegacyToolChoice | undefined,
            normalizedToolChoice: choice,
        };
        const raw = await this.callWithRetry(this.modelName, request);
        const completed = isAsyncGenerator(raw) ? await consumeStream(raw) : ChatResponse.from(raw);
        const toolCall = completed.content.find(block => {
            return block.type === 'tool_call' && block.name === 'generate_structured_output';
        });
        if (!toolCall || toolCall.type !== 'tool_call') {
            throw new StructuredOutputError('Failed to generate structured output for model.');
        }
        let content: Record<string, JSONSerializable>;
        try {
            content = _jsonLoadsWithRepair(toolCall.input) as Record<string, JSONSerializable>;
            if (isZodSchema(options.schema)) options.schema.parse(content);
            else {
                const result = new Validator(options.schema).validate(content);
                if (!result.valid) throw new Error(JSON.stringify(result.errors));
            }
        } catch (error) {
            throw new StructuredOutputError(
                `Invalid structured output from model ${this.modelName}: ${String(error)}`
            );
        }
        return new StructuredResponse({
            id: completed.id,
            createdAt: completed.createdAt,
            content,
            usage: completed.usage,
            finishedReason: completed.finishedReason,
        });
    }
}

type JSONSerializable =
    | string
    | number
    | boolean
    | null
    | JSONSerializable[]
    | {
          [key: string]: JSONSerializable;
      };

function normalizeToolChoice(value: LegacyToolChoice | ToolChoice | undefined): ToolChoice | null {
    if (value === undefined) return null;
    return value instanceof ToolChoice ? value : new ToolChoice({ mode: value });
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<ChatResponse, ChatResponse> {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'next') === 'function'
    );
}

function isCancellationError(error: unknown): boolean {
    return (
        (error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'CancelledError')) ||
        (typeof DOMException !== 'undefined' &&
            error instanceof DOMException &&
            error.name === 'AbortError')
    );
}

function collectBlockTokens(block: ContentBlock, texts: string[], data: DataBlock[]): void {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'thinking') texts.push(block.thinking);
    else if (block.type === 'tool_call') texts.push(block.input);
    else if (block.type === 'data') data.push(block);
    else if (block.type === 'hint') {
        if (typeof block.hint === 'string') texts.push(block.hint);
        else for (const item of block.hint) collectBlockTokens(item, texts, data);
    } else if (block.type === 'tool_result') {
        if (typeof block.output === 'string') texts.push(block.output);
        else for (const item of block.output) collectBlockTokens(item, texts, data);
    }
}

async function consumeStream(
    stream: AsyncGenerator<ChatResponse, ChatResponse>
): Promise<ChatResponse> {
    const accumulator = new StreamAccumulator();
    while (true) {
        const result = await stream.next();
        if (result.done)
            return result.value ? ChatResponse.from(result.value) : accumulator.build();
        const chunk = ChatResponse.from(result.value);
        if (chunk.isLast) return chunk;
        accumulator.appendChatResponse(chunk);
        accumulator.id = chunk.id;
    }
}

function isZodSchema(value: z.ZodObject | JSONSchema): value is z.ZodObject {
    return value instanceof z.ZodObject;
}

function mergeNestedOptions(
    base: Record<string, unknown>,
    overlay: Record<string, unknown>
): Record<string, unknown> {
    const result = { ...base, ...overlay };
    for (const [key, value] of Object.entries(overlay)) {
        if (isRecord(value) && isRecord(base[key])) result[key] = { ...base[key], ...value };
    }
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
