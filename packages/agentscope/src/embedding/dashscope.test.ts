/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import { Base64Source, DataBlock, URLSource } from '../message';
import type { DashScopeEmbeddingClient } from './dashscope';
import { DashScopeEmbeddingModel } from './dashscope';

describe('DashScopeEmbeddingModel parity', () => {
    test('lists seven text and multimodal cards', () => {
        const cards = DashScopeEmbeddingModel.listModels();
        expect(cards).toHaveLength(7);
        expect(cards.map(card => card.name)).toEqual(
            expect.arrayContaining([
                'text-embedding-v4',
                'qwen3-vl-embedding',
                'multimodal-embedding-v1',
            ])
        );
        expect(cards.find(card => card.name === 'multimodal-embedding-v1')).toMatchObject({
            dimensions: 1024,
            supportedDimensions: null,
            contextSize: 512,
        });
        expect(cards.find(card => card.name === 'qwen3-vl-embedding')).toMatchObject({
            dimensions: 2560,
            supportedDimensions: [2560, 2048, 1536, 1024, 768, 512, 256],
        });
    });

    test('embeds text, forwards the singular dimension, and rejects data', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client = mockClient({
            text: async body => {
                bodies.push(body);
                return {
                    output: { embeddings: [{ embedding: [0.1] }, { embedding: [0.2] }] },
                    usage: { total_tokens: 12 },
                };
            },
        });
        const model = createModel('text-embedding-v4', client, 1);
        await expect(model.call(['hello', 'world'])).resolves.toMatchObject({
            embeddings: [[0.1], [0.2]],
            usage: { tokens: 12 },
        });
        expect(bodies).toEqual([
            { input: ['hello', 'world'], model: 'text-embedding-v4', dimension: 1 },
        ]);
        await expect(model.call([imageBlock()])).rejects.toThrow('only accepts string inputs');
    });

    test('retries non-successful API responses as runtime errors', async () => {
        let calls = 0;
        const model = new DashScopeEmbeddingModel({
            credential: new DashScopeCredential({ apiKey: 'key' }),
            model: 'text-embedding-v4',
            dimensions: 1,
            retryDelay: 0,
            client: mockClient({
                text: async () => {
                    calls += 1;
                    return { statusCode: 400, output: { embeddings: [] } };
                },
            }),
        });
        await expect(model.call(['hello'])).rejects.toThrow('DashScope text embedding API error');
        expect(calls).toBe(4);
    });

    test('formats media and batches qwen images and videos by their limits', async () => {
        const batchSizes: number[] = [];
        const client = mockClient({
            multimodal: async body => {
                const inputs = body.input as Array<Record<string, string>>;
                batchSizes.push(inputs.length);
                return {
                    output: { embeddings: inputs.map(() => ({ embedding: [0.1] })) },
                    usage: { image_tokens: inputs.length, input_tokens: 1 },
                };
            },
        });
        const model = createModel('qwen3-vl-embedding', client, 1);
        const images = await model.call(Array.from({ length: 8 }, () => imageBlock()));
        expect(images.embeddings).toEqual(Array.from({ length: 8 }, () => [0.1]));
        expect(batchSizes).toEqual([5, 3]);

        batchSizes.length = 0;
        await model.call([videoBlock(), videoBlock(), videoBlock()]);
        expect(batchSizes).toEqual([1, 1, 1]);
        expect(DashScopeEmbeddingModel.formatDataBlock(imageBlock())).toEqual({
            image: 'data:image/png;base64,aW1hZ2U=',
        });
        expect(DashScopeEmbeddingModel.formatDataBlock(videoBlock())).toEqual({
            video: 'https://example.com/video.mp4',
        });
    });

    test('rejects inline video data', () => {
        expect(() =>
            DashScopeEmbeddingModel.formatDataBlock(
                DataBlock({
                    source: Base64Source({ data: 'eA==', media_type: 'video/mp4' }),
                })
            )
        ).toThrow('only supports URL input for video data');
    });
});

function imageBlock() {
    return DataBlock({
        source: Base64Source({ data: 'aW1hZ2U=', media_type: 'image/png' }),
    });
}

function videoBlock() {
    return DataBlock({
        source: URLSource({
            url: 'https://example.com/video.mp4',
            media_type: 'video/mp4',
        }),
    });
}

function createModel(
    model: string,
    client: DashScopeEmbeddingClient,
    dimensions: number
): DashScopeEmbeddingModel {
    return new DashScopeEmbeddingModel({
        credential: new DashScopeCredential({ apiKey: 'key' }),
        model,
        dimensions,
        client,
    });
}

function mockClient(overrides: Partial<DashScopeEmbeddingClient>): DashScopeEmbeddingClient {
    return {
        text: async () => ({ output: { embeddings: [] } }),
        multimodal: async () => ({ output: { embeddings: [] } }),
        ...overrides,
    };
}
