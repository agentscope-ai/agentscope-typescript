import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse } from './response';
import { GeminiChatFormatter, GeminiPart } from '../formatter/gemini-chat-formatter';
import { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message';
import { ToolChoice, ToolSchema } from '../type';

/** Options for the Gemini Developer API (not Vertex AI). */
export interface GeminiChatModelOptions extends ChatModelOptions {
    apiKey: string;
    /** REST API root, including the version, e.g. https://generativelanguage.googleapis.com/v1beta. */
    baseURL?: string;
    /** Native generationConfig defaults; per-call generationConfig takes precedence. */
    presetGenParams?: Record<string, unknown>;
    presetHeaders?: Record<string, string>;
}

interface GeminiResponse {
    responseId?: string;
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
    };
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
}

type GeminiBlock = TextBlock | ThinkingBlock | ToolCallBlock | DataBlock;

/** Gemini native REST adapter with text, thinking, data and function-call responses. */
export class GeminiChatModel extends ChatModelBase {
    private apiKey: string;
    private baseURL: string;
    private presetGenParams: Record<string, unknown>;
    private presetHeaders: Record<string, string>;

    /**
     * Initialize the model with a native Gemini formatter by default.
     * @param options
     */
    constructor(options: GeminiChatModelOptions) {
        super({ ...options, formatter: options.formatter ?? new GeminiChatFormatter() });
        this.apiKey = options.apiKey;
        this.baseURL = (
            options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta'
        ).replace(/\/$/, '');
        this.presetGenParams = options.presetGenParams ?? {};
        this.presetHeaders = options.presetHeaders ?? {};
    }

