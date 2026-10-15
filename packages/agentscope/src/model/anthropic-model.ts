import Anthropic from '@anthropic-ai/sdk';

import { AnthropicChatFormatter } from '../formatter';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice, ToolSchema } from '../type';
import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { ChatUsage } from './usage';

interface AnthropicChatModelOptions extends ChatModelOptions {
    /**
     * The API key used to authenticate with Anthropic.
     */
    apiKey: string;

    /**
     * The maximum number of output tokens. Defaults to 8192.
     */
    maxTokens?: number;

    /**
     * Additional generation parameters included in every request.
     */
    presetGenParams?: Record<string, unknown>;

    /**
     * Override the Anthropic API base URL.
     */
    baseURL?: string;
}

/**
 * The Anthropic Messages API chat model.
 */
export class AnthropicChatModel extends ChatModelBase {
    protected client: Anthropic;
    protected maxTokens: number;
    protected presetGenParams: Record<string, unknown> | undefined;

    /**
     * Initialize an Anthropic chat model.
     *
     * @param options
     * @param options.modelName
     * @param options.apiKey
     * @param options.stream
     * @param options.maxTokens
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
        maxTokens = 8192,
        maxRetries = 3,
        fallbackModelName,
        presetGenParams,
        baseURL,
        formatter,
    }: AnthropicChatModelOptions) {
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: formatter || new AnthropicChatFormatter(),
        });

        this.client = new Anthropic({
            apiKey,
            baseURL,
            maxRetries: 0,
        });
        this.maxTokens = maxTokens;
        this.presetGenParams = presetGenParams;
    }

    /**
     * Call the Anthropic Messages API.
     *
     * @param modelName
     * @param options
     * @returns A complete response or an async generator of streamed responses.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Anthropic.MessageParam>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const { messages, system } = this._extractSystemMessages(options.messages);
        const tools = this._formatToolSchemas(options.tools);
        const commonParams = {
            model: modelName,
            max_tokens: this.maxTokens,
            messages,
            ...(system.length > 0 && { system }),
            ...(tools.length > 0 && {
                tools,
                tool_choice: this._formatToolChoice(options.toolChoice),
            }),
            ...(this.presetGenParams ?? {}),
        };
        const startTime = Date.now();

        if (this.stream) {
            const stream = await this.client.messages.create({
                ...commonParams,
                stream: true,
            } as Anthropic.MessageCreateParamsStreaming);
            return this._parseAnthropicStreamedResponse(stream, startTime);
        }

        const response = await this.client.messages.create({
            ...commonParams,
            stream: false,
        } as Anthropic.MessageCreateParamsNonStreaming);

        return this._parseAnthropicResponse(response, startTime);
    }

    /**
     * Move system messages to Anthropic's top-level system parameter.
     *
     * @param messages
     * @returns Regular conversation messages and system text blocks.
     */
    protected _extractSystemMessages(messages: Anthropic.MessageParam[]): {
        messages: Anthropic.MessageParam[];
        system: Anthropic.TextBlockParam[];
    } {
        const regularMessages: Anthropic.MessageParam[] = [];
        const system: Anthropic.TextBlockParam[] = [];

        for (const message of messages) {
            if (message.role !== 'system') {
                regularMessages.push(message);
                continue;
            }

            if (typeof message.content === 'string') {
                system.push({
                    type: 'text',
                    text: message.content,
                });
                continue;
            }

            for (const block of message.content) {
                if (block.type === 'text') {
                    system.push({
                        type: 'text',
                        text: block.text,
                    });
                }
            }
        }

        return {
            messages: regularMessages,
            system,
        };
    }

    /**
     * Convert an Anthropic response into an AgentScope response.
     *
     * @param response
     * @param startTime
     * @returns The converted chat response.
     */
    protected _parseAnthropicResponse(
        response: Anthropic.Message,
        startTime: number
    ): ChatResponse {
        const blocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];

        for (const block of response.content) {
            if (block.type === 'text') {
                blocks.push({
                    type: 'text',
                    id: crypto.randomUUID(),
                    text: block.text,
                    created_at: new Date().toISOString(),
                });
            } else if (block.type === 'thinking') {
                blocks.push({
                    type: 'thinking',
                    id: crypto.randomUUID(),
                    thinking: block.thinking,
                    created_at: new Date().toISOString(),
                });
            } else if (block.type === 'tool_use') {
                blocks.push({
                    type: 'tool_call',
                    id: block.id,
                    name: block.name,
                    input: JSON.stringify(block.input),
                    state: 'pending',
                    created_at: new Date().toISOString(),
                });
            }
        }

