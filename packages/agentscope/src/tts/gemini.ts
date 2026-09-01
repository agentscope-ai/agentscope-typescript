/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import {
    audioResponse,
    concatBytes,
    pcmWavResponse,
    streamingWavDelta,
    TTS_WAV_MEDIA_TYPE,
} from './audio';
import { TTSModelBase, TTSResponse, TTSUsage } from './base';
import { GEMINI_TTS_PARAMETER_SCHEMA, ttsModelOrder } from './schemas';
import type { TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import type { FetchLike } from '../model/http-transport';
import { postJSON, postSSE } from '../model/http-transport';

export interface GeminiTTSParameters extends Record<string, unknown> {
    voice: string;
}

export interface GeminiTTSResponsePart {
    inlineData?: { data?: string | Uint8Array | null } | null;
    inline_data?: { data?: string | Uint8Array | null } | null;
}

export interface GeminiTTSAPIResponse {
    candidates?: Array<{ content?: { parts?: GeminiTTSResponsePart[] | null } | null }> | null;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } | null;
    usage_metadata?: { prompt_token_count?: number; candidates_token_count?: number } | null;
}

export interface GeminiTTSClient {
    generateContent(request: {
        model: string;
        contents: string;
        config: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<GeminiTTSAPIResponse>;
    generateContentStream(request: {
        model: string;
        contents: string;
        config: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<AsyncIterable<GeminiTTSAPIResponse>>;
}

export interface GeminiTTSModelOptions {
    credential: GeminiCredential;
    model?: string;
    parameters?: Partial<GeminiTTSParameters>;
    stream?: boolean;
    client?: GeminiTTSClient;
    fetch?: FetchLike;
}

/** Gemini generateContent speech model. */
export class GeminiTTSModel extends TTSModelBase<GeminiTTSParameters> {
    readonly type = 'gemini_tts' as const;
    private readonly client: GeminiTTSClient;

    constructor(options: GeminiTTSModelOptions) {
        super({
            credential: options.credential,
            model: options.model ?? 'gemini-2.5-flash-preview-tts',
            parameters: { voice: options.parameters?.voice ?? 'Kore' },
            stream: options.stream ?? false,
        });
        this.client = options.client ?? createGeminiTTSClient(options.credential, options.fetch);
    }

    static listModels(): TTSModelCard[] {
        const cards = listModelCards({
            kind: 'tts',
            provider: 'gemini',
            parameterSchema: GEMINI_TTS_PARAMETER_SCHEMA,
        }) as TTSModelCard[];
        return cards.sort(
            (left, right) =>
                ttsModelOrder('gemini', left.name) - ttsModelOrder('gemini', right.name)
        );
    }

    async synthesize(
        text?: string | null,
        options: Record<string, unknown> = {}
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        if (!text) return new TTSResponse({ content: null });
        const { signal, ...configOptions } = options;
        const request = {
            model: this.model,
            contents: text,
            config: {
                response_modalities: ['AUDIO'],
                speech_config: {
                    voice_config: {
                        prebuilt_voice_config: { voice_name: this.parameters.voice },
                    },
                },
                ...configOptions,
            },
            signal: signal as AbortSignal | undefined,
        };
        const startedAt = Date.now();
        if (this.stream) {
            const stream = await this.client.generateContentStream(request);
            return parseGeminiStream(stream, startedAt);
        }
        const response = await this.client.generateContent(request);
        return parseGeminiResponse(response, elapsedSeconds(startedAt));
    }
}

export function parseGeminiResponse(response: GeminiTTSAPIResponse, elapsed: number): TTSResponse {
    const chunks = audioChunks(response);
    const usage = parseGeminiUsage(response, elapsed);
    if (chunks.length === 0) return new TTSResponse({ content: null, usage });
    const result = pcmWavResponse(concatBytes(chunks));
    result.usage = usage;
    return result;
}

async function* parseGeminiStream(
    stream: AsyncIterable<GeminiTTSAPIResponse>,
    startedAt: number
): AsyncGenerator<TTSResponse, void> {
    let pending: TTSResponse | null = null;
    let headerSent = false;
    let usageResponse: GeminiTTSAPIResponse | null = null;
    for await (const chunk of stream) {
        if (chunk.usageMetadata || chunk.usage_metadata) usageResponse = chunk;
        for (const audio of audioChunks(chunk)) {
            if (audio.byteLength === 0) continue;
            const payload = streamingWavDelta(audio, !headerSent);
            headerSent = true;
            if (pending) yield pending;
            pending = audioResponse(payload, TTS_WAV_MEDIA_TYPE, false);
        }
    }
    const usage = usageResponse ? parseGeminiUsage(usageResponse, elapsedSeconds(startedAt)) : null;
    if (pending) {
        pending.isLast = true;
        pending.usage = usage;
        yield pending;
    } else {
        yield new TTSResponse({ content: null, isLast: true, usage });
    }
}

function audioChunks(response: GeminiTTSAPIResponse): Uint8Array[] {
    const result: Uint8Array[] = [];
    for (const candidate of response.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
            const data = (part.inlineData ?? part.inline_data)?.data;
            if (!data) continue;
            result.push(
                typeof data === 'string' ? Buffer.from(data, 'base64') : new Uint8Array(data)
            );
        }
    }
    return result;
}

function parseGeminiUsage(response: GeminiTTSAPIResponse, elapsed: number): TTSUsage | null {
    const camel = response.usageMetadata;
    const snake = response.usage_metadata;
    if (!camel && !snake) return null;
    return new TTSUsage({
        inputTokens: camel?.promptTokenCount ?? snake?.prompt_token_count ?? 0,
        outputTokens: camel?.candidatesTokenCount ?? snake?.candidates_token_count ?? 0,
        time: elapsed,
    });
}

function createGeminiTTSClient(
    credential: GeminiCredential,
    fetchImplementation?: FetchLike
): GeminiTTSClient {
    const url = (model: string, stream: boolean) =>
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:${
            stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'
        }key=${encodeURIComponent(credential.apiKey)}`;
    const body = (contents: string, config: Record<string, unknown>) => ({
        contents: [{ role: 'user', parts: [{ text: contents }] }],
        generationConfig: camelize(config),
    });
    return {
        generateContent: ({ model, contents, config, signal }) =>
            postJSON<GeminiTTSAPIResponse>(url(model, false), body(contents, config), {
                fetch: fetchImplementation,
                signal,
            }),
        generateContentStream: async ({ model, contents, config, signal }) =>
            postSSE(url(model, true), body(contents, config), {
                fetch: fetchImplementation,
                signal,
            }) as Promise<AsyncGenerator<GeminiTTSAPIResponse>>,
    };
}

function camelize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(camelize);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
            key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            camelize(item),
        ])
    );
}

function elapsedSeconds(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
}
