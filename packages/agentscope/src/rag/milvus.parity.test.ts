/* eslint-disable jsdoc/require-jsdoc */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TextBlock } from '../message';
import { MilvusLiteStore } from './milvus';
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

describe('MilvusLiteStore Python parity', () => {
    let directory: string;
    let path: string;
    let store: MilvusLiteStore;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-milvus-'));
        path = join(directory, 'test.db');
        store = new MilvusLiteStore({ uri: path });
    });

    afterEach(async () => {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    });

    test('manages collections idempotently', async () => {
        expect(await store.hasCollection('kb_1')).toBe(false);
        await store.createCollection('kb_1', 3);
        await store.createCollection('kb_1', 3);
        expect(await store.hasCollection('kb_1')).toBe(true);
        await store.deleteCollection('kb_1');
        expect(await store.hasCollection('kb_1')).toBe(false);
    });

    test('inserts, searches, and limits by cosine similarity', async () => {
        await store.createCollection('kb_1', 3);
        await store.insert('kb_1', [
            record('Hello world!', [1, 0, 0], 'doc-1', 0, 2),
            record('Goodbye world!', [0, 1, 0], 'doc-1', 1, 2),
            record('Third', [0.9, 0.1, 0], 'doc-2'),
        ]);
        const results = await store.search('kb_1', [1, 0, 0], 2);
        expect(
            results.map(result => ({ score: result.score, document_id: result.document_id }))
        ).toEqual([
            { score: 1, document_id: 'doc-1' },
            { score: 0.9938837346736189, document_id: 'doc-2' },
        ]);
        expect(results[0].chunk).toEqual(
            expect.objectContaining({
                source: 'doc-1.txt',
                chunk_index: 0,
                total_chunks: 2,
                content: expect.objectContaining({ text: 'Hello world!' }),
            })
        );
    });

    test('upserts stable IDs and deletes a whole document', async () => {
        await store.createCollection('kb_1', 3);
        const records = [
            record('A', [1, 0, 0], 'doc-1', 0, 2),
            record('B', [0, 1, 0], 'doc-1', 1, 2),
            record('C', [0, 0, 1], 'doc-2'),
        ];
        await store.insert('kb_1', records);
        await store.insert('kb_1', records);
        expect(
            (await store.listDocuments('kb_1')).find(item => item.document_id === 'doc-1')
                ?.chunk_count
        ).toBe(2);
        await store.delete('kb_1', 'doc-1');
        expect(
            (await store.search('kb_1', [1, 0, 0], 5)).map(result => result.document_id)
        ).toEqual(['doc-2']);
    });

    test('aggregates documents and applies flat metadata filters', async () => {
        await store.createCollection('kb_1', 3);
        await store.insert('kb_1', [
            record('A', [1, 0, 0], 'doc-1', 0, 2, {
                filename: 'alpha.txt',
                media_type: 'text/plain',
                kb_scope: 'kb-a',
            }),
            record('B', [1, 0, 0], 'doc-1', 1, 2, {
                filename: 'alpha.txt',
                media_type: 'text/plain',
                kb_scope: 'kb-a',
            }),
            record('C', [1, 0, 0], 'doc-2', 0, 1, {
                filename: 'beta.md',
                media_type: 'text/markdown',
                kb_scope: 'kb-b',
            }),
        ]);
        expect(await store.listDocuments('kb_1', { kb_scope: 'kb-a' })).toEqual([
            {
                document_id: 'doc-1',
                source: 'alpha.txt',
                chunk_count: 2,
                metadata: { filename: 'alpha.txt', media_type: 'text/plain', kb_scope: 'kb-a' },
            },
        ]);
        expect(
            (await store.search('kb_1', [1, 0, 0], 5, { kb_scope: 'kb-b' })).map(
                result => result.document_id
            )
        ).toEqual(['doc-2']);
    });

    test('lists chunks by dense index range and tenant scope', async () => {
        await store.createCollection('kb_1', 3);
        await store.insert('kb_1', [
            ...[3, 0, 4, 1, 2].map(index =>
                record(`doc1-chunk${index}`, [1, 0, 0], 'doc-1', index, 5, { kb_scope: 'kb-a' })
            ),
            ...[1, 0].map(index => record(`doc2-chunk${index}`, [0, 1, 0], 'doc-2', index, 2)),
        ]);
        expect(
            (
                await store.listChunks('kb_1', 'doc-1', {
                    offset: 1,
                    limit: 3,
                    metadata_filter: { kb_scope: 'kb-a' },
                })
            ).map(chunk => chunk.chunk_index)
        ).toEqual([1, 2, 3]);
        expect(
            await store.listChunks('kb_1', 'doc-1', { metadata_filter: { kb_scope: 'kb-b' } })
        ).toEqual([]);
        expect(await store.listChunks('kb_1', 'doc-1', { limit: 0 })).toEqual([]);
    });

    test('persists records after closing and reopening', async () => {
        await store.createCollection('kb_persistent', 3);
        await store.insert('kb_persistent', [record('Persisted', [1, 0, 0], 'doc-1')]);
        await store.close();
        store = new MilvusLiteStore({ uri: path });
        await store.createCollection('kb_persistent', 3);
        expect(
            (await store.search('kb_persistent', [1, 0, 0], 1)).map(result => result.document_id)
        ).toEqual(['doc-1']);
    });

    test('matches Milvus filter, score, URI, and ID helpers', () => {
        const item = record('A', [1, 0], '文档', 2);
        expect(MilvusLiteStore.recordId(item)).toHaveLength(64);
        expect(MilvusLiteStore.buildDocumentFilter('a"b')).toBe('document_id == "a\\\"b"');
        expect(MilvusLiteStore.buildMetadataFilter({ tenant: 'bank-a', active: true })).toBe(
            'metadata["tenant"] == "bank-a" and metadata["active"] == true'
        );
        expect(MilvusLiteStore.extractScore({ distance: 0.9 })).toBe(0.9);
        expect(MilvusLiteStore.extractScore({ score: 0.8 })).toBe(0.8);
        expect(MilvusLiteStore.isLocalDbUri('./test.db')).toBe(true);
        expect(MilvusLiteStore.isLocalDbUri('http://localhost:19530')).toBe(false);
    });
});
