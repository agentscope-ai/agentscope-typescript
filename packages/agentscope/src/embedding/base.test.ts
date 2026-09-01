/* eslint-disable jsdoc/require-jsdoc */

import { OllamaCredential } from '../credential';
import { TextBlock } from '../message';
import {
    EmbeddingModelBase,
    EmbeddingResponse,
    EmbeddingUsage,
    mergeEmbeddingResponses,
} from './base';

class MockEmbeddingModel extends EmbeddingModelBase<string> {
    readonly calls: string[][] = [];
    failures = 0;
    retryable = false;
    onCall?: () => Promise<void>;

    constructor(
        options: { dimensions?: number | null; parameters?: Record<string, unknown> } = {}
    ) {
        super({
            credential: new OllamaCredential(),
            model: 'mock',
            dimensions: options.dimensions === undefined ? 2 : options.dimensions,
            parameters: options.parameters,
            contextSize: 100,
            batchSize: 2,
            maxRetries: 2,
            retryDelay: 0,
        });
    }

    protected override isRetryableError(): boolean {
        return this.retryable;
    }

    protected async callAPI(inputs: string[]): Promise<EmbeddingResponse> {
        this.calls.push([...inputs]);
        const callIndex = this.calls.length;
        if (this.failures > 0) {
            this.failures -= 1;
            throw new Error('transient');
        }
        await this.onCall?.();
        return new EmbeddingResponse({
            embeddings: inputs.map((_, index) => [callIndex, index]),
            usage: new EmbeddingUsage({ tokens: inputs.length, time: 0.1 }),
        });
    }
}

describe('EmbeddingModelBase parity', () => {
    test('requires positive dimensions and promotes legacy dimensions', () => {
        expect(() => new MockEmbeddingModel({ dimensions: null })).toThrow(
            'dimensions must be a positive integer'
        );
        const legacy = new MockEmbeddingModel({
            dimensions: null,
            parameters: { dimensions: 8, task_type: 'search' },
        });
        expect(legacy.dimensions).toBe(8);
        expect(legacy.parameters).toEqual({ task_type: 'search' });
        expect(() => new MockEmbeddingModel({ dimensions: 0 })).toThrow(
            'dimensions must be a positive integer'
        );
    });

    test('normalizes TextBlock, batches concurrently, and preserves batch order', async () => {
        const model = new MockEmbeddingModel() as EmbeddingModelBase<
            string | ReturnType<typeof TextBlock>
        > &
            MockEmbeddingModel;
        let started = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        model.onCall = async () => {
            started += 1;
            if (started === 2) release();
            await gate;
        };
        const result = await model.call(['a', TextBlock({ text: 'b' }), 'c']);
        expect(model.calls).toEqual([['a', 'b'], ['c']]);
        expect(result.embeddings).toEqual([
            [1, 0],
            [1, 1],
            [2, 0],
        ]);
        expect(result.usage).toMatchObject({ tokens: 3, time: 0.2 });
    });

    test('returns an empty response without calling the provider', async () => {
        const model = new MockEmbeddingModel();
        await expect(model.call([])).resolves.toMatchObject({
            embeddings: [],
            source: 'api',
            usage: { tokens: 0, time: 0 },
        });
        expect(model.calls).toEqual([]);
    });

    test('retries only provider-declared errors for each batch', async () => {
        const retrying = new MockEmbeddingModel();
        retrying.retryable = true;
        retrying.failures = 1;
        await expect(retrying.call(['a'])).resolves.toMatchObject({ embeddings: [[2, 0]] });
        expect(retrying.calls).toHaveLength(2);

        const fatal = new MockEmbeddingModel();
        fatal.failures = 1;
        await expect(fatal.call(['a'])).rejects.toThrow('transient');
        expect(fatal.calls).toHaveLength(1);
    });

    test('serializes response and merges nullable usage', () => {
        const first = new EmbeddingResponse({
            id: 'one',
            createdAt: '2026-01-01T00:00:00.000Z',
            embeddings: [[1]],
            usage: new EmbeddingUsage({ tokens: null, time: 0.1 }),
        });
        expect(first.toJSON()).toEqual({
            embeddings: [[1]],
            id: 'one',
            created_at: '2026-01-01T00:00:00.000Z',
            type: 'embedding',
            usage: first.usage,
            source: 'api',
        });
        const merged = mergeEmbeddingResponses([
            first,
            new EmbeddingResponse({
                embeddings: [[2]],
                usage: new EmbeddingUsage({ tokens: 2, time: 0.2 }),
            }),
        ]);
        expect(merged).toMatchObject({ embeddings: [[1], [2]], usage: { tokens: 2 } });
        expect(merged.usage?.time).toBeCloseTo(0.3);
    });
});
