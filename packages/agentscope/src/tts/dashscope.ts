/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import {
    audioResponse,
    concatBytes,
    pcmWavResponse,
    streamingWavDelta,
    TTS_WAV_MEDIA_TYPE,
} from './audio';
import { TTSModelBase, TTSResponse, TTSUsage } from './base';
import { DASHSCOPE_TTS_PARAMETER_SCHEMA } from './schemas';
import type { TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import type { FetchLike } from '../model/http-transport';
import { postSSE } from '../model/http-transport';

export interface DashScopeTTSParameters extends Record<string, unknown> {
    voice: string;
}

export interface DashScopeTTSChunk {
    output?: { audio?: { data?: string | null } | null } | null;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        input_tokens?: number;
        output_tokens?: number;
    } | null;
}

export interface DashScopeTTSClient {
    synthesize(
        body: Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<AsyncIterable<DashScopeTTSChunk> | Iterable<DashScopeTTSChunk>>;
}

export interface DashScopeTTSModelOptions {
    credential: DashScopeCredential;
    model?: string;
    parameters?: Partial<DashScopeTTSParameters>;
    stream?: boolean;
    client?: DashScopeTTSClient;
    fetch?: FetchLike;
}

/** DashScope MultiModalConversation text-to-speech model. */
export class DashScopeTTSModel extends TTSModelBase<DashScopeTTSParameters> {
    readonly type = 'dashscope_tts' as const;
    private readonly client: DashScopeTTSClient;

    constructor(options: DashScopeTTSModelOptions) {
        super({
            credential: options.credential,
            model: options.model ?? 'qwen3-tts-flash',
            parameters: { voice: options.parameters?.voice ?? 'Cherry' },
            stream: options.stream,
        });
        this.client = options.client ?? createDashScopeTTSClient(options.credential, options.fetch);
    }

    static listModels(): TTSModelCard[] {
        const cards = listModelCards({
            kind: 'tts',
            provider: 'dashscope',
            parameterSchema: DASHSCOPE_TTS_PARAMETER_SCHEMA,
        }) as TTSModelCard[];
        return cards.filter(card => !card.realtime && !card.name.startsWith('cosyvoice-'));
    }

    async synthesize(
        text?: string | null,
        options: Record<string, unknown> = {}
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        if (!text) return new TTSResponse({ content: null });
        const { signal, ...requestOptions } = options;
        const response = await this.client.synthesize(
            {
                model: this.model,
                text,
                voice: this.parameters.voice,
                stream: true,
                ...requestOptions,
            },
            signal as AbortSignal | undefined
        );
        return this.stream ? parseDashScopeStream(response) : aggregateDashScope(response);
    }
}

async function aggregateDashScope(
    response: AsyncIterable<DashScopeTTSChunk> | Iterable<DashScopeTTSChunk>
): Promise<TTSResponse> {
    const startedAt = Date.now();
    const chunks: Uint8Array[] = [];
    let usage: DashScopeTTSChunk['usage'] = null;
    for await (const chunk of response) {
        if (chunk.usage) usage = chunk.usage;
        const audio = decodeAudio(chunk);
        if (audio) chunks.push(audio);
    }
    const result = pcmWavResponse(concatBytes(chunks));
    result.usage = parseUsage(usage, elapsedSeconds(startedAt));
    return result;
}

async function* parseDashScopeStream(
    response: AsyncIterable<DashScopeTTSChunk> | Iterable<DashScopeTTSChunk>
): AsyncGenerator<TTSResponse, void> {
    const startedAt = Date.now();
    let pending: TTSResponse | null = null;
    let headerSent = false;
    let usage: DashScopeTTSChunk['usage'] = null;
    for await (const chunk of response) {
        if (chunk.usage) usage = chunk.usage;
        const audio = decodeAudio(chunk);
        if (!audio || audio.byteLength === 0) continue;
        const payload = streamingWavDelta(audio, !headerSent);
        headerSent = true;
        if (pending) yield pending;
        pending = audioResponse(payload, TTS_WAV_MEDIA_TYPE, false);
    }
    const parsedUsage = parseUsage(usage, elapsedSeconds(startedAt));
    if (pending) {
        pending.isLast = true;
        pending.usage = parsedUsage;
        yield pending;
    } else {
        yield new TTSResponse({ content: null, isLast: true, usage: parsedUsage });
    }
}

function decodeAudio(chunk: DashScopeTTSChunk): Uint8Array | null {
    const data = chunk.output?.audio?.data;
    return data ? Buffer.from(data, 'base64') : null;
}

function parseUsage(usage: DashScopeTTSChunk['usage'], elapsed: number): TTSUsage | null {
    if (!usage) return null;
    return new TTSUsage({
        inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
        time: elapsed,
    });
}

function createDashScopeTTSClient(
    credential: DashScopeCredential,
    fetchImplementation?: FetchLike
): DashScopeTTSClient {
    return {
        synthesize: async (body, signal) => {
            const { model, text, voice, stream: _stream, ...parameters } = body;
            return postSSE(
                'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
                {
                    model,
                    input: { text, voice },
                    parameters: { stream: true, ...parameters },
                },
                {
                    fetch: fetchImplementation,
                    signal,
                    headers: {
                        authorization: `Bearer ${credential.apiKey}`,
                        'x-dashscope-sse': 'enable',
                    },
                }
            ) as Promise<AsyncGenerator<DashScopeTTSChunk>>;
        },
    };
}

function elapsedSeconds(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
}
