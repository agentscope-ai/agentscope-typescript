import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice, ToolSchema } from '../type';
import { ChatUsage } from './usage';
import { _parseStreamedResponse } from '../_utils';
import { OpenAIChatFormatter } from '../formatter';

/**
 * The shape of a single SSE chunk returned by the xAI Grok streaming API.
 * The API is OpenAI-compatible, so the shape mirrors OpenAI's chat.completion.chunk format.
 */
interface _GrokStreamChunk {
    id?: string;
    created?: number;
    choices?: {
        index: number;
        delta?: {
            /** Plain-text response delta */
            content?: string;
            /** Chain-of-thought / reasoning delta (only present for grok-3-mini-* models) */
            reasoning_content?: string;
            tool_calls?: {
                index: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }[];
        };
        finish_reason?: string | null;
    }[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
    };
}

/**
 * Reasoning configuration for Grok mini models.
 * Only applicable to `grok-3-mini-*` and `grok-3-mini-fast-*` models.
 */
export type GrokReasoningEffort = 'low' | 'high';

interface GrokReasoningConfig {
    /**
     * Controls how hard the model thinks before responding.
     * - `low`: Minimal thinking, fewer tokens, faster responses.
     * - `high`: Maximum thinking, more tokens, more accurate answers.
     *
     * Only supported by `grok-3-mini-*` models; omit for `grok-3-*` or `grok-3-fast-*`.
     */
    reasoningEffort: GrokReasoningEffort;
}

export interface GrokChatModelOptions extends ChatModelOptions {
    /**
     * The API key for authenticating with the xAI API.
     */
    apiKey: string;

    /**
     * Reasoning configuration.  Providing this enables chain-of-thought output via
     * `reasoning_content` in the response.  Only supported by `grok-3-mini-*` models.
     */
    reasoningConfig?: GrokReasoningConfig;

    /**
     * Preset generation parameters merged into every request body.
     * Useful for setting `temperature`, `max_tokens`, etc.
     */
    presetGenParams?: Record<string, unknown>;

    /**
     * Preset headers merged into every request.
     */
    presetHeaders?: Record<string, unknown>;
}

/**
 * A chat model implementation for xAI's Grok API.
 *
 * The xAI API is OpenAI-compatible, so this class uses `fetch` directly
 * against `https://api.x.ai/v1/chat/completions`.
 *
 * Supported features:
 * - Streaming (SSE) and non-streaming responses
 * - Tool / function calling
 * - Chain-of-thought reasoning via `reasoning_effort` (grok-3-mini-* only)
 * - Preset generation parameters and headers
 *
 * @example
 * ```typescript
 * const model = new GrokChatModel({
 *     apiKey: process.env.XAI_API_KEY!,
 *     modelName: 'grok-3-latest',
 * });
 * const res = await model.call({ messages });
 * ```
 */
export class GrokChatModel extends ChatModelBase {
    /** The xAI chat completions endpoint. */
    apiURL: string;

    protected apiKey: string;
    protected reasoningConfig: GrokReasoningConfig | undefined;
    protected presetGenParams: Record<string, unknown> | undefined;
    protected presetHeaders: Record<string, unknown> | undefined;

    /**
     * Initializes a new instance of GrokChatModel.
     *
     * @param options - Configuration options.
     * @param options.modelName - e.g. `'grok-3-latest'`, `'grok-3-mini-latest'`.
     * @param options.apiKey - xAI API key.
     * @param options.stream - Whether to use streaming responses. Defaults to `true`.
     * @param options.maxRetries - Number of retry attempts on transient failures. Defaults to `0`.
     * @param options.fallbackModelName - Alternative model to try after exhausting retries.
     * @param options.reasoningConfig - Enables chain-of-thought for `grok-3-mini-*` models.
     * @param options.presetGenParams - Extra body parameters merged into every request.
     * @param options.presetHeaders - Extra headers merged into every request.
     * @param options.formatter - Custom message formatter. Defaults to `OpenAIChatFormatter`.
     */
    constructor({
        modelName,
        apiKey,
        stream = true,
        maxRetries = 0,
        fallbackModelName,
        reasoningConfig,
        presetGenParams,
        presetHeaders,
        formatter,
    }: GrokChatModelOptions) {
        // xAI's message format is OpenAI-compatible
        const defaultFormatter = formatter || new OpenAIChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.apiKey = apiKey;
        this.reasoningConfig = reasoningConfig;
        this.presetGenParams = presetGenParams;
        this.presetHeaders = presetHeaders;
        this.apiURL = 'https://api.x.ai/v1/chat/completions';
    }

