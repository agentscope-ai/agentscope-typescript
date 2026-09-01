/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import { audioResponse } from './audio';
import { TTSModelBase, TTSResponse } from './base';
import { OPENAI_TTS_PARAMETER_SCHEMA, ttsModelOrder } from './schemas';
import type { TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import type { FetchLike } from '../model/http-transport';

export type OpenAIAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface OpenAITTSParameters extends Record<string, unknown> {
    voice: string;
    responseFormat: OpenAIAudioFormat;
    instructions: string | null;
}

export interface OpenAITTSClient {
    create(body: Record<string, unknown>, signal?: AbortSignal): Promise<Uint8Array>;
    stream(body: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

export interface OpenAITTSModelOptions {
    credential: OpenAICredential;
    model?: string;
    parameters?: Partial<OpenAITTSParameters>;
    stream?: boolean;
    client?: OpenAITTSClient;
    fetch?: FetchLike;
}

const MEDIA_TYPES: Record<OpenAIAudioFormat, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
};

/** OpenAI Audio Speech API model. */
export class OpenAITTSModel extends TTSModelBase<OpenAITTSParameters> {
    readonly type = 'openai_tts' as const;
    private readonly client: OpenAITTSClient;

    constructor(options: OpenAITTSModelOptions) {
        super({
            credential: options.credential,
            model: options.model ?? 'tts-1',
            parameters: {
                voice: options.parameters?.voice ?? 'alloy',
                responseFormat: options.parameters?.responseFormat ?? 'mp3',
                instructions: options.parameters?.instructions ?? null,
            },
            stream: options.stream,
        });
        this.client = options.client ?? createOpenAITTSClient(options.credential, options.fetch);
    }

    static listModels(): TTSModelCard[] {
        const cards = listModelCards({
            kind: 'tts',
            provider: 'openai',
            parameterSchema: OPENAI_TTS_PARAMETER_SCHEMA,
        }) as TTSModelCard[];
        return cards.sort(
            (left, right) =>
                ttsModelOrder('openai', left.name) - ttsModelOrder('openai', right.name)
        );
    }

    async synthesize(
        text?: string | null,
        options: Record<string, unknown> = {}
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        if (!text) return new TTSResponse({ content: null });
        const { signal, ...requestOptions } = options;
        const body: Record<string, unknown> = {
            model: this.model,
            voice: this.parameters.voice,
            input: text,
            response_format: this.parameters.responseFormat,
            ...requestOptions,
        };
        if (this.parameters.instructions) body.instructions = this.parameters.instructions;
        const mediaType = MEDIA_TYPES[this.parameters.responseFormat] ?? MEDIA_TYPES.mp3;
        if (this.stream) {
            const stream = await this.client.stream(body, signal as AbortSignal | undefined);
            return parseOpenAIStream(stream, mediaType);
        }
        const audio = await this.client.create(body, signal as AbortSignal | undefined);
        return audioResponse(audio, mediaType);
    }
}

async function* parseOpenAIStream(
    stream: AsyncIterable<Uint8Array>,
    mediaType: string
): AsyncGenerator<TTSResponse, void> {
    let pending: TTSResponse | null = null;
    for await (const delta of stream) {
        if (delta.byteLength === 0) continue;
        if (pending) yield pending;
        pending = audioResponse(delta, mediaType, false);
    }
    if (pending) {
        pending.isLast = true;
        yield pending;
    } else {
        yield new TTSResponse({ content: null, isLast: true });
    }
}

function createOpenAITTSClient(
    credential: OpenAICredential,
    fetchImplementation?: FetchLike
): OpenAITTSClient {
    const url = `${(credential.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/audio/speech`;
    const request = async (
        body: Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<Response> => {
        const response = await (fetchImplementation ?? fetch)(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${credential.apiKey}`,
                'content-type': 'application/json',
                ...(credential.organization
                    ? { 'openai-organization': credential.organization }
                    : {}),
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok)
            throw new Error(`OpenAI TTS request failed with HTTP ${response.status}.`);
        return response;
    };
    return {
        create: async (body, signal) =>
            new Uint8Array(await (await request(body, signal)).arrayBuffer()),
        stream: async (body, signal) => {
            const response = await request(body, signal);
            if (!response.body) throw new Error('OpenAI TTS streaming response body is empty.');
            return readableStream(response.body);
        },
    };
}

async function* readableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) return;
            if (result.value) yield result.value;
        }
    } finally {
        reader.releaseLock();
    }
}
