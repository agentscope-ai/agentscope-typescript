import { _generateId, _generateTimestamp, _parseStreamedResponse } from '../_utils';
import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import type { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message/block';
import type { ToolChoice, ToolSchema } from '../type';
import { ChatUsage } from './usage';
import { DeepSeekChatFormatter } from '../formatter/deepseek-chat-formatter';

interface _DeepSeekStreamChunk {
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

interface DeepSeekThinkingConfig {
    /**
     * Whether to enable thinking or not.
     */
    enableThinking: boolean;
}

interface DeepSeekChatModelOptions extends ChatModelOptions {
    /**
     * The API key for authenticating with DeepSeek API.
     */
    apiKey: string;

    /**
     * Thinking configuration for DeepSeek models.
     */
    thinkingConfig?: DeepSeekThinkingConfig;

    /**
     * Preset generation parameters to include in each request.
     * These parameters will be merged with the request-specific parameters.
     */
    presetGenParams?: Record<string, unknown>;

    /**
     * Preset headers that will be included in each request.
     */
    presetHeaders?: Record<string, unknown>;
}

/**
 * The DeepSeek API chat model.
 */
export class DeepSeekChatModel extends ChatModelBase {
    apiURL: string;
    protected apiKey: string;
    protected presetGenParams: Record<string, unknown> | undefined;
    protected presetHeaders: Record<string, unknown> | undefined;
    protected thinkingConfig: DeepSeekThinkingConfig;

    /**
     * Initializes a new instance of the DeepSeekChatModel class.
     *
     * @param options - The DeepSeek chat model options.
     * @param options.modelName - The name of the model to use.
     * @param options.apiKey - The API key for authentication.
     * @param options.stream - Whether to use streaming responses. Default is true.
     * @param options.thinkingConfig - Thinking configuration.
     * @param options.maxRetries - The maximum number of retries for failed requests. Default is 0.
     * @param options.fallbackModelName - The fallback model name to use if the primary model fails.
     * @param options.presetGenParams - Preset generation parameters to include in each request.
     * @param options.presetHeaders - Preset headers that will be included in each request.
     * @param options.formatter
     */
    constructor({
        modelName,
        apiKey,
        stream = true,
        thinkingConfig,
        maxRetries = 0,
        fallbackModelName,
        presetGenParams,
        presetHeaders,
        formatter,
    }: DeepSeekChatModelOptions) {
        // If no formatter is provided, create a default DeepSeekChatFormatter
        const defaultFormatter = formatter || new DeepSeekChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.apiKey = apiKey;
        this.thinkingConfig = thinkingConfig || { enableThinking: false };
        this.presetGenParams = presetGenParams;
        this.presetHeaders = presetHeaders;
        this.apiURL = 'https://api.deepseek.com/chat/completions';
    }

    /**
     * Calls the DeepSeek API with the given parameters.
     *
     * @param modelName - The name of the model to use.
     * @param options - The chat model options.
     * @returns A promise that resolves to either a ChatResponse or an AsyncGenerator of ChatResponses.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Record<string, unknown>>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        // Set up request data
        const data = {
            model: modelName,
            messages: options.messages,
            tools: this._formatToolSchemas(options.tools),
            tool_choice: this._formatToolChoice(options.toolChoice),
            thinking: this.thinkingConfig.enableThinking
                ? { type: 'enabled' }
                : { type: 'disabled' },
            stream: this.stream,
            ...(this.presetGenParams ?? {}),
        } as Record<string, unknown>;

        // Set up headers
        const headers: Record<string, unknown> = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
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
                `DeepSeek API request failed with status ${response.status}: ${await response.text()}`
            );
        }

        if (this.stream) {
            // Handle the streaming response
            return this._parseDeepSeekStreamedResponse(response, startTime);
        }

        // Handle the non-streaming response
        const blocks: Array<TextBlock | ToolCallBlock | ThinkingBlock | DataBlock> = [];
        const res = await response.json();
        const choice = res.choices[0];

        if (choice.message.reasoning_content) {
            blocks.push({
                id: _generateId(),
                type: 'thinking',
                thinking: choice.message.reasoning_content,
                created_at: _generateTimestamp(),
            });
        }
        if (choice.message.content) {
            blocks.push({
                id: _generateId(),
                type: 'text',
                text: choice.message.content,
                created_at: _generateTimestamp(),
            });
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
                        created_at: _generateTimestamp(),
                    });
                }
            });
        }

        const usage = res.usage
            ? new ChatUsage({
                  inputTokens: res.usage.prompt_tokens || 0,
                  outputTokens: res.usage.completion_tokens || 0,
                  time: (Date.now() - startTime) / 1000,
              })
            : null;

        return new ChatResponse({
            id: _generateId(),
            createdAt: _generateTimestamp(),
            content: blocks,
            usage,
            isLast: true,
        });
    }

    /**
     * The method to format the tool choice parameter.
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
            if (this.thinkingConfig?.enableThinking) {
                console.log(
                    `The deepseek reasoning model does not support tool choice options '${toolChoice}'. 'auto' will be used instead.`
                );
                return 'auto';
            }
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
     * Parses a streamed response from DeepSeek API specifically for chat responses.
     * An async generator that yields delta ChatResponse objects as they are received.
     *
     * @param response - The fetch response object.
     * @param startTime - The start time of the request for usage calculation.
     * @returns An async generator yielding delta ChatResponse objects, and returns the complete ChatResponse.
     */
    async *_parseDeepSeekStreamedResponse(
        response: Response,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const asyncGenerator = _parseStreamedResponse<_DeepSeekStreamChunk>(response);

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

                        // Update the tool use id
                        if (toolCall.id) {
                            toolCallMeta.get(index)!.id = toolCall.id;
                        }
                        // Update the tool use name
                        if (toolCall.function?.name) {
                            toolCallMeta.get(index)!.name = toolCall.function.name;
                        }
                        // Update the tool use input
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
                                created_at: _generateTimestamp(),
                            });
                        }
                    });
                }

                // Create a delta ChatResponse object
                const deltaBlocks = this._accDataToBlocks(deltaText, deltaThinking, deltaToolCalls);
                lastUsage = jsonObj.usage
                    ? new ChatUsage({
                          inputTokens: jsonObj.usage.prompt_tokens || 0,
                          outputTokens: jsonObj.usage.completion_tokens || 0,
                          time: (Date.now() - startTime) / 1000,
                      })
                    : undefined;

                yield new ChatResponse({
                    id: _generateId(),
                    createdAt: _generateTimestamp(),
                    content: deltaBlocks,
                    usage: lastUsage ?? null,
                    isLast: false,
                });
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
                created_at: _generateTimestamp(),
            });
        });

        const blocks = this._accDataToBlocks(accText, accThinking, finalToolCalls);
        return new ChatResponse({
            id: _generateId(),
            createdAt: _generateTimestamp(),
            content: blocks,
            usage: lastUsage ?? null,
            isLast: true,
        });
    }

    /**
     * Convert data into blocks
     *
     * @param text - The text response from the llm API
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
            blocks.push({
                id: _generateId(),
                type: 'thinking',
                thinking: thinking,
                created_at: _generateTimestamp(),
            });
        }
        if (text) {
            blocks.push({
                id: _generateId(),
                type: 'text',
                text: text,
                created_at: _generateTimestamp(),
            });
        }
        // Push the tool calls into the blocks
        if (toolCalls.size > 0) {
            toolCalls.forEach(value => {
                blocks.push(value);
            });
        }

        return blocks;
    }

    /**
     * Format the tool schemas to the expected API format for DeepSeek API.
     * @param tools
     * @returns The formatted tool schemas.
     */
    _formatToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
        return tools || [];
    }
}
