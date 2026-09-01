/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential/providers';
import { DashScopeChatFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import type { FetchLike } from './http-transport';
import {
    createOpenAICompatibleHTTPClient,
    formatOpenAITools,
    nestedNumber,
    OpenAICompatibleClient,
    parseOpenAICompletion,
    parseOpenAIStream,
} from './openai-compatible';
import { ChatResponse } from './response';

export interface DashScopeParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    thinkingBudget?: number | null;
    temperature?: number | null;
    topP?: number | null;
    topK?: number | null;
    parallelToolCalls?: boolean;
    voice?: string | null;
}

export interface DashScopeChatModelOptions {
    credential?: DashScopeCredential;
    model?: string;
    parameters?: DashScopeParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: OpenAICompatibleClient;
    fetch?: FetchLike;
    modelName?: string;
    apiKey?: string;
    thinkingConfig?: { enableThinking: boolean; thinkingBudget?: number };
    presetGenParams?: Record<string, unknown>;
    presetHeaders?: Record<string, string>;
    fallbackModelName?: string;
}

/** DashScope OpenAI-compatible chat model. */
export class DashScopeChatModel extends ChatModelBase {
    readonly type = 'dashscope_chat' as const;
    readonly dashScopeParameters: DashScopeParameters;
    private readonly client: OpenAICompatibleClient;
    private readonly legacyParameters: Record<string, unknown>;

    constructor(options: DashScopeChatModelOptions) {
        const credential =
            options.credential ??
            new DashScopeCredential({ apiKey: required(options.apiKey, 'apiKey') });
        const model = options.model ?? required(options.modelName, 'model');
        const parameters = {
            thinkingEnable: false,
            parallelToolCalls: true,
            ...(options.parameters ?? {}),
            ...(options.thinkingConfig
                ? {
                      thinkingEnable: options.thinkingConfig.enableThinking,
                      thinkingBudget: options.thinkingConfig.thinkingBudget,
                  }
                : {}),
        };
        super({
            modelName: model,
            credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 131072,
            fallbackModelName: options.fallbackModelName,
            formatter: options.formatter ?? new DashScopeChatFormatter(),
        });
        this.dashScopeParameters = parameters;
        this.legacyParameters = options.presetGenParams ?? {};
        this.client =
            options.client ??
            createOpenAICompatibleHTTPClient({
                apiKey: credential.apiKey,
                baseUrl: credential.baseUrl,
                headers: options.presetHeaders,
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
        return { extra_body: { enable_thinking: false } };
    }

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        const parameters = this.dashScopeParameters;
        const body: Record<string, unknown> = {
            model: modelName,
            messages,
            stream: this.stream,
        };
        if (parameters.maxTokens != null) body.max_tokens = parameters.maxTokens;
        if (parameters.temperature != null) body.temperature = parameters.temperature;
        if (parameters.topP != null) body.top_p = parameters.topP;
        if (parameters.voice) {
            body.audio = { voice: parameters.voice, format: 'pcm16' };
            body.modalities = ['text', 'audio'];
        }
        Object.assign(body, this.legacyParameters, callOptions);
        const extraBody = asRecord(body.extra_body);
        if (extraBody.enable_thinking === undefined) {
            extraBody.enable_thinking = parameters.thinkingEnable ?? false;
        }
        if (parameters.thinkingBudget != null && extraBody.thinking_budget === undefined) {
            extraBody.thinking_budget = parameters.thinkingBudget;
        }
        if (parameters.topK != null && extraBody.top_k === undefined) {
            extraBody.top_k = parameters.topK;
        }
        body.extra_body = extraBody;

        const choice = normalizedToolChoice ?? null;
        const [formattedTools, rawChoice] = formatOpenAITools(tools, choice);
        const formattedChoice = rawChoice === 'required' ? 'auto' : rawChoice;
        if (formattedTools) {
            body.tools = formattedTools;
            if (parameters.parallelToolCalls === false) body.parallel_tool_calls = false;
        }
        if (formattedChoice) body.tool_choice = formattedChoice;
        if (this.stream) body.stream_options = { include_usage: true };
        const raw = await this.client.create(body, signal as AbortSignal | undefined);
        const parserOptions = {
            cacheTokens: (usage: Record<string, unknown>) =>
                nestedNumber(usage, 'prompt_tokens_details', 'cached_tokens'),
            includeAudio: true,
            audioFormat: String(
                (body.audio as Record<string, unknown> | undefined)?.format ?? 'wav'
            ),
        };
        return this.stream
            ? parseOpenAIStream(
                  raw as AsyncIterable<Record<string, unknown>>,
                  startedAt,
                  parserOptions
              )
            : parseOpenAICompletion(raw, startedAt, parserOptions);
    }

    _formatToolChoice(toolChoice?: LegacyToolChoice): unknown {
        if (!toolChoice) return 'auto';
        const formatted = formatOpenAITools(undefined, new ToolChoice({ mode: toolChoice }))[1];
        return formatted === 'required' ? 'auto' : formatted;
    }

    _formatToolSchemas(tools?: ToolSchema[]): ToolSchema[] {
        return tools ?? [];
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? structuredClone(value as Record<string, unknown>)
        : {};
}

function required(value: string | undefined, name: string): string {
    if (!value) throw new Error(`${name} is required.`);
    return value;
}
