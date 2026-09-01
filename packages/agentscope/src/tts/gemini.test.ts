/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import type { TTSResponse } from './base';
import type { GeminiTTSAPIResponse, GeminiTTSClient } from './gemini';
import { GeminiTTSModel } from './gemini';

describe('GeminiTTSModel parity', () => {
    test('lists both preview models and injects voices', () => {
        const cards = GeminiTTSModel.listModels();
        expect(cards.map(card => card.name).sort()).toEqual([
            'gemini-2.5-flash-preview-tts',
            'gemini-2.5-pro-preview-tts',
        ]);
        expect(cards[0].parameterSchema).toHaveProperty('properties.voice.enum');
    });

    test('concatenates PCM into a complete WAV and parses usage', async () => {
        const requests: Parameters<GeminiTTSClient['generateContent']>[0][] = [];
        const client = createClient({
            generateContent: async request => {
                requests.push(request);
                return response([Buffer.from('AAAA'), Buffer.from('BBBB')], 5, 10);
            },
        });
        const model = createModel(client, false, 'Puck');
        const result = (await model.synthesize('Hello')) as TTSResponse;
        const wav = Buffer.from(audioData(result), 'base64');
        expect(wav.subarray(0, 4).toString()).toBe('RIFF');
        expect(wav.subarray(44).toString()).toBe('AAAABBBB');
        expect(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true)).toBe(24000);
        expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 10 });
        expect(requests[0]).toMatchObject({
            model: 'gemini-2.5-flash-preview-tts',
            contents: 'Hello',
            config: {
                response_modalities: ['AUDIO'],
                speech_config: {
                    voice_config: { prebuilt_voice_config: { voice_name: 'Puck' } },
                },
            },
        });
    });

    test('streams one WAV header followed by raw PCM deltas', async () => {
        const client = createClient({
            generateContentStream: async () =>
                responseStream([
                    response([Buffer.from('AAAA')]),
                    response([Buffer.from('BBBB')], 2, 3),
                ]),
        });
        const chunks = await collect(await createModel(client, true).synthesize('Hello'));
        const payloads = chunks.map(chunk => Buffer.from(audioData(chunk), 'base64'));
        expect(payloads[0].subarray(0, 4).toString()).toBe('RIFF');
        expect(payloads[0].subarray(44).toString()).toBe('AAAA');
        expect(payloads[1].toString()).toBe('BBBB');
        expect(chunks.map(chunk => chunk.isLast)).toEqual([false, true]);
        expect(chunks[1].usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    });

    test('short-circuits empty text and handles missing audio', async () => {
        let calls = 0;
        const client = createClient({
            generateContent: async () => {
                calls += 1;
                return response([]);
            },
        });
        const model = createModel(client, false);
        await expect(model.synthesize('')).resolves.toMatchObject({ content: null });
        expect(calls).toBe(0);
        await expect(model.synthesize('Hello')).resolves.toMatchObject({ content: null });
    });
});

function createModel(client: GeminiTTSClient, stream: boolean, voice = 'Kore') {
    return new GeminiTTSModel({
        credential: new GeminiCredential({ apiKey: 'key' }),
        model: 'gemini-2.5-flash-preview-tts',
        parameters: { voice },
        stream,
        client,
    });
}

function createClient(overrides: Partial<GeminiTTSClient>): GeminiTTSClient {
    return {
        generateContent: async () => response([]),
        generateContentStream: async () => responseStream([]),
        ...overrides,
    };
}

function response(
    chunks: Uint8Array[],
    inputTokens?: number,
    outputTokens?: number
): GeminiTTSAPIResponse {
    return {
        candidates: [
            {
                content: {
                    parts: chunks.map(chunk => ({
                        inlineData: { data: Buffer.from(chunk).toString('base64') },
                    })),
                },
            },
        ],
        ...(inputTokens == null
            ? {}
            : {
                  usageMetadata: {
                      promptTokenCount: inputTokens,
                      candidatesTokenCount: outputTokens,
                  },
              }),
    };
}

async function* responseStream(
    responses: GeminiTTSAPIResponse[]
): AsyncGenerator<GeminiTTSAPIResponse> {
    for (const item of responses) yield item;
}

async function collect(result: unknown): Promise<TTSResponse[]> {
    const chunks: TTSResponse[] = [];
    for await (const chunk of result as AsyncGenerator<TTSResponse>) chunks.push(chunk);
    return chunks;
}

function audioData(response: TTSResponse): string {
    const source = response.content?.source;
    if (!source || source.type !== 'base64') throw new Error('Expected base64 audio.');
    return source.data;
}
