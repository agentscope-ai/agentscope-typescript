/* eslint-disable jsdoc/require-jsdoc */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TextBlock } from '../message';
import { QdrantStore } from './qdrant';
import type { VectorRecord } from './vector-store';

function record(
    text: string,
    vector: number[],
    documentId: string,
    chunkIndex = 0,
    totalChunks = 1,
    metadata: Record<string, unknown> = {}
): VectorRecord {
    return {
        vector,
        document_id: documentId,
        chunk: {
            content: TextBlock({ text }),
            source: String(metadata.filename ?? `${documentId}.txt`),
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            metadata,
        },
    };
}

describe('QdrantStore Python parity', () => {
    let store: QdrantStore;

    beforeEach(() => {
        store = new QdrantStore({ location: ':memory:' });
    });

    afterEach(async () => store.close());

    test('manages collections idempotently', async () => {
        expect(await store.hasCollection('kb-1')).toBe(false);
        await store.createCollection('kb-1', 3);
        await store.createCollection('kb-1', 3);
        expect(await store.hasCollection('kb-1')).toBe(true);
        await store.deleteCollection('kb-1');
        expect(await store.hasCollection('kb-1')).toBe(false);
    });

    test('inserts and searches in similarity order', async () => {
        await store.createCollection('kb-1', 3);
        await store.insert('kb-1', [
            record('Hello world!', [1, 0, 0], 'doc-1', 0, 2),
            record('Goodbye world!', [0, 1, 0], 'doc-1', 1, 2),
        ]);
        const results = await store.search('kb-1', [1, 0, 0], 2);
        expect(
            results.map(result => ({
                score: result.score,
                text: result.chunk.content.type === 'text' ? result.chunk.content.text : '',
            }))
        ).toEqual([
            { score: 1, text: 'Hello world!' },
            { score: 0, text: 'Goodbye world!' },
        ]);
    });

    test('stable point IDs make retries idempotent and delete is document-scoped', async () => {
        await store.createCollection('kb-1', 3);
        const records = [
            record('A', [1, 0, 0], 'doc-1', 0, 2),
            record('B', [0, 1, 0], 'doc-1', 1, 2),
            record('C', [0, 0, 1], 'doc-2'),
        ];
        await store.insert('kb-1', records);
        await store.insert('kb-1', records);
        expect(
            (await store.listDocuments('kb-1')).find(item => item.document_id === 'doc-1')
                ?.chunk_count
        ).toBe(2);
        await store.delete('kb-1', 'doc-1');
        expect(
            (await store.search('kb-1', [1, 0, 0], 5)).map(result => result.document_id)
        ).toEqual(['doc-2']);
    });

    test('metadata filters isolate search and document summaries', async () => {
        await store.createCollection('kb-1', 3);
        await store.insert('kb-1', [
            record('A', [1, 0, 0], 'doc-1', 0, 2, { filename: 'alpha.txt', kb_scope: 'kb-a' }),
            record('B', [1, 0, 0], 'doc-1', 1, 2, { filename: 'alpha.txt', kb_scope: 'kb-a' }),
            record('C', [1, 0, 0], 'doc-2', 0, 1, { filename: 'beta.md', kb_scope: 'kb-b' }),
        ]);
        expect(
            (await store.search('kb-1', [1, 0, 0], 5, { kb_scope: 'kb-b' })).map(
                result => result.document_id
            )
        ).toEqual(['doc-2']);
        expect(await store.listDocuments('kb-1', { kb_scope: 'kb-a' })).toEqual([
            {
                document_id: 'doc-1',
                source: 'alpha.txt',
                chunk_count: 2,
                metadata: { filename: 'alpha.txt', kb_scope: 'kb-a' },
            },
        ]);
    });

    test('lists chunk windows in index order and deduplicates retries', async () => {
        await store.createCollection('kb-1', 3);
        const records = [3, 0, 4, 1, 2].map(index =>
            record(`chunk${index}`, [1, 0, 0], 'doc-1', index, 5, { kb_scope: 'kb-a' })
        );
        await store.insert('kb-1', records);
        await store.insert('kb-1', records);
        expect(
            (
                await store.listChunks('kb-1', 'doc-1', {
                    offset: 1,
                    limit: 3,
                    metadata_filter: { kb_scope: 'kb-a' },
                })
            ).map(chunk => chunk.chunk_index)
        ).toEqual([1, 2, 3]);
        expect(await store.listChunks('kb-1', 'doc-1', { limit: 0 })).toEqual([]);
        expect(
            await store.listChunks('kb-1', 'doc-1', { metadata_filter: { kb_scope: 'kb-b' } })
        ).toEqual([]);
    });

    test('persists path-backed collections', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'agentscope-qdrant-'));
        try {
            store = new QdrantStore({ path: directory });
            await store.createCollection('kb-1', 3);
            await store.insert('kb-1', [record('Persisted', [1, 0, 0], 'doc-1')]);
            await store.close();
            store = new QdrantStore({ path: directory });
            expect(
                (await store.search('kb-1', [1, 0, 0], 1)).map(result => result.document_id)
            ).toEqual(['doc-1']);
        } finally {
            await store.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('builds UUID and nested metadata contracts', () => {
        const value = record('A', [1], 'doc-1', 2);
        expect(QdrantStore.pointId(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
        expect(QdrantStore.pointId(value)).toBe(QdrantStore.pointId(value));
        expect(QdrantStore.buildMetadataFilter({ tenant: 'bank-a' })).toEqual({
            must: [{ key: 'chunk.metadata.tenant', match: { value: 'bank-a' } }],
        });
        expect(QdrantStore.buildMetadataFilter(null)).toBeNull();
        expect(() => new QdrantStore({ location: ':memory:', url: 'http://localhost' })).toThrow(
            'mutually exclusive'
        );
    });
});
