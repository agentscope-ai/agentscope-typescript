import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice, ToolSchema } from '../type';
import { ChatUsage } from './usage';
import { _parseStreamedResponse } from '../_utils';
import { OpenAIChatFormatter } from '../formatter';

interface _KimiStreamChunk {
    choices?: {
        delta?: {
            content?: string;
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
 * Wire protocol supported by Kimi Code API.
 * - `openai`: OpenAI-compatible `chat/completions` endpoint (default).
 * - `anthropic`: Anthropic-compatible `messages` endpoint.
 */
export type KimiProtocol = 'openai' | 'anthropic';

interface KimiChatModelOptions extends ChatModelOptions {
    /**
     * The API key for authenticating with Kimi API.
     */
    apiKey: string;

    /**
     * The wire protocol to use when talking to the Kimi Code API.
     * Kimi Code is compatible with both OpenAI and Anthropic protocols.
     * Defaults to `'openai'`.
     */
    protocol?: KimiProtocol;

    /**
     * Base URL of the Kimi Code API.
     * - For OpenAI-compatible protocol, defaults to `https://api.kimi.com/coding/v1`.
     * - For Anthropic-compatible protocol, defaults to `https://api.kimi.com/coding`.
     *
     * Ignored when `apiURL` is explicitly provided.
     */
    baseURL?: string;

    /**
     * Full endpoint URL. When provided, this overrides `baseURL` and the
     * default endpoint suffix inferred from the selected protocol.
     *
     * OpenAI example: `https://api.kimi.com/coding/v1/chat/completions`
     * Anthropic example: `https://api.kimi.com/coding/v1/messages`
     */
    apiURL?: string;

    /**
     * Preset generation parameters merged into every request body.
     */
    presetGenParams?: Record<string, unknown>;

    /**
     * Preset headers merged into every request.
     */
    presetHeaders?: Record<string, unknown>;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding';

/**
 * The Kimi Code API chat model.
 *
 * Kimi Code exposes an API that is compatible with both the OpenAI Chat
 * Completions protocol and the Anthropic Messages protocol. This class
 * currently implements the OpenAI-compatible wire format, which is the
 * recommended path. When `protocol` is set to `'anthropic'`, the default
 * endpoint is switched accordingly but callers must ensure the request
 * shape is honored by the target service.
 */
export class KimiChatModel extends ChatModelBase {
    apiURL: string;
    protocol: KimiProtocol;
    protected apiKey: string;
    protected presetGenParams: Record<string, unknown> | undefined;
    protected presetHeaders: Record<string, unknown> | undefined;

    /**
     * Initializes a new instance of the KimiChatModel class.
     *
     * @param options - The Kimi chat model options.
     * @param options.modelName - The name of the Kimi model to use, e.g. `kimi-k2-turbo-preview`.
     * @param options.apiKey - The API key for authentication.
     * @param options.stream - Whether to use streaming responses. Default is true.
     * @param options.protocol - Wire protocol, `'openai'` (default) or `'anthropic'`.
     * @param options.baseURL - Base URL, e.g. `https://api.kimi.com/coding/v1`. Ignored if `apiURL` is provided.
     * @param options.apiURL - Full endpoint URL. Overrides `baseURL` when provided.
     * @param options.maxRetries - Maximum number of retries for failed requests. Default is 0.
     * @param options.fallbackModelName - Fallback model name to use if the primary model fails.
     * @param options.presetGenParams - Preset generation parameters merged into each request.
     * @param options.presetHeaders - Preset headers merged into each request.
     * @param options.formatter - Optional custom formatter. Defaults to OpenAIChatFormatter.
     */
    constructor({
        modelName,
        apiKey,
        stream = true,
        protocol = 'openai',
        baseURL,
        apiURL,
        maxRetries = 0,
        fallbackModelName,
        presetGenParams,
        presetHeaders,
        formatter,
    }: KimiChatModelOptions) {
        // Kimi Code is OpenAI-compatible, so reuse the OpenAI formatter by default.
        const defaultFormatter = formatter || new OpenAIChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.apiKey = apiKey;
        this.protocol = protocol;
        this.presetGenParams = presetGenParams;
        this.presetHeaders = presetHeaders;

        if (apiURL) {
            this.apiURL = apiURL;
        } else {
            const resolvedBase =
                baseURL ??
                (protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);
            const normalizedBase = resolvedBase.replace(/\/+$/, '');
            this.apiURL =
                protocol === 'anthropic'
                    ? `${normalizedBase}/v1/messages`
                    : `${normalizedBase}/chat/completions`;
        }
    }

    /**
     * Calls the Kimi API with the given parameters.
     *
     * @param modelName - The name of the model to use.
     * @param options - The chat model options.
     * @returns A promise that resolves to either a ChatResponse or an AsyncGenerator of ChatResponses.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Record<string, unknown>>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        // Build request body (OpenAI-compatible schema)
        const data = {
            model: modelName,
            messages: options.messages,
            tools: this._formatToolSchemas(options.tools),
            tool_choice: this._formatToolChoice(options.toolChoice),
            stream: this.stream,
            ...(this.presetGenParams ?? {}),
        } as Record<string, unknown>;

        // Build headers based on selected protocol
        const headers: Record<string, unknown> = {
            'Content-Type': 'application/json',
            ...(this.protocol === 'anthropic'
                ? {
                      'x-api-key': this.apiKey,
                      'anthropic-version': '2023-06-01',
                  }
                : {
                      Authorization: `Bearer ${this.apiKey}`,
                  }),
            ...this.presetHeaders,
        };

        // Counting the time cost
        const startTime = Date.now();
        const response = await fetch(this.apiURL, {
            method: 'POST',
            headers: headers as HeadersInit,
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(
                `Kimi API request failed with status ${response.status}: ${await response.text()}`
            );
        }

        if (this.stream) {
            // Handle the streaming response
            return this._parseKimiStreamedResponse(response, startTime);
        }

        // Handle the non-streaming response
        const blocks: Array<TextBlock | ToolCallBlock | ThinkingBlock | DataBlock> = [];
        const res = await response.json();
        const choice = res.choices[0];

        if (choice.message.reasoning_content) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'thinking',
                thinking: choice.message.reasoning_content,
            });
        }
        if (choice.message.content) {
            blocks.push({ id: crypto.randomUUID(), type: 'text', text: choice.message.content });
        }
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
                    const inputString = String(toolCall.function.arguments);
                    blocks.push({
                        type: 'tool_call',
                        id: String(toolCall.id),
                        name: String(toolCall.function.name),
                        input: inputString,
                        state: 'pending',
                    });
                }
            });
        }

        const usage = res.usage
            ? {
                  type: 'chat_usage',
                  inputTokens: res.usage.prompt_tokens || 0,
                  outputTokens: res.usage.completion_tokens || 0,
                  time: (Date.now() - startTime) / 1000,
              }
            : undefined;

        return {
            type: 'chat',
            id: res.id ?? crypto.randomUUID(),
            createdAt: res.created
                ? new Date(res.created * 1000).toISOString()
                : new Date().toISOString(),
            content: blocks,
            usage,
        } as ChatResponse;
    }

    /**
     * The method to format the tool choice parameter for Kimi API.
     *
     * @param toolChoice - The tool choice option.
     * @returns The formatted tool choice.
     */
    _formatToolChoice(
        toolChoice?: ToolChoice
    ): 'auto' | 'none' | 'required' | Record<string, unknown> {
        if (toolChoice) {
            if (toolChoice === 'auto') return 'auto';
            if (toolChoice === 'none') return 'none';
            if (toolChoice === 'required') return 'required';
            return {
                type: 'function',
                function: {
                    name: toolChoice,
                },
            };
        }
        return 'auto';
    }

    /**
     * Parses a streamed response from Kimi API (OpenAI-compatible SSE).
     * An async generator that yields delta ChatResponse objects as they are received.
     *
     * @param response - The fetch response object.
     * @param startTime - The start time of the request for usage calculation.
     * @returns An async generator yielding delta ChatResponse objects, and returns the complete ChatResponse.
     */
    async *_parseKimiStreamedResponse(
        response: Response,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const asyncGenerator = _parseStreamedResponse<_KimiStreamChunk>(response);

        let accText: string = '';
        let accThinking: string = '';
        // Store accumulated input strings for each tool call
        const accToolInputs: Map<string, string> = new Map();
        // Store tool call metadata (id, name)
        const toolCallMeta: Map<string, { id: string; name: string }> = new Map();
        let lastUsage: ChatUsage | undefined = undefined;

        for await (const jsonObj of asyncGenerator) {
            if (jsonObj.choices && jsonObj.choices.length > 0) {
                const choice = jsonObj.choices[0];

                // Delta data for this chunk
                let deltaText: string = '';
                let deltaThinking: string = '';
                const deltaToolCalls: Map<string, ToolCallBlock> = new Map();

                if (choice.delta?.content) {
                    deltaText = choice.delta.content;
                    accText += deltaText;
                }
                if (choice.delta?.reasoning_content) {
                    deltaThinking = choice.delta.reasoning_content;
                    accThinking += deltaThinking;
                }
                if (choice.delta?.tool_calls) {
                    choice.delta.tool_calls.forEach(toolCall => {
                        const index = toolCall.index.toString();

                        // Initialize metadata if not exists
                        if (!toolCallMeta.has(index)) {
                            toolCallMeta.set(index, { id: '', name: '' });
                        }
                        if (!accToolInputs.has(index)) {
                            accToolInputs.set(index, '');
                        }

                        // Update the tool call id
                        if (toolCall.id) {
                            toolCallMeta.get(index)!.id = toolCall.id;
                        }
                        // Update the tool call name
                        if (toolCall.function?.name) {
                            toolCallMeta.get(index)!.name = toolCall.function.name;
                        }
                        // Update the tool call input
                        if (toolCall.function?.arguments) {
                            const deltaArgs = toolCall.function.arguments;
                            accToolInputs.set(index, accToolInputs.get(index)! + deltaArgs);

                            // Create delta tool call with incremental input
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

                // Create a delta ChatResponse object
                const deltaBlocks = this._accDataToBlocks(deltaText, deltaThinking, deltaToolCalls);
                lastUsage = jsonObj.usage
                    ? {
                          type: 'chat_usage',
                          inputTokens: jsonObj.usage.prompt_tokens || 0,
                          outputTokens: jsonObj.usage.completion_tokens || 0,
                          time: (Date.now() - startTime) / 1000,
                      }
                    : lastUsage;

                yield {
                    type: 'chat',
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    content: deltaBlocks,
                    usage: lastUsage,
                } as ChatResponse;
            }
        }
        // Build final tool calls with complete JSON strings
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
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: blocks,
            usage: lastUsage,
        } as ChatResponse;
    }

    /**
     * Convert accumulated data into content blocks.
     *
     * @param text - The text response from the LLM API
     * @param thinking - The thinking response
     * @param toolCalls - The tool calls
     * @returns An array of blocks
     */
    _accDataToBlocks(
        text: string,
        thinking: string,
        toolCalls: Map<string, ToolCallBlock>
    ): (TextBlock | ThinkingBlock | ToolCallBlock)[] {
        const blocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];
        if (thinking) {
            blocks.push({ id: crypto.randomUUID(), type: 'thinking', thinking: thinking });
        }
        if (text) {
            blocks.push({ id: crypto.randomUUID(), type: 'text', text: text });
        }
        if (toolCalls.size > 0) {
            toolCalls.forEach(value => {
                blocks.push(value);
            });
        }

        return blocks;
    }

    /**
     * Format the tool schemas to the expected Kimi API format.
     * Kimi is OpenAI-compatible so the schemas can be passed through unchanged.
     * @param tools
     * @returns The formatted tool schemas.
     */
    _formatToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
        return tools || [];
    }
}