    /**
     * Send a generateContent or streamGenerateContent request.
     * @param modelName
     * @param options
     * @returns The formatted or accumulated result.
     */
    async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<Record<string, unknown>>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        const system = options.messages.filter(m => m.role === 'system');
        const contents = options.messages.filter(m => m.role !== 'system');
        if (!contents.length) throw new Error('Gemini requires at least one non-system message');
        const names = (options.tools ?? []).map(t => t.function.name);
        if (options.toolChoice && !['auto', 'none'].includes(options.toolChoice)) {
            if (!names.length) throw new Error('Gemini tool choice requires tools');
            if (options.toolChoice !== 'required' && !names.includes(options.toolChoice)) {
                throw new Error(`Unknown Gemini tool choice: ${options.toolChoice}`);
            }
        }
        const body = {
            contents,
            ...(system.length
                ? { systemInstruction: { parts: system.flatMap(m => m.parts as GeminiPart[]) } }
                : {}),
            ...(names.length
                ? {
                      tools: this._formatToolSchemas(options.tools),
                      toolConfig: this._formatToolChoice(options.toolChoice),
                  }
                : {}),
            generationConfig: {
                ...this.presetGenParams,
                ...((options.generationConfig as Record<string, unknown>) ?? {}),
            },
            ...(options.safetySettings ? { safetySettings: options.safetySettings } : {}),
        };
        const method = this.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        const model = encodeURIComponent(modelName.replace(/^models\//, ''));
        const startTime = Date.now();
        const response = await fetch(`${this.baseURL}/models/${model}:${method}`, {
            method: 'POST',
            headers: {
                ...this.presetHeaders,
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey,
            },
            body: JSON.stringify(body),
            signal: options.signal as AbortSignal | undefined,
        });
        if (!response.ok)
            throw new Error(
                `Gemini API request failed with status ${response.status}: ${await response.text()}`
            );
        if (this.stream) return this.parseStream(response, startTime);
        const raw: GeminiResponse = await response.json();
        const result = this.emptyResponse();
        this.appendResponse(result, raw, startTime);
        if (!result.content.length)
            throw new Error(
                `Gemini returned no content (${raw.promptFeedback?.blockReason ?? raw.candidates?.[0]?.finishReason ?? 'empty response'})`
            );
        return result;
    }

    /**
     * Map unified tool choice modes to Gemini functionCallingConfig.
     * @param toolChoice
     * @returns The formatted or accumulated result.
     */
    _formatToolChoice(toolChoice: ToolChoice = 'auto') {
        const mode = toolChoice === 'auto' ? 'AUTO' : toolChoice === 'none' ? 'NONE' : 'ANY';
        return {
            functionCallingConfig: {
                mode,
                ...(!['auto', 'none', 'required'].includes(toolChoice)
                    ? { allowedFunctionNames: [toolChoice] }
                    : {}),
            },
        };
    }

    /**
     * Use the REST API's JSON Schema field without dropping schema constraints.
     * @param tools
     * @returns The formatted or accumulated result.
     */
    _formatToolSchemas(tools: ToolSchema[] = []): Record<string, unknown>[] {
        if (!tools.length) return [];
        return [
            {
                functionDeclarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parametersJsonSchema: t.function.parameters,
                })),
            },
        ];
    }

    /** Create a response whose identity remains stable across streaming deltas.
     * @returns The formatted or accumulated result.
     */
    private emptyResponse(): ChatResponse {
        return {
            type: 'chat',
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            content: [],
        };
    }

    /**
     * Append incremental native parts and retain usage-only terminal chunks.
     * @param result
     * @param raw
     * @param startTime
     * @param streaming
     * @returns The formatted or accumulated result.
     */
    private appendResponse(
        result: ChatResponse,
        raw: GeminiResponse,
        startTime: number,
        streaming = false
    ): GeminiBlock[] {
        if (raw.error) throw new Error(`Gemini API error: ${raw.error.message ?? 'unknown error'}`);
        if (raw.promptFeedback?.blockReason)
            throw new Error(`Gemini prompt blocked: ${raw.promptFeedback.blockReason}`);
        const deltas: GeminiBlock[] = [];
        for (const [index, part] of (raw.candidates?.[0]?.content?.parts ?? []).entries()) {
            const common = {
                id: crypto.randomUUID(),
                created_at: result.createdAt,
                ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
            };
            let block: GeminiBlock;
            if (part.functionCall) {
                block = {
                    ...common,
                    type: 'tool_call',
                    id: part.functionCall.id ?? common.id,
                    name: part.functionCall.name,
                    input: JSON.stringify(part.functionCall.args ?? {}),
                    state: 'pending',
                };
            } else if (part.inlineData) {
                block = {
                    ...common,
                    type: 'data',
                    source: {
                        type: 'base64',
                        data: part.inlineData.data,
                        media_type: part.inlineData.mimeType,
                    },
                };
            } else if (part.text !== undefined) {
                block = part.thought
                    ? { ...common, type: 'thinking', thinking: part.text }
                    : { ...common, type: 'text', text: part.text };
                const last = result.content.at(-1);
                // Merge deltas of an unfinished text part; a signature closes that part.
                if (
                    streaming &&
                    index === 0 &&
                    last?.type === block.type &&
                    !('thought_signature' in last)
                ) {
                    block.id = last.id;
                    if (part.thoughtSignature)
                        Object.assign(last, { thought_signature: part.thoughtSignature });
                    if (last.type === 'text' && block.type === 'text') last.text += block.text;
                    if (last.type === 'thinking' && block.type === 'thinking')
                        last.thinking += block.thinking;
                    deltas.push(block);
                    continue;
                }
            } else if (part.thoughtSignature) {
                // Providers can finish a text part with a signature-only chunk.
                const last = result.content.at(-1);
                if (last) {
                    Object.assign(last, { thought_signature: part.thoughtSignature });
                    continue;
                }
                block = { ...common, type: 'text', text: '' };
            } else continue;
            result.content.push({ ...block });
            deltas.push(block);
        }
        if (raw.usageMetadata) {
            result.usage = {
                type: 'chat_usage',
                inputTokens: raw.usageMetadata.promptTokenCount ?? 0,
                outputTokens:
                    (raw.usageMetadata.candidatesTokenCount ?? 0) +
                    (raw.usageMetadata.thoughtsTokenCount ?? 0),
                time: (Date.now() - startTime) / 1000,
            };
        }
        return deltas;
    }

    /**
     * Parse SSE frames across arbitrary network boundaries and cancel on early return.
     * @param response
     * @param startTime
     * @returns The formatted or accumulated result.
     */
    private async *parseStream(
        response: Response,
        startTime: number
    ): AsyncGenerator<ChatResponse, ChatResponse> {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Gemini streaming response has no body');
        const decoder = new TextDecoder();
        const result = this.emptyResponse();
        let buffer = '';
        let ended = false;
        const parseFrame = (frame: string) => {
            const data = frame
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart())
                .join('\n');
            if (!data || data === '[DONE]') return null;
            const raw: GeminiResponse = JSON.parse(data);
            const content = this.appendResponse(result, raw, startTime, true);
            return { ...result, content, ...(result.usage ? { usage: { ...result.usage } } : {}) };
        };
        try {
            while (true) {
                const { value, done } = await reader.read();
                buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                let boundary: RegExpExecArray | null;
                while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                    const chunk = parseFrame(buffer.slice(0, boundary.index));
                    buffer = buffer.slice(boundary.index + boundary[0].length);
                    if (chunk) yield chunk;
                }
                if (done) {
                    ended = true;
                    break;
                }
            }
            if (buffer.trim()) {
                const chunk = parseFrame(buffer);
                if (chunk) yield chunk;
            }
            if (!result.content.length) throw new Error('Gemini returned no content in stream');
            return result;
        } finally {
            try {
                if (!ended) await reader.cancel();
            } finally {
                reader.releaseLock();
            }
        }
    }
}
