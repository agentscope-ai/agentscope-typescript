/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import type { OpenAIEmbeddingClient } from './openai';
import { OpenAIEmbeddingModel } from './openai';

describe('OpenAIEmbeddingModel parity', () => {
    test('lists the Python model cards', () => {
        expect(
            OpenAIEmbeddingModel.listModels()
                .map(card => card.name)
                .sort()
        ).toEqual(['text-embedding-3-large', 'text-embedding-3-small']);
        expect(
            OpenAIEmbeddingModel.listModels().find(card => card.name === 'text-embedding-3-small')
        ).toMatchObject({
            dimensions: 1536,
            supportedDimensions: [1536, 1024, 768, 512, 256],
            contextSize: 8191,
        });
    });

    test('builds a request and restores provider index order', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client: OpenAIEmbeddingClient = {
            create: async body => {
                bodies.push(body);
                return {
                    data: [
                        { index: 1, embedding: [0.3, 0.4] },
                        { index: 0, dense_embedding: [0.1, 0.2] },
                    ],
                    usage: { total_tokens: 8 },
                };
            },
        };
        const model = createModel(client, 2);
        await expect(model.call(['hello', 'world'])).resolves.toMatchObject({
            embeddings: [
                [0.1, 0.2],
                [0.3, 0.4],
            ],
            source: 'api',
            usage: { tokens: 8 },
        });
        expect(bodies).toEqual([
            {
                input: ['hello', 'world'],
                model: 'text-embedding-3-small',
                encoding_format: 'float',
                dimensions: 2,
            },
        ]);
    });

    test('splits batches, merges usage, and can omit dimensions', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client: OpenAIEmbeddingClient = {
            create: async body => {
                bodies.push(body);
                const count = (body.input as string[]).length;
                return {
                    data: Array.from({ length: count }, (_, index) => ({ embedding: [index] })),
                    usage: { total_tokens: count * 2 },
                };
            },
        };
        const model = new OpenAIEmbeddingModel({
            credential: new OpenAICredential({ apiKey: 'key' }),
            model: 'compatible',
            dimensions: 1,
            passDimensions: false,
            client,
        });
        model.batchSize = 2;
        const result = await model.call(['a', 'b', 'c']);
        expect(result).toMatchObject({ embeddings: [[0], [1], [0]], usage: { tokens: 6 } });
        expect(bodies).toHaveLength(2);
        expect(bodies.every(body => !('dimensions' in body))).toBe(true);
    });

    test('returns empty input without an API call and retries rate limits', async () => {
        let calls = 0;
        const client: OpenAIEmbeddingClient = {
            create: async () => {
                calls += 1;
                if (calls === 1) {
                    const error = new Error('limited');
                    error.name = 'RateLimitError';
                    throw error;
                }
                return { data: [{ embedding: [0.1] }], usage: { total_tokens: 1 } };
            },
        };
        const model = new OpenAIEmbeddingModel({
            credential: new OpenAICredential({ apiKey: 'key' }),
            model: 'text-embedding-3-small',
            dimensions: 1,
            retryDelay: 0,
            client,
        });
        await expect(model.call([])).resolves.toMatchObject({
            embeddings: [],
            usage: { tokens: 0 },
        });
        expect(calls).toBe(0);
        await expect(model.call(['hello'])).resolves.toMatchObject({ embeddings: [[0.1]] });
        expect(calls).toBe(2);
    });
});

function createModel(client: OpenAIEmbeddingClient, dimensions: number): OpenAIEmbeddingModel {
    return new OpenAIEmbeddingModel({
        credential: new OpenAICredential({ apiKey: 'key' }),
        model: 'text-embedding-3-small',
        dimensions,
        client,
    });
}
