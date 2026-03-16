import { z } from 'zod';

import { ChatResponse, StructuredResponse } from './response';
import { FormatterBase } from '../formatter';
import { getTextContent, Msg } from '../message';
import { ToolChoice, ToolInputSchema, ToolSchema } from '../type';

export interface ChatModelOptions {
    modelName: string;
    stream?: boolean;
    maxRetries?: number;
    fallbackModelName?: string;
    formatter?: FormatterBase;
}

// The chat model call options interface
export interface ChatModelCallOptions {
    messages: Msg[];
    tools?: ToolSchema[];
    toolChoice?: ToolChoice;

    // The additional options can be added as needed
    [key: string]: unknown;
}

export interface ChatModelCallStructuredOptions {
    messages: Msg[];
    schema: z.ZodObject;
}

// Internal API request options after formatting
export interface ChatModelRequestOptions<T> {
    messages: T[];
    tools?: ToolSchema[];
    toolChoice?: ToolChoice;

    // The additional options can be added as needed
    [key: string]: unknown;
}

/**
 * The base class for chat models.
 */
export abstract class ChatModelBase {
    public modelName: string;
    public stream: boolean;
    public maxRetries: number;
    public fallbackModelName?: string;
    public formatter?: FormatterBase;
    /**
     * Initializes a new instance of the ChatModelBase class.
     *
     * @param options - The chat model options, including model name, streaming option, max retries, fallback
     *  model name, and formatter.
     *
     * @param options.modelName
     * @param options.stream
     * @param options.maxRetries
     * @param options.fallbackModelName
     * @param options.formatter
     */
    protected constructor({
        modelName,
        stream,
        maxRetries,
        fallbackModelName,
        formatter,
    }: ChatModelOptions) {
        this.modelName = modelName;
        this.stream = stream ?? true;
        this.maxRetries = maxRetries ?? 0;
        this.fallbackModelName = fallbackModelName;
        this.formatter = formatter;
    }

    /**
     * Calls the chat model with the given messages.
     * This is the main method to interact with the model.
     *
     * @param options - The chat model call options.
     * @returns A promise that resolves to the model's response.
     */
    async call(
        options: ChatModelCallOptions
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse>> {
        // Format messages using the formatter if available
        let formattedMessages: unknown[];
        if (this.formatter) {
            formattedMessages = await this.formatter.format({ msgs: options.messages });
        } else {
            // If no formatter is provided, pass messages as-is
            formattedMessages = options.messages as unknown[];
        }

        const requestOptions: ChatModelRequestOptions<unknown> = {
            ...options,
            messages: formattedMessages,
        };

        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await this._callAPI(this.modelName, requestOptions);
            } catch (error) {
                lastError = error;
                if (attempt === this.maxRetries) {
                    throw error;
                } else {
                    console.log(
                        `Attempt ${attempt + 1} failed for model ${this.modelName}. Retrying...`
                    );
                }
            }
        }

        // Use the fallback model if specified
        if (this.fallbackModelName) {
            console.log(
                `Using fallback model ${this.fallbackModelName} after ${this.maxRetries} failed attempts.`
            );
            return await this._callAPI(this.fallbackModelName, requestOptions);
        }

        // This line should never be reached, but it ensures TypeScript knows the function always returns
        throw lastError;
    }

    /**
     * Abstract method to call the underlying API with the given parameters.
     */
    protected abstract _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse>>;

    /**
     * Format the AgentScope tool choice parameter to the expected API format.
     *
     * @param toolChoice - The tool choice option.
     * @returns The formatted tool choice.
     */
    abstract _formatToolChoice(toolChoice: ToolChoice): unknown;

    /**
     * A heuristic method to count the number of the tokens
     * Note the multimodal content is ignored in the token counting
     * @param options
     * @param options.messages
     * @param options.tools
     * @returns The estimated number of tokens in the input messages and tools.
     */
    async countTokens(options: { messages: Msg[]; tools?: ToolSchema[] }): Promise<number> {
        let accText: string = '';
        for (const msg of options.messages) {
            accText += getTextContent(msg) || '';
        }
        if (options.tools) {
            accText += JSON.stringify(options.tools);
        }
        const chineseMatches =
            accText.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu)?.length ?? 0;
        const englishMatches = accText.match(/[a-zA-Z]+/g)?.length ?? 0;

        return chineseMatches * 2 + englishMatches * 1.5;
    }

    /**
     * Format the tool schemas to the expected API format.
     * @param tools
     * @returns The formatted tool schemas.
     */
    abstract _formatToolSchemas(tools: ToolSchema[]): unknown[];

    /**
     * A default implementation of the structured call method. For those supporting structured output, the model should
     * override this method.
     * @param options
     * @returns The structured response from the model, which should conform to the provided Zod schema.
     */
    async callStructured(options: ChatModelCallStructuredOptions): Promise<StructuredResponse> {
        // Prepare a tool schema that wraps the provided Zod schema
        const toolSchema: ToolSchema = {
            type: 'function',
            function: {
                name: 'GenerateStructuredResponse',
                description: 'Generate required structured response by this toll.',
                parameters: options.schema.toJSONSchema({
                    target: 'openapi-3.0',
                }) as ToolInputSchema,
            },
        };

        const res = await this.call({
            messages: options.messages,
            tools: [toolSchema],
            toolChoice: 'GenerateStructuredResponse',
        });

        let completedResponse: ChatResponse;
        if (this.stream) {
            while (true) {
                const { value, done } = await (res as AsyncGenerator<ChatResponse>).next();
                if (done) {
                    completedResponse = value;
                    break;
                }
            }
        } else {
            completedResponse = res as ChatResponse;
        }

        // Find the tool call
        for (const block of completedResponse.content) {
            if (block.type === 'tool_call' && block.name === 'GenerateStructuredResponse') {
                const structuredContent = JSON.parse(block.input);
                return {
                    ...completedResponse,
                    content: structuredContent,
                    type: 'structured',
                } as StructuredResponse;
            }
        }

        throw new Error(`Failed to generate the structured response`);
    }
}
