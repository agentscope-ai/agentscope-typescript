/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential/providers';
import { OpenAIChatFormatter } from '../formatter';
import type { FormatterBase } from '../formatter';
import { ToolChoice } from '../tool/types';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';
import { ChatModelBase } from './base';
import type { ChatModelRequestOptions } from './base';
import { flattenJSONSchema } from './gemini-model';
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

export interface OpenAIParameters extends Record<string, unknown> {
    maxTokens?: number | null;
    thinkingEnable?: boolean;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
    temperature?: number | null;
    topP?: number | null;
    parallelToolCalls?: boolean;
    voice?: string | null;
}

export interface OpenAIChatModelOptions {
    credential?: OpenAICredential;
    model?: string;
    parameters?: OpenAIParameters;
    stream?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    contextSize?: number;
    formatter?: FormatterBase;
    client?: OpenAICompatibleClient;
    fetch?: FetchLike;
    extraBody?: Record<string, unknown> | null;
    modelName?: string;
    apiKey?: string;
    presetGenParams?: Record<string, unknown>;
    baseURL?: string;
    fallbackModelName?: string;
}

/** OpenAI Chat Completions model with Python-compatible behavior. */
export class OpenAIChatModel extends ChatModelBase {
    readonly type = 'openai_chat' as const;
    readonly openAIParameters: OpenAIParameters;
    private readonly client: OpenAICompatibleClient;
    private readonly extraBody: Record<string, unknown> | null;
    private readonly legacyParameters: Record<string, unknown>;

    constructor(options: OpenAIChatModelOptions) {
        const credential =
            options.credential ??
            new OpenAICredential({
                apiKey: required(options.apiKey, 'apiKey'),
                baseUrl: options.baseURL,
            });
        const model = options.model ?? required(options.modelName, 'model');
        const parameters = options.parameters ?? {};
        super({
            modelName: model,
            credential,
            parameters,
            stream: options.stream ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 1,
            contextSize: options.contextSize ?? 128000,
            fallbackModelName: options.fallbackModelName,
            formatter: options.formatter ?? new OpenAIChatFormatter(),
        });
        this.openAIParameters = parameters;
        this.extraBody = options.extraBody ?? null;
        this.legacyParameters = options.presetGenParams ?? {};
        this.client =
            options.client ??
            createOpenAICompatibleHTTPClient({
                apiKey: credential.apiKey,
                baseUrl: credential.baseUrl ?? 'https://api.openai.com/v1',
                headers: credential.organization
                    ? { 'openai-organization': credential.organization }
                    : undefined,
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

    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const startedAt = Date.now();
        const { messages, tools, normalizedToolChoice, signal, ...callOptions } = options;
        delete callOptions.toolChoice;
        delete callOptions.schema;
        const parameters = this.openAIParameters;
        const body: Record<string, unknown> = {
            model: modelName,
            messages,
            stream: this.stream,
        };
        if (parameters.maxTokens != null) body.max_completion_tokens = parameters.maxTokens;
        if (parameters.temperature != null) body.temperature = parameters.temperature;
        if (parameters.topP != null) body.top_p = parameters.topP;
        if (parameters.thinkingEnable && parameters.reasoningEffort) {
            body.reasoning_effort = parameters.reasoningEffort;
        }
        if (parameters.voice) {
            body.audio = { voice: parameters.voice, format: 'pcm16' };
            body.modalities = ['text', 'audio'];
        }
        if (this.extraBody) body.extra_body = structuredClone(this.extraBody);
        Object.assign(body, this.legacyParameters, callOptions);

        const [formattedTools, formattedChoice] = formatOpenAITools(
            tools,
            normalizedToolChoice ?? null,
            flattenToolSchemas
        );
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

    _formatToolChoice(toolChoice: LegacyToolChoice): unknown {
        return formatOpenAITools(undefined, new ToolChoice({ mode: toolChoice }))[1];
    }

    _formatToolSchemas(tools: ToolSchema[]): ToolSchema[] {
        return flattenToolSchemas(tools);
    }
}

function flattenToolSchemas(tools: ToolSchema[]): ToolSchema[] {
    return tools.map(tool => {
        const parameters = tool.function.parameters;
        if (!parameters) return tool;
        const flattened = flattenJSONSchema(parameters) as typeof parameters;
        return flattened === parameters
            ? tool
            : { ...tool, function: { ...tool.function, parameters: flattened } };
    });
}

function required(value: string | undefined, name: string): string {
    if (!value) throw new Error(`${name} is required.`);
    return value;
}
