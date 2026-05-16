import { Ollama, ChatResponse as OllamaChatResponse, AbortableAsyncIterator } from 'ollama';

import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice, ToolSchema } from '../type';
import { ChatUsage } from './usage';
import { OllamaChatFormatter } from '../formatter';

interface OllamaThinkingConfig {
    /**
     * Whether to enable thinking or not.
     */
    enableThinking: boolean;

    /**
     * Thinking level for Ollama models (high, medium, low).
     * Only applicable when enableThinking is true.
     */
    thinkingLevel?: 'high' | 'medium' | 'low';
}

interface OllamaChatModelOptions extends ChatModelOptions {
    /**
     * Additional parameters to pass to the Ollama API (e.g., temperature).
     */
    options?: Record<string, unknown>;

    /**
     * Duration to keep the model loaded in memory (e.g., "5m", "1h").
     */
    keepAlive?: string;

    /**
     * Thinking configuration for Ollama models.
     */
    thinkingConfig?: OllamaThinkingConfig;

    /**
     * The host address of the Ollama server.
     */
    host?: string;

    /**
     * Extra keyword arguments to initialize the Ollama client.
     */
    clientKwargs?: Record<string, unknown>;

    /**
     * Extra keyword arguments used in Ollama API generation.
     */
    generateKwargs?: Record<string, unknown>;
}

/**
 * The Ollama chat model class in AgentScope.
 */
export class OllamaChatModel extends ChatModelBase {
    protected client: Ollama;
    protected options?: Record<string, unknown>;
    protected keepAlive: string;
    protected thinkingConfig: OllamaThinkingConfig;
    protected generateKwargs: Record<string, unknown>;

    /**
     * Initializes a new instance of the OllamaChatModel class.
     * @param root0
     * @param root0.modelName
     * @param root0.stream
     * @param root0.options
     * @param root0.keepAlive
     * @param root0.thinkingConfig
     * @param root0.host
     * @param root0.maxRetries
     * @param root0.fallbackModelName
     * @param root0.clientKwargs
     * @param root0.generateKwargs
     * @param root0.formatter
     */
    constructor({
        modelName,
        stream = true,
        options,
        keepAlive = '5m',
        thinkingConfig,
        host,
        maxRetries = 0,
        fallbackModelName,
        clientKwargs,
        generateKwargs,
        formatter,
    }: OllamaChatModelOptions) {
        // If no formatter is provided, create a default OllamaChatFormatter
        const defaultFormatter = formatter || new OllamaChatFormatter();
        super({
            modelName,
            stream,
            maxRetries,
            fallbackModelName,
            formatter: defaultFormatter,
        } as ChatModelOptions);

        this.options = options;
        this.keepAlive = keepAlive;
        this.thinkingConfig = thinkingConfig || {
            enableThinking: false,
        };
        this.generateKwargs = generateKwargs || {};

        // Initialize Ollama client
        this.client = new Ollama({
            host: host,
            ...clientKwargs,
        });
    }