    /**
     * Executes a chat completion request against the xAI API.
     *
     * @param modelName - The Grok model identifier.
     * @param options - Formatted request options produced by the base `call()` method.
     * @returns Either a complete `ChatResponse` (non-streaming) or an async generator
     *   that yields delta `ChatResponse` objects and returns the final complete response.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Record<string, unknown>>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        // Build the request body
        const data: Record<string, unknown> = {
            model: modelName,
            messages: options.messages,
            stream: this.stream,
            ...(this.presetGenParams ?? {}),
        };

        // Attach tool schemas when provided
        const formattedTools = this._formatToolSchemas(options.tools);
        if (formattedTools.length > 0) {
            data.tools = formattedTools;
            data.tool_choice = this._formatToolChoice(options.toolChoice);
        }

        // Attach reasoning_effort for grok-3-mini-* models only
        if (this.reasoningConfig) {
            data.reasoning_effort = this.reasoningConfig.reasoningEffort;
        }

        const headers: Record<string, unknown> = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...this.presetHeaders,
        };

        const startTime = Date.now();
        const response = await fetch(this.apiURL, {
            method: 'POST',
            headers: headers as HeadersInit,
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(
                `Grok API request failed with status ${response.status}: ${await response.text()}`
            );
        }

        if (this.stream) {
            return this._parseGrokStreamedResponse(response, startTime);
        }

        // ── Non-streaming path ──────────────────────────────────────────────────
        const blocks: Array<TextBlock | ToolCallBlock | ThinkingBlock | DataBlock> = [];
        const res = await response.json();
        const choice = res.choices[0];

        // Reasoning trace (only present for grok-3-mini-* models)
        if (choice.message.reasoning_content) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'thinking',
                thinking: choice.message.reasoning_content,
            });
        }

        // Plain-text reply
        if (choice.message.content) {
            blocks.push({ id: crypto.randomUUID(), type: 'text', text: choice.message.content });
        }

        // Tool calls
        if (choice.message.tool_calls && Array.isArray(choice.message.tool_calls)) {
            choice.message.tool_calls.forEach((toolCall: object) => {
                if (
                    'id' in toolCall &&
                    'function' in toolCall &&
                    typeof toolCall.function === 'object' &&
                    toolCall.function &&
                    'name' in toolCall.function &&
                    'arguments' in toolCall.function
                ) {
                    blocks.push({
                        type: 'tool_call',
                        id: String(toolCall.id),
                        name: String(toolCall.function.name),
                        input: String(toolCall.function.arguments),
                        state: 'pending',
                    });
                }
            });
        }

        const usage = res.usage
            ? {
                  type: 'chat_usage' as const,
                  inputTokens: res.usage.prompt_tokens || 0,
                  outputTokens: res.usage.completion_tokens || 0,
                  time: (Date.now() - startTime) / 1000,
              }
            : undefined;

        return {
            type: 'chat',
            id: res.id || crypto.randomUUID(),
            createdAt: res.created
                ? new Date(res.created * 1000).toISOString()
                : new Date().toISOString(),
            content: blocks,
            usage,
        } as ChatResponse;
    }

    /**
     * Formats the AgentScope `ToolChoice` type into the xAI API format.
     *
     * xAI accepts: `'auto'`, `'none'`, `'required'`, or a specific function descriptor.
     * Reasoning models (grok-3-mini-*) do NOT support forced tool choice; if
     * `reasoningConfig` is set and a specific function name is requested, `'auto'`
     * is used instead.
     *
     * @param toolChoice - The AgentScope tool-choice option.
     * @returns The formatted value ready to be sent to the API.
     */
    _formatToolChoice(
        toolChoice?: ToolChoice
    ): 'auto' | 'none' | 'required' | Record<string, unknown> {
        if (toolChoice) {
            if (toolChoice === 'auto') return 'auto';
            if (toolChoice === 'none') return 'none';

            // Reasoning models do not support explicit function name forcing
            if (this.reasoningConfig) {
                console.log(
                    `Grok reasoning models do not support explicit tool choice '${toolChoice}'. ` +
                        `Falling back to 'auto'.`
                );
                return 'auto';
            }

            if (toolChoice === 'required') return 'required';

            return {
                type: 'function',
                function: { name: toolChoice },
            };
        }
        return 'auto';
    }

