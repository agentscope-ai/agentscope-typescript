/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import type { TTSResponse } from './base';
import type { DashScopeTTSChunk, DashScopeTTSClient } from './dashscope';
import { DashScopeTTSModel } from './dashscope';

describe('DashScopeTTSModel parity', () => {
    test('lists only the one-shot qwen card', () => {
        expect(DashScopeTTSModel.listModels().map(card => card.name)).toEqual(['qwen3-tts-flash']);
    });

    test('aggregates nonempty API chunks into a complete WAV', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client: DashScopeTTSClient = {
            synthesize: async body => {
                bodies.push(body);
                return chunks([Buffer.from('AAAA'), null, Buffer.from('BBBB')]);
            },
        };
        const model = createModel(client, false);
        const result = (await model.synthesize('Hello')) as TTSResponse;
        const wav = Buffer.from(audioData(result), 'base64');
        expect(wav.subarray(0, 4).toString()).toBe('RIFF');
        expect(wav.subarray(44).toString()).toBe('AAAABBBB');
        expect(bodies).toEqual([
            {
                model: 'qwen3-tts-flash',
                text: 'Hello',
                voice: 'Cherry',
                stream: true,
            },
        ]);
    });

    test('streams incremental deltas with one header and a terminal marker', async () => {
        const model = createModel(
            { synthesize: async () => chunks([Buffer.from('AAAA'), null, Buffer.from('BBBB')]) },
            true
        );
        const result = await collect(await model.synthesize('Hello'));
        const payloads = result.map(item => Buffer.from(audioData(item), 'base64'));
        expect(payloads[0].subarray(0, 4).toString()).toBe('RIFF');
        expect(payloads[0].subarray(44).toString()).toBe('AAAA');
        expect(payloads[1].toString()).toBe('BBBB');
        expect(result.map(item => item.isLast)).toEqual([false, true]);
    });

    test('short-circuits empty text and yields a terminal empty stream', async () => {
        let calls = 0;
        const client: DashScopeTTSClient = {
            synthesize: async () => {
                calls += 1;
                return chunks([null]);
            },
        };
        const model = createModel(client, true);
        await expect(model.synthesize(null)).resolves.toMatchObject({ content: null });
        expect(calls).toBe(0);
        const result = await collect(await model.synthesize('Hello'));
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ content: null, isLast: true });
    });
});

function createModel(client: DashScopeTTSClient, stream: boolean): DashScopeTTSModel {
    return new DashScopeTTSModel({
        credential: new DashScopeCredential({ apiKey: 'key' }),
        model: 'qwen3-tts-flash',
        parameters: { voice: 'Cherry' },
        stream,
        client,
    });
}

function* chunks(values: Array<Uint8Array | null>): Generator<DashScopeTTSChunk> {
    for (const [index, value] of values.entries()) {
        yield {
            output: value ? { audio: { data: Buffer.from(value).toString('base64') } } : null,
            usage: index === values.length - 1 ? { input_tokens: 2, output_tokens: 3 } : null,
        };
    }
}

async function collect(result: unknown): Promise<TTSResponse[]> {
    const responses: TTSResponse[] = [];
    for await (const response of result as AsyncGenerator<TTSResponse>) responses.push(response);
    return responses;
}

function audioData(response: TTSResponse): string {
    const source = response.content?.source;
    if (!source || source.type !== 'base64') throw new Error('Expected base64 audio.');
    return source.data;
}
