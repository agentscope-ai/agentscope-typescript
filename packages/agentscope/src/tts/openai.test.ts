/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import type { TTSResponse } from './base';
import type { OpenAITTSClient } from './openai';
import { OpenAITTSModel } from './openai';

describe('OpenAITTSModel parity', () => {
    test('lists three cards and hides instructions for legacy models', () => {
        const cards = OpenAITTSModel.listModels();
        expect(cards.map(card => card.name).sort()).toEqual([
            'gpt-4o-mini-tts',
            'tts-1',
            'tts-1-hd',
        ]);
        expect(cards.find(card => card.name === 'gpt-4o-mini-tts')?.parameterSchema).toHaveProperty(
            'properties.instructions'
        );
        expect(cards.find(card => card.name === 'tts-1')?.parameterSchema).not.toHaveProperty(
            'properties.instructions'
        );
    });

    test('aggregates bytes and builds the configured request', async () => {
        const bodies: Record<string, unknown>[] = [];
        const model = createModel(
            {
                create: async body => {
                    bodies.push(body);
                    return Buffer.from('AAAABBBB');
                },
                stream: async () => byteStream([]),
            },
            false,
            { responseFormat: 'wav', instructions: 'Speak warmly', voice: 'nova' }
        );
        const result = (await model.synthesize('Hello')) as TTSResponse;
        expect(Buffer.from(audioData(result), 'base64').toString()).toBe('AAAABBBB');
        expect(result.content!.source.media_type).toBe('audio/wav');
        expect(bodies).toEqual([
            {
                model: 'tts-1',
                voice: 'nova',
                input: 'Hello',
                response_format: 'wav',
                instructions: 'Speak warmly',
            },
        ]);
    });

    test('streams incremental chunks and marks only the terminal chunk last', async () => {
        const model = createModel(
            {
                create: async () => new Uint8Array(),
                stream: async () =>
                    byteStream([Buffer.from('AAAA'), new Uint8Array(), Buffer.from('BBBB')]),
            },
            true
        );
        const chunks = await collect(await model.synthesize('Hello'));
        expect(chunks.map(chunk => chunk.isLast)).toEqual([false, true]);
        expect(chunks.map(chunk => Buffer.from(audioData(chunk), 'base64').toString())).toEqual([
            'AAAA',
            'BBBB',
        ]);
    });

    test('empty text and an empty stream return terminal empty responses', async () => {
        let calls = 0;
        const model = createModel(
            {
                create: async () => {
                    calls += 1;
                    return new Uint8Array();
                },
                stream: async () => {
                    calls += 1;
                    return byteStream([]);
                },
            },
            true
        );
        await expect(model.synthesize(null)).resolves.toMatchObject({ content: null });
        expect(calls).toBe(0);
        const chunks = await collect(await model.synthesize('Hello'));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ content: null, isLast: true });
    });
});

function createModel(
    client: OpenAITTSClient,
    stream: boolean,
    parameters: ConstructorParameters<typeof OpenAITTSModel>[0]['parameters'] = {}
): OpenAITTSModel {
    return new OpenAITTSModel({
        credential: new OpenAICredential({ apiKey: 'key' }),
        model: 'tts-1',
        stream,
        parameters,
        client,
    });
}

async function* byteStream(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
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