    /**
     * Passes tool schemas through unchanged; xAI accepts the standard OpenAI
     * function-calling schema format without modification.
     *
     * @param tools - Array of tool schemas (or undefined).
     * @returns The same array, or an empty array if undefined.
     */
    _formatToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
        return tools || [];
    }

    /**
     * Parses a server-sent-event stream from the xAI API, yielding delta
     * `ChatResponse` objects as chunks arrive and returning the final
     * fully-accumulated response when the stream completes.
     *
     * @param response - The raw `fetch` Response with a readable body.
     * @param startTime - Timestamp (ms) when the request was dispatched.
     * @returns An async generator that yields deltas and returns the complete response.
     */
    async *_parseGrokStreamedResponse(
        response: Response,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const asyncGenerator = _parseStreamedResponse<_GrokStreamChunk>(response);

        let accText = '';
        let accThinking = '';
        // Accumulated JSON argument strings keyed by tool-call index
        const accToolInputs: Map<string, string> = new Map();
        // Tool-call metadata (id, name) keyed by index
        const toolCallMeta: Map<string, { id: string; name: string }> = new Map();
        let lastUsage: ChatUsage | undefined = undefined;
        let responseId = '';
        let createdTimestamp = 0;

        for await (const jsonObj of asyncGenerator) {
            if (!responseId && jsonObj.id) {
                responseId = jsonObj.id;
            }
            if (!createdTimestamp && jsonObj.created) {
                createdTimestamp = jsonObj.created;
            }

            if (jsonObj.choices && jsonObj.choices.length > 0) {
                const choice = jsonObj.choices[0];

                let deltaText = '';
                let deltaThinking = '';
                const deltaToolCalls: Map<string, ToolCallBlock> = new Map();

                // Plain-text delta
                if (choice.delta?.content) {
                    deltaText = choice.delta.content;
                    accText += deltaText;
                }

                // Reasoning / thinking delta (grok-3-mini-* only)
                if (choice.delta?.reasoning_content) {
                    deltaThinking = choice.delta.reasoning_content;
                    accThinking += deltaThinking;
                }

                // Tool-call argument deltas
                if (choice.delta?.tool_calls) {
                    choice.delta.tool_calls.forEach(toolCall => {
                        const index = toolCall.index.toString();

                        if (!toolCallMeta.has(index)) {
                            toolCallMeta.set(index, { id: '', name: '' });
                        }
                        if (!accToolInputs.has(index)) {
                            accToolInputs.set(index, '');
                        }

                        if (toolCall.id) {
                            toolCallMeta.get(index)!.id = toolCall.id;
                        }
                        if (toolCall.function?.name) {
                            toolCallMeta.get(index)!.name = toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                            const deltaArgs = toolCall.function.arguments;
                            accToolInputs.set(index, accToolInputs.get(index)! + deltaArgs);

                            const meta = toolCallMeta.get(index)!;
                            deltaToolCalls.set(index, {
                                type: 'tool_call',
                                id: meta.id,
                                name: meta.name,
                                input: deltaArgs,
                                state: 'pending',
                            });
                        }
                    });
                }

                // Capture usage (typically only present in the final chunk)
                if (jsonObj.usage) {
                    lastUsage = {
                        type: 'chat_usage',
                        inputTokens: jsonObj.usage.prompt_tokens || 0,
                        outputTokens: jsonObj.usage.completion_tokens || 0,
                        time: (Date.now() - startTime) / 1000,
                    };
                }

                const deltaBlocks = this._accDataToBlocks(deltaText, deltaThinking, deltaToolCalls);

                yield {
                    type: 'chat',
                    id: responseId || crypto.randomUUID(),
                    createdAt: createdTimestamp
                        ? new Date(createdTimestamp * 1000).toISOString()
                        : new Date().toISOString(),
                    content: deltaBlocks,
                    usage: lastUsage,
                } as ChatResponse;
            }
        }

        // Build the final complete response with fully-accumulated data
        const finalToolCalls: Map<string, ToolCallBlock> = new Map();
        toolCallMeta.forEach((meta, index) => {
            finalToolCalls.set(index, {
                type: 'tool_call',
                id: meta.id,
                name: meta.name,
                input: accToolInputs.get(index) || '{}',
                state: 'pending',
            });
        });

        const blocks = this._accDataToBlocks(accText, accThinking, finalToolCalls);
        return {
            type: 'chat',
            id: responseId || crypto.randomUUID(),
            createdAt: createdTimestamp
                ? new Date(createdTimestamp * 1000).toISOString()
                : new Date().toISOString(),
            content: blocks,
            usage: lastUsage,
        } as ChatResponse;
    }

    /**
     * Assembles an array of content blocks from accumulated text, thinking, and tool-call data.
     *
     * Order: thinking -> text -> tool_calls (mirrors DeepSeek convention).
     *
     * @param text - The accumulated (or delta) plain-text reply.
     * @param thinking - The accumulated (or delta) reasoning trace.
     * @param toolCalls - Map of tool-call blocks, keyed by their stream index.
     * @returns An ordered array of content blocks.
     */
    _accDataToBlocks(
        text: string,
        thinking: string,
        toolCalls: Map<string, ToolCallBlock>
    ): (TextBlock | ThinkingBlock | ToolCallBlock)[] {
        const blocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];

        if (thinking) {
            blocks.push({ id: crypto.randomUUID(), type: 'thinking', thinking });
        }
        if (text) {
            blocks.push({ id: crypto.randomUUID(), type: 'text', text });
        }
        toolCalls.forEach(value => {
            blocks.push(value);
        });

        return blocks;
    }
}
