/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import { Base64Source, DataBlock, URLSource } from '../message';
import type { GeminiEmbeddingClient } from './gemini';
import { GeminiEmbeddingModel } from './gemini';

describe('GeminiEmbeddingModel parity', () => {
    test('lists text and multimodal cards', () => {
        const cards = GeminiEmbeddingModel.listModels();
        expect(cards.map(card => card.name).sort()).toEqual([
            'gemini-embedding-001',
            'gemini-embedding-2',
        ]);
        expect(cards.find(card => card.name === 'gemini-embedding-001')).toMatchObject({
            dimensions: 3072,
            supportedDimensions: [3072, 1536, 768, 512, 256, 128],
            contextSize: 2048,
        });
        expect(cards.find(card => card.name === 'gemini-embedding-2')).toMatchObject({
            contextSize: 8192,
            supportedDimensions: [3072, 1536, 768],
        });
    });

    test('embeds text and rejects DataBlock for a text model', async () => {
        const requests: Parameters<GeminiEmbeddingClient['embedContent']>[0][] = [];
        const client: GeminiEmbeddingClient = {
            embedContent: async request => {
                requests.push(request);
                return { embeddings: request.contents.map((_, index) => ({ values: [index] })) };
            },
        };
        const model = createModel('gemini-embedding-001', client);
        await expect(model.call(['hello', 'world'])).resolves.toMatchObject({
            embeddings: [[0], [1]],
            usage: { tokens: null },
        });
        expect(requests[0]).toMatchObject({
            model: 'gemini-embedding-001',
            contents: [{ parts: [{ text: 'hello' }] }, { parts: [{ text: 'world' }] }],
            config: { output_dimensionality: 1 },
        });
        await expect(model.call([imageBlock()])).rejects.toThrow('only accepts string inputs');
    });

    test('uses separate multimodal contents and batches by media limits', async () => {
        const requests: Parameters<GeminiEmbeddingClient['embedContent']>[0][] = [];
        const client: GeminiEmbeddingClient = {
            embedContent: async request => {
                requests.push(request);
                return { embeddings: request.contents.map(() => ({ values: [0.1] })) };
            },
        };
        const model = createModel('gemini-embedding-2', client);
        const result = await model.call(Array.from({ length: 8 }, () => imageBlock()));
        expect(result.embeddings).toEqual(Array.from({ length: 8 }, () => [0.1]));
        expect(requests.map(request => request.contents.length)).toEqual([6, 2]);
        expect(requests[0].contents[0]).toEqual({
            parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }],
        });
    });

    test('rejects URL sources for multimodal embedding', async () => {
        const model = createModel('gemini-embedding-2', {
            embedContent: async () => ({ embeddings: [] }),
        });
        const block = DataBlock({
            source: URLSource({
                url: 'https://example.com/image.png',
                media_type: 'image/png',
            }),
        });
        await expect(model.call([block])).rejects.toThrow('requires inline data');
    });
});

function imageBlock() {
    return DataBlock({
        source: Base64Source({ data: 'aW1hZ2U=', media_type: 'image/png' }),
    });
}

function createModel(model: string, client: GeminiEmbeddingClient): GeminiEmbeddingModel {
    return new GeminiEmbeddingModel({
        credential: new GeminiCredential({ apiKey: 'key' }),
        model,
        dimensions: 1,
        client,
    });
}
