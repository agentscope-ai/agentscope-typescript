/* eslint-disable jsdoc/require-jsdoc */

import { MoonshotCredential } from '../credential/providers';
import { MoonshotChatFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import {
    createOpenAICompatibleHTTPClient,
    formatOpenAITools,
    OpenAICompatibleClient,
    parseOpenAICompletion,
    parseOpenAIStream,
} from './openai-compatible';
import { ChatResponse } from './response';

export interface MoonshotParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    reasoningEffort?: 'low' | 'high' | 'max' | null;
    temperature?: number | null;
    topP?: number | null;
}

export interface MoonshotChatModelOptions {
    credential: MoonshotCredential;
    model: string;
    parameters?: MoonshotParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: OpenAICompatibleClient;
    fetch?: FetchLike;
}

/** Moonshot/Kimi OpenAI-compatible chat model. */
export class MoonshotChatModel extends ChatModelBase {
    readonly type = 'moonshot_chat' as const;
    readonly moonshotParameters: MoonshotParameters;
    private readonly client: OpenAICompatibleClient;

    constructor(options: MoonshotChatModelOptions) {
        const parameters = options.parameters ?? {};
        super({
            modelName: options.model,
            credential: options.credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 131072,
            formatter: options.formatter ?? new MoonshotChatFormatter(),
        });
        this.moonshotParameters = parameters;
        this.client =
            options.client ??
            createOpenAICompatibleHTTPClient({
                apiKey: options.credential.apiKey,
                baseUrl: options.credential.baseUrl,
                fetch: options.fetch,
            });
    }

    protected isRetryableError(error: unknown): boolean {
        return (
            error instanceof TypeError ||
            (error instanceof Error &&
                ['RateLimitError', 'HTTP500Error', 'HTTP502Error', 'HTTP503Error'].includes(
                    error.name
                ))
        );
    }

    protected isStructuredOutputFallbackError(error: unknown): boolean {
        return (
            super.isStructuredOutputFallbackError(error) ||
            (error instanceof Error && error.name === 'HTTP400Error')
        );
    }

    protected getDisableThinkingOptions(): Record<string, unknown> {
        return { extra_body: { thinking: { type: 'disabled' } } };
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        const parameters = this.moonshotParameters;
        const isK3 = modelName === 'kimi-k3';
        const body: Record<string, unknown> = {
            model: modelName,
            messages,
            stream: this.stream,
        };
        if (parameters.maxTokens != null) {
            body[isK3 ? 'max_completion_tokens' : 'max_tokens'] = parameters.maxTokens;
        }
        if (parameters.temperature != null) body.temperature = parameters.temperature;
        if (parameters.topP != null) body.top_p = parameters.topP;
        Object.assign(body, callOptions);
        if (isK3) {
            if (parameters.reasoningEffort) body.reasoning_effort = parameters.reasoningEffort;
        } else {
            const extraBody = asRecord(body.extra_body);
            const thinking = asRecord(extraBody.thinking);
            if (thinking.type === undefined) {
                thinking.type = parameters.thinkingEnable ? 'enabled' : 'disabled';
            }
            extraBody.thinking = thinking;
            body.extra_body = extraBody;
        }

        const [formattedTools, formattedChoice] = formatOpenAITools(
            tools,
            normalizedToolChoice ?? null
        );
        if (formattedTools) body.tools = formattedTools;
        if (formattedChoice) body.tool_choice = formattedChoice;
        if (this.stream) body.stream_options = { include_usage: true };
        const raw = await this.client.create(body, signal as AbortSignal | undefined);
        const parserOptions = {
            cacheTokens: (usage: Record<string, unknown>) => Number(usage.cached_tokens ?? 0),
        };
        return this.stream
            ? parseOpenAIStream(
                  raw as AsyncIterable<Record<string, unknown>>,
                  startedAt,
                  parserOptions
              )
            : parseOpenAICompletion(raw, startedAt, parserOptions);
    }

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return formatOpenAITools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): ToolSchema[] {
        return tools;
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? structuredClone(value as Record<string, unknown>)
        : {};
}