        return {
            type: 'chat',
            id: response.id,
            createdAt: new Date().toISOString(),
            content: blocks,
            usage: {
                type: 'chat_usage',
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                time: (Date.now() - startTime) / 1000,
            },
        };
    }

    /**
     * Parse raw Anthropic streaming events.
     *
     * @param stream
     * @param startTime
     * @returns A generator yielding response deltas and returning the complete response.
     */
    protected async *_parseAnthropicStreamedResponse(
        stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let responseId = '';
        let accText = '';
        let accThinking = '';
        let inputTokens = 0;
        let outputTokens = 0;
        let lastUsage: ChatUsage | undefined;
        const toolCallMeta = new Map<number, { id: string; name: string }>();
        const toolInputs = new Map<number, string>();

        for await (const event of stream) {
            const deltaBlocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];

            if (event.type === 'message_start') {
                responseId = event.message.id;
                inputTokens = event.message.usage.input_tokens;
                outputTokens = event.message.usage.output_tokens;
            } else if (
                event.type === 'content_block_start' &&
                event.content_block.type === 'tool_use'
            ) {
                toolCallMeta.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                });
                toolInputs.set(event.index, '');
            } else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                    accText += event.delta.text;
                    deltaBlocks.push({
                        type: 'text',
                        id: crypto.randomUUID(),
                        text: event.delta.text,
                        created_at: new Date().toISOString(),
                    });
                } else if (event.delta.type === 'thinking_delta') {
                    accThinking += event.delta.thinking;
                    deltaBlocks.push({
                        type: 'thinking',
                        id: crypto.randomUUID(),
                        thinking: event.delta.thinking,
                        created_at: new Date().toISOString(),
                    });
                } else if (event.delta.type === 'input_json_delta') {
                    const meta = toolCallMeta.get(event.index);
                    if (meta) {
                        const input =
                            (toolInputs.get(event.index) || '') + event.delta.partial_json;
                        toolInputs.set(event.index, input);
                        deltaBlocks.push({
                            type: 'tool_call',
                            id: meta.id,
                            name: meta.name,
                            input: event.delta.partial_json,
                            state: 'pending',
                            created_at: new Date().toISOString(),
                        });
                    }
                }
            } else if (event.type === 'message_delta') {
                outputTokens = event.usage.output_tokens;
                lastUsage = this._createUsage(inputTokens, outputTokens, startTime);
            }

            if (deltaBlocks.length > 0 || event.type === 'message_delta') {
                yield {
                    type: 'chat',
                    id: responseId || crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    content: deltaBlocks,
                    usage: lastUsage,
                };
            }
        }

        const finalToolCalls = new Map<number, ToolCallBlock>();
        for (const [index, meta] of toolCallMeta) {
            finalToolCalls.set(index, {
                type: 'tool_call',
                id: meta.id,
                name: meta.name,
                input: toolInputs.get(index) || '{}',
                state: 'pending',
                created_at: new Date().toISOString(),
            });
        }

        return {
            type: 'chat',
            id: responseId || crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: this._dataToBlocks(accText, accThinking, finalToolCalls),
            usage: lastUsage || this._createUsage(inputTokens, outputTokens, startTime),
        };
    }

    /**
     * Build a usage object.
     *
     * @param inputTokens
     * @param outputTokens
     * @param startTime
     * @returns Chat usage.
     */
    protected _createUsage(
        inputTokens: number,
        outputTokens: number,
        startTime: number
    ): ChatUsage {
        return {
            type: 'chat_usage',
            inputTokens,
            outputTokens,
            time: (Date.now() - startTime) / 1000,
        };
    }

    /**
     * Build final content blocks from accumulated stream data.
     *
     * @param text
     * @param thinking
     * @param toolCalls
     * @returns Accumulated content blocks.
     */
    protected _dataToBlocks(
        text: string,
        thinking: string,
        toolCalls: Map<number, ToolCallBlock>
    ): (TextBlock | ThinkingBlock | ToolCallBlock)[] {
        const blocks: (TextBlock | ThinkingBlock | ToolCallBlock)[] = [];

        if (thinking) {
            blocks.push({
                type: 'thinking',
                id: crypto.randomUUID(),
                thinking,
                created_at: new Date().toISOString(),
            });
        }
        if (text) {
            blocks.push({
                type: 'text',
                id: crypto.randomUUID(),
                text,
                created_at: new Date().toISOString(),
            });
        }
        for (const toolCall of toolCalls.values()) {
            blocks.push(toolCall);
        }

        return blocks;
    }

    /**
     * Format AgentScope tool choice for Anthropic.
     *
     * @param toolChoice
     * @returns Anthropic tool choice.
     */
    _formatToolChoice(toolChoice?: ToolChoice): Anthropic.ToolChoice {
        if (!toolChoice || toolChoice === 'auto') {
            return { type: 'auto' };
        }
        if (toolChoice === 'none') {
            return { type: 'none' };
        }
        if (toolChoice === 'required') {
            return { type: 'any' };
        }
        return {
            type: 'tool',
            name: toolChoice,
        };
    }

    /**
     * Format AgentScope tool schemas for Anthropic.
     *
     * @param tools
     * @returns Anthropic tool definitions.
     */
    _formatToolSchemas(tools?: ToolSchema[]): Anthropic.Tool[] {
        return (tools || []).map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
        }));
    }
}