    /**
     * Calls the Ollama API with the given parameters.
     * @param modelName
     * @param options
     * @returns A promise that resolves to either a ChatResponse or an AsyncGenerator of ChatResponses.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Record<string, unknown>>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const kwargs: Record<string, unknown> = {
            model: modelName,
            messages: options.messages,
            stream: this.stream,
            options: this.options,
            keep_alive: this.keepAlive,
            ...this.generateKwargs,
        };

        if (this.thinkingConfig.enableThinking) {
            // If thinkingLevel is specified, use it; otherwise use true
            kwargs.think = this.thinkingConfig.thinkingLevel || true;
        } else {
            kwargs.think = false;
        }

        if (options.tools) {
            kwargs.tools = this._formatToolSchemas(options.tools);
        }

        if (options.toolChoice) {
            console.warn('Ollama does not support tool_choice yet, ignored.');
        }

        const startTime = Date.now();

        if (this.stream) {
            const response = (await this.client.chat({
                ...kwargs,
                stream: true,
            } as Parameters<
                typeof this.client.chat
            >[0])) as unknown as AbortableAsyncIterator<OllamaChatResponse>;
            return this._parseOllamaStreamResponse(response, startTime);
        }

        const response = (await this.client.chat({
            ...kwargs,
            stream: false,
        } as Parameters<typeof this.client.chat>[0])) as unknown as OllamaChatResponse;
        return this._parseOllamaResponse(response, startTime);
    }

    /**
     * Parse Ollama streaming response.
     * @param stream
     * @param startTime
     * @returns An async generator that yields delta ChatResponse objects and returns the complete ChatResponse.
     */
    async *_parseOllamaStreamResponse(
        stream: AbortableAsyncIterator<OllamaChatResponse>,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        let accText = '';
        let accThinking = '';
        const toolCalls: Map<string, ToolCallBlock> = new Map();
        let lastUsage: ChatUsage | null = null;

        for await (const chunk of stream) {
            const msg = chunk.message;

            // Delta data for this chunk
            let deltaText = '';
            let deltaThinking = '';
            const deltaToolCalls: Map<string, ToolCallBlock> = new Map();

            // Accumulate text and thinking
            if (msg.thinking) {
                deltaThinking = msg.thinking;
                accThinking += msg.thinking;
            }
            if (msg.content) {
                deltaText = msg.content;
                accText += msg.content;
            }

            // Handle tool calls
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (let idx = 0; idx < msg.tool_calls.length; idx++) {
                    const toolCall = msg.tool_calls[idx];
                    const func = toolCall.function;
                    const toolId = `${idx}_${func.name}`;

                    const toolCallBlock = {
                        type: 'tool_call' as const,
                        id: toolId,
                        name: func.name,
                        input: JSON.stringify(func.arguments),
                        state: 'pending' as const,
                    };

                    toolCalls.set(toolId, toolCallBlock);
                    deltaToolCalls.set(toolId, toolCallBlock);
                }
            }

            // Calculate usage
            const currentTime = (Date.now() - startTime) / 1000;
            lastUsage = {
                type: 'chat_usage',
                inputTokens: chunk.prompt_eval_count || 0,
                outputTokens: chunk.eval_count || 0,
                time: currentTime,
            };

            // Yield delta response
            const deltaBlocks = this._buildContentBlocks(deltaText, deltaThinking, deltaToolCalls);
            yield {
                type: 'chat',
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                content: deltaBlocks,
                usage: lastUsage,
            } as ChatResponse;
        }

        // Return complete response
        const blocks = this._buildContentBlocks(accText, accThinking, toolCalls);
        return {
            type: 'chat',
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: blocks,
            usage: lastUsage,
        } as ChatResponse;
    }

    /**
     * Parse Ollama non-streaming response.
     * @param response
     * @param startTime
     * @returns A ChatResponse object containing the content blocks and usage.
     */
    _parseOllamaResponse(response: OllamaChatResponse, startTime: number): ChatResponse {
        const blocks: Array<TextBlock | ThinkingBlock | ToolCallBlock> = [];

        if (response.message.thinking) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'thinking',
                thinking: response.message.thinking,
            });
        }

        if (response.message.content) {
            blocks.push({
                id: crypto.randomUUID(),
                type: 'text',
                text: response.message.content,
            });
        }

        // Handle tool calls
        if (response.message.tool_calls && Array.isArray(response.message.tool_calls)) {
            for (let idx = 0; idx < response.message.tool_calls.length; idx++) {
                const toolCall = response.message.tool_calls[idx];
                blocks.push({
                    type: 'tool_call',
                    id: `${idx}_${toolCall.function.name}`,
                    name: toolCall.function.name,
                    input: JSON.stringify(toolCall.function.arguments),
                    state: 'pending',
                });
            }
        }

        const usage =
            response.prompt_eval_count !== undefined && response.eval_count !== undefined
                ? {
                      type: 'chat_usage',
                      inputTokens: response.prompt_eval_count || 0,
                      outputTokens: response.eval_count || 0,
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
     * Build content blocks from accumulated data.
     * @param text
     * @param thinking
     * @param toolCalls
     * @returns An array of content blocks.
     */
    _buildContentBlocks(
        text: string,
        thinking: string,
        toolCalls: Map<string, ToolCallBlock>
    ): Array<TextBlock | ThinkingBlock | ToolCallBlock> {
        const blocks: Array<TextBlock | ThinkingBlock | ToolCallBlock> = [];

        if (thinking) {
            blocks.push({ id: crypto.randomUUID(), type: 'thinking', thinking });
        }

        if (text) {
            blocks.push({ id: crypto.randomUUID(), type: 'text', text });
        }

        toolCalls.forEach(toolCall => {
            blocks.push(toolCall);
        });

        return blocks;
    }

    /**
     * Format tool choice parameter (not supported by Ollama).
     * @param _toolChoice
     * @returns undefined as Ollama does not support tool choice.
     */
    _formatToolChoice(_toolChoice?: ToolChoice): unknown {
        return undefined;
    }

    /**
     * Format tool schemas for Ollama API (no special formatting needed).
     * @param tools
     * @returns The same array of tool schemas, or an empty array if undefined.
     */
    _formatToolSchemas(tools: ToolSchema[] | undefined): ToolSchema[] {
        return tools || [];
    }
}
