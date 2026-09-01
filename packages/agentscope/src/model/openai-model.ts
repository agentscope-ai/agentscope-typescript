import { OpenAI } from 'openai';
import {
    ChatCompletionMessageParam,
    ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';

import { OpenAIChatFormatter } from '../formatter/openai-chat-formatter';
import type { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message/block';
import type { ToolChoice, ToolSchema } from '../type';
import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { ChatUsage } from './usage';

interface OpenAIChatModelOptions extends ChatModelOptions {
    apiKey: string;
    presetGenParams?: Record<string, unknown>;
    baseURL?: string;
}

/**
 * The OpenAI API chat model.
 */
export class OpenAIChatModel extends ChatModelBase {
    protected client: OpenAI;
    protected presetGenParams: Record<string, unknown> | undefined;

    /**
     * Initializes a new instance of the OpenAIChatModel class.
     * @param options
     * @param options.modelName
     * @param options.apiKey
     * @param options.stream
     * @param options.maxRetries
     * @param options.fallbackModelName
     * @param options.presetGenParams
     * @param options.baseURL
     * @param options.formatter
     */
    constructor({
        modelName,
        apiKey,
        stream = true,
        maxRetries = 3,
        fallbackModelName,
        presetGenParams,
        baseURL,
        formatter,
    }: OpenAIChatModelOptions) {
        // If no formatter is provided, create a default OpenAIChatFormatter
        const defaultFormatter = formatter || new OpenAIChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL,
        });
        this.presetGenParams = presetGenParams;
    }

    /**
     * Calls the OpenAI API with the given parameters.
     *
     * @param modelName - The name of the model to use.
     * @param options - The chat model options.
     * @returns A promise that resolves to either a ChatResponse or an AsyncGenerator of ChatResponses.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<ChatCompletionMessageParam>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startTime = Date.now();

        if (this.stream) {
            // Handle streaming response
            const stream = await this.client.chat.completions.create({
                model: modelName,
                messages: options.messages,
                tools: this._formatToolSchemas(options.tools),
                tool_choice: this._formatToolChoice(options.toolChoice),
                stream: true,
                ...(this.presetGenParams ?? {}),
            });

            return this._parseOpenAIStreamedResponse(stream, startTime);
        }

        // Handle non-streaming response
        const response = await this.client.chat.completions.create({
            model: modelName,
            messages: options.messages,
            tools: options.tools,
            tool_choice: this._formatToolChoice(options.toolChoice),
            stream: false,
            ...(this.presetGenParams ?? {}),
        });

        const choice = response.choices[0];
        const blocks: (TextBlock | ToolCallBlock | ThinkingBlock | DataBlock)[] = [];

        // handling text block
        if (choice.message.content) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'text',
                text: choice.message.content,
                created_at: new Date().toISOString(),
            });
        }

        // handling tool calls
        if (choice.message.tool_calls && Array.isArray(choice.message.tool_calls)) {
            choice.message.tool_calls.forEach(toolCall => {
                if (toolCall.type === 'function') {
                    blocks.push({
                        type: 'tool_call',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: toolCall.function.arguments,
                        state: 'pending',
                        created_at: new Date().toISOString(),
                    });
                }
            });
        }

        // handling usage
        const usage = response.usage
            ? {
                  type: 'chat_usage',
                  inputTokens: response.usage.prompt_tokens,
                  outputTokens: response.usage.completion_tokens,
                  time: (Date.now() - startTime) / 1000,
              }
            : undefined;

        return {
            type: 'chat',
            id: response.id,
            createdAt: new Date(response.created * 1000).toISOString(),
            content: blocks,
            usage,
        } as ChatResponse;
    }

    /**
     * Formats the tool choice for the API request.
     *
     * TODO: supports grouped tool choices.
     *
     * @param toolChoice - The tool choice option.
     * @returns The formatted tool choice.
     */
    _formatToolChoice(toolChoice?: ToolChoice): ChatCompletionToolChoiceOption {
        if (toolChoice) {
            // Directly return predefined options
            if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
                return toolChoice;
            }
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
     * Parses a streamed response from OpenAI API.
     * An async generator that yields delta ChatResponse objects as they are received.
     *
     * @param stream - The OpenAI stream object.
     * @param startTime - The start time of the request for usage calculation.
     * @returns An async generator yielding delta ChatResponse objects, and returns the complete ChatResponse.
     */
    async *_parseOpenAIStreamedResponse(
        stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let accText = '';
        // Store accumulated input strings for each tool call
        const accToolInputs: Map<string, string> = new Map();
        // Store tool call metadata (id, name)
        const toolCallMeta: Map<string, { id: string; name: string }> = new Map();
        let lastUsage: ChatUsage | null = null;
        let responseId = '';
        let createdTimestamp = 0;

        for await (const chunk of stream) {
            if (!responseId && chunk.id) {
                responseId = chunk.id;
            }
            if (!createdTimestamp && chunk.created) {
                createdTimestamp = chunk.created;
            }

            if (chunk.choices && chunk.choices.length > 0) {
                const choice = chunk.choices[0];

                // Delta data for this chunk
                let deltaText = '';
                const deltaToolCalls: Map<string, ToolCallBlock> = new Map();

                if (choice.delta?.content) {
                    deltaText = choice.delta.content;
                    accText += deltaText;
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
                                created_at: new Date().toISOString(),
                            });
                        }
                    });
                }

                // Create a delta ChatResponse object
                const deltaBlocks = this._accDataToBlocks(deltaText, deltaToolCalls);

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

            // Handle usage information (typically in the last chunk)
            if (chunk.usage) {
                lastUsage = {
                    type: 'chat_usage',
                    inputTokens: chunk.usage.prompt_tokens || 0,
                    outputTokens: chunk.usage.completion_tokens || 0,
                    time: (Date.now() - startTime) / 1000,
                };
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

        const blocks = this._accDataToBlocks(accText, finalToolCalls);
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
     * Convert data into blocks
     *
     * @param text - The text response from the llm API
     * @param toolCalls - The tool calls
     * @returns An array of blocks
     */
    _accDataToBlocks(
        text: string,
        toolCalls: Map<string, ToolCallBlock>
    ): (TextBlock | ToolCallBlock)[] {
        const blocks: (TextBlock | ToolCallBlock)[] = [];
        if (text) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'text',
                text: text,
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
