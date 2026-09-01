/* eslint-disable jsdoc/require-jsdoc */

import { OllamaCredential } from '../credential';
import type { OllamaEmbeddingClient } from './ollama';
import { OllamaEmbeddingModel } from './ollama';

describe('OllamaEmbeddingModel parity', () => {
    test('has no predefined cards and exposes dimensions and host', () => {
        expect(OllamaEmbeddingModel.listModels()).toEqual([]);
        const model = createModel({ embed: async () => ({ embeddings: [] }) }, 768);
        expect(model.dimensions).toBe(768);
        expect(model.host).toBe('http://gpu:11434');
    });

    test('calls embed and supports merged concurrent batches', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client: OllamaEmbeddingClient = {
            embed: async body => {
                bodies.push(body);
                return { embeddings: (body.input as string[]).map(() => [0.1]) };
            },
        };
        const model = createModel(client, 1);
        model.batchSize = 2;
        const result = await model.call(['a', 'b', 'c']);
        expect(result).toMatchObject({
            embeddings: [[0.1], [0.1], [0.1]],
            source: 'api',
            usage: { tokens: 0 },
        });
        expect(bodies).toEqual([
            { input: ['a', 'b'], model: 'test', dimensions: 1 },
            { input: ['c'], model: 'test', dimensions: 1 },
        ]);
    });
});

function createModel(client: OllamaEmbeddingClient, dimensions: number): OllamaEmbeddingModel {
    return new OllamaEmbeddingModel({
        credential: new OllamaCredential({ host: 'http://gpu:11434' }),
        model: 'test',
        dimensions,
        client,
    });
}
