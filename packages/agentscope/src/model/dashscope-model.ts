import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import type { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message/block';
import type { ToolChoice, ToolSchema } from '../type';
import { ChatUsage } from './usage';
import { _parseStreamedResponse } from '../_utils';
import { DashScopeChatFormatter } from '../formatter/dashscope-chat-formatter';

interface _DashScopeStreamChunk {
    output?: {
        choices: {
            message?: {
                content?: string | { text: string }[];
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
        }[];
    };
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}

interface DashScopeThinkingConfig {
    /**
     * Whether to enable thinking or not.
     */
    enableThinking: boolean;

    /**
     * Maximum tokens for reasoning (optional).
     */
    thinkingBudget?: number;
}

interface DashScopeChatModelOptions extends ChatModelOptions {
    /**
     * The API key for authenticating with DashScope API.
     */
    apiKey: string;

    /**
     * Thinking configuration for DashScope models.
     */
    thinkingConfig?: DashScopeThinkingConfig;

    /**
     * (Deprecated) Use thinkingConfig instead.
     * Whether to enable the "thinking" feature in the model.
     */
    enableThinking?: boolean;

    /**
     * Whether the model is multimodal or not, this will decide the default API endpoint.
     */
    multimodal?: boolean;

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
 * The DashScope API chat model.
 */
export class DashScopeChatModel extends ChatModelBase {
    apiURL: string;
    protected apiKey: string;
    protected presetGenParams: Record<string, unknown> | undefined;
    protected presetHeaders: Record<string, unknown> | undefined;
    protected thinkingConfig?: DashScopeThinkingConfig;

    /**
     * Initializes a new instance of the DashScopeChatModel class.
     *
     * @param options - The DashScope chat model options.
     * @param options.modelName - The name of the model to use.
     * @param options.apiKey - The API key for authentication.
     * @param options.stream - Whether to use streaming responses. Default is true.
     * @param options.thinkingConfig - The thinking configuration for DashScope models, including whether to enable thinking and the thinking budget.
     * @param options.maxRetries - The maximum number of retries for failed requests. Default is 3.
     * @param options.fallbackModelName - The fallback model name to use if the primary model fails.
     * @param options.presetGenParams - Preset generation parameters to include in each request.
     * @param options.presetHeaders - Preset headers that will be included in each request.
     * @param options.multimodal - Whether the model is multimodal or not, this will decide the default API endpoint. If not provided, it will be inferred from the model name.
     * @param options.formatter - An optional custom formatter. If not provided, a default DashScopeChatFormatter will be used.
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
        multimodal,
        formatter,
    }: DashScopeChatModelOptions) {
        // If no formatter is provided, create a default DashScopeChatFormatter
        const defaultFormatter = formatter || new DashScopeChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.apiKey = apiKey;
        this.thinkingConfig = thinkingConfig;
        this.presetGenParams = presetGenParams;
        this.presetHeaders = presetHeaders;

        // Infer the apiURL based on the multimodal option or the model name
        if (multimodal === undefined) {
            // Router according to the model name
            multimodal =
                modelName.includes('vl') ||
                modelName.includes('qwen3.5-plus') ||
                modelName.includes('qvq');
        }
        this.apiURL = multimodal
            ? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
            : 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
    }

    /**
     * Calls the DashScope API with the given parameters.
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
            input: {
                messages: options.messages,
            },
            parameters: {
                result_format: 'message',
                tools: this._formatToolSchemas(options.tools),
                toolChoice: this._formatToolChoice(options.toolChoice),
                enable_thinking: this.thinkingConfig?.enableThinking ?? false,
                ...(this.thinkingConfig?.thinkingBudget !== undefined && {
                    thinking_budget: this.thinkingConfig.thinkingBudget,
                }),
                ...(this.presetGenParams ?? {}),
                incremental_output: true,
            } as Record<string, unknown>,
        };

        // Set up headers
        const headers: Record<string, unknown> = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...this.presetHeaders,
        };

        // Set up streaming header if needed
        if (this.stream) {
            headers['X-DashScope-SSE'] = 'enable';
        }

        // Counting the time cost
        const startTime = Date.now();
        const response = await fetch(this.apiURL, {
            method: 'POST',
            headers: headers as HeadersInit,
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(
                `DashScope API request failed with status ${response.status}: ${await response.text()}`
            );
        }

        if (this.stream) {
            // Handle the streaming response
            return this._parseDashScopeStreamedResponse(response, startTime);
        }

        // Handle the non-streaming response
        const blocks: Array<TextBlock | ToolCallBlock | ThinkingBlock | DataBlock> = [];
        const res = await response.json();
        const choice = res.output.choices[0];
        if (choice.message.reasoning_content) {
            blocks.push({
                type: 'thinking',
                thinking: choice.message.reasoning_content,
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
            });
        }
        if (choice.message.content) {
            blocks.push({
                type: 'text',
                text: choice.message.content,
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
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
                        created_at: new Date().toISOString(),
                    });
                }
            });
        }

        const usage = res.usage
            ? {
                  type: 'chat_usage',
                  inputTokens: res.usage.input_tokens || 0,
                  outputTokens: res.usage.output_tokens || 0,
                  time: (Date.now() - startTime) / 1000,
              }
            : undefined;

        return {
            type: 'chat',
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: blocks,
            usage,
        } as ChatResponse;
    }

    /**
     * The method to format the tool choice parameter.
     *
     * @param toolChoice - The tool choice option.
     * @returns The formatted tool choice.
     */
    _formatToolChoice(toolChoice?: ToolChoice): 'auto' | 'none' | Record<string, unknown> {
        if (toolChoice) {
            if (toolChoice === 'auto') return 'auto';
            if (toolChoice === 'none') return 'none';
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
     * Parses a streamed response from DashScope API specifically for chat responses.
     * An async generator that yields delta ChatResponse objects as they are received.
     *
     * @param response - The fetch response object.
     * @param startTime - The start time of the request for usage calculation.
     * @returns An async generator yielding delta ChatResponse objects, and returns the complete ChatResponse.
     */
    async *_parseDashScopeStreamedResponse(
        response: Response,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const asyncGenerator = _parseStreamedResponse<_DashScopeStreamChunk>(response);

        let accText: string = '';
        let accThinking: string = '';
        // Store accumulated input strings for each tool call
        const accToolInputs: Map<string, string> = new Map();
        // Store tool call metadata (id, name)
        const toolCallMeta: Map<string, { id: string; name: string }> = new Map();
        let lastUsage: ChatUsage | undefined = undefined;

        for await (const jsonObj of asyncGenerator) {
            if (jsonObj.output && jsonObj.output.choices) {
                const choice = jsonObj.output.choices[0];

                // Delta data for this chunk
                let deltaText: string = '';
                let deltaThinking: string = '';
                const deltaToolCalls: Map<string, ToolCallBlock> = new Map();

                const content = choice.message?.content;
                if (content) {
                    if (typeof content === 'string') {
                        deltaText = content;
                    } else if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block.text) {
                                deltaText += block.text;
                            }
                        }
                    }
                    accText += deltaText;
                }
                if (choice.message?.reasoning_content) {
                    deltaThinking = choice.message.reasoning_content;
                    accThinking += deltaThinking;
                }
                if (choice.message?.tool_calls) {
                    choice.message.tool_calls.forEach(toolCall => {
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
                                created_at: new Date().toISOString(),
                            });
                        }
                    });
                }

                // Create a delta ChatResponse object
                const deltaBlocks = this._dataToBlocks(deltaText, deltaThinking, deltaToolCalls);
                lastUsage = jsonObj.usage
                    ? {
                          type: 'chat_usage',
                          inputTokens: jsonObj.usage.input_tokens || 0,
                          outputTokens: jsonObj.usage.output_tokens || 0,
                          time: (Date.now() - startTime) / 1000,
                      }
                    : undefined;

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
                created_at: new Date().toISOString(),
            });
        });

        const blocks = this._dataToBlocks(accText, accThinking, finalToolCalls);
        return {
            type: 'chat',
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: blocks,
            usage: lastUsage,
        } as ChatResponse;
    }

    /**
     * Convert data into blocks
     *
     * @param text - The text response from the llm API
     * @param thinking - The thinking response
     * @param toolCalls - The tool calls
     * @returns An array of blocks
     */
    _dataToBlocks(
        text: string,
        thinking: string,
        toolCalls: Map<string, ToolCallBlock>
    ): (TextBlock | ThinkingBlock | ToolCallBlock)[] {
        const blocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];
        if (thinking) {
            blocks.push({
                type: 'thinking',
                thinking: thinking,
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
            });
        }
        if (text) {
            blocks.push({
                type: 'text',
                text: text,
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
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
     * Format the tool schemas to the expected API format.
     * @param tools
     * @returns The formatted tool schemas.
     */
    _formatToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
        return tools || [];
    }
}
