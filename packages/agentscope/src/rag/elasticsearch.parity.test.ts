/* eslint-disable jsdoc/require-jsdoc */

import { TextBlock } from '../message';
import type { Chunk } from './document';
import { ElasticsearchStore, type ElasticsearchClientLike } from './elasticsearch';
import type { VectorRecord } from './vector-store';

function record(
    documentId: string,
    chunkIndex: number,
    metadata: Record<string, unknown> = {}
): VectorRecord {
    return {
        vector: [1, 0, 0],
        document_id: documentId,
        chunk: {
            content: TextBlock({ text: `chunk-${chunkIndex}` }),
            source: `${documentId}.txt`,
            chunk_index: chunkIndex,
            total_chunks: 2,
            metadata,
        },
    };
}

function fakeClient(): ElasticsearchClientLike & Record<string, unknown> {
    return {
        indices: {
            exists: jest.fn().mockResolvedValue(false),
            create: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({}),
        },
        bulk: jest.fn().mockResolvedValue({ errors: false, items: [] }),
        deleteByQuery: jest.fn().mockResolvedValue({}),
        search: jest.fn().mockResolvedValue({ hits: { hits: [] } }),
        openPointInTime: jest.fn().mockResolvedValue({ id: 'pit-1' }),
        closePointInTime: jest.fn().mockResolvedValue({}),
        close: jest.fn().mockResolvedValue(undefined),
    };
}

describe('ElasticsearchStore Python parity', () => {
    test('validates options and manages collection mappings', async () => {
        expect(
            () => new ElasticsearchStore({ hosts: 'http://localhost', num_candidates: 0 })
        ).toThrow('between 1 and 10000');
        const client = fakeClient();
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        expect(await store.hasCollection('kb-1')).toBe(false);
        await store.createCollection('kb-1', 3);
        expect(client.indices.create).toHaveBeenCalledWith({
            index: 'kb-1',
            mappings: {
                dynamic: false,
                properties: {
                    vector: { type: 'dense_vector', dims: 3, index: true, similarity: 'cosine' },
                    document_id: { type: 'keyword' },
                    chunk: { type: 'object', enabled: false },
                    metadata: { type: 'object', dynamic: 'runtime' },
                },
            },
        });
        await store.deleteCollection('kb-1');
        expect(client.indices.delete).toHaveBeenCalledWith({ index: 'kb-1' });
    });

    test('bulk insert uses stable IDs and surfaces item failures', async () => {
        const client = fakeClient();
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        const records = [record('doc-1', 0), record('doc-1', 1)];
        await store.insert('kb-1', records);
        const first = (client.bulk as jest.Mock).mock.calls[0][0].operations;
        await store.insert('kb-1', records);
        const second = (client.bulk as jest.Mock).mock.calls[1][0].operations;
        expect(first).toEqual(second);
        expect(first[0].index._id).not.toBe(first[2].index._id);
        expect(first[1]).toEqual(expect.objectContaining({ document_id: 'doc-1' }));

        (client.bulk as jest.Mock).mockResolvedValueOnce({
            errors: true,
            items: [{ index: { error: { type: 'mapper_error' } } }],
        });
        await expect(store.insert('kb-1', [records[0]])).rejects.toThrow('1 record');
    });

    test('empty inserts and non-positive searches short circuit', async () => {
        const client = fakeClient();
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        await store.insert('kb-1', []);
        expect(client.bulk).not.toHaveBeenCalled();
        expect(await store.search('kb-1', [1, 0], 0)).toEqual([]);
        expect(client.search).not.toHaveBeenCalled();
    });

    test('delete maps refresh policy and document term', async () => {
        const client = fakeClient();
        const store = new ElasticsearchStore({ hosts: 'http://localhost', refresh: false, client });
        await store.delete('kb-1', 'doc-1');
        expect(client.deleteByQuery).toHaveBeenCalledWith({
            index: 'kb-1',
            query: { term: { document_id: 'doc-1' } },
            conflicts: 'proceed',
            refresh: false,
        });
    });

    test('search applies metadata and normalizes cosine score', async () => {
        const client = fakeClient();
        const chunk = record('doc-1', 0, { tenant: 'bank-a' }).chunk;
        (client.search as jest.Mock).mockResolvedValue({
            hits: { hits: [{ _score: 0.95, _source: { document_id: 'doc-1', chunk } }] },
        });
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        expect(await store.search('kb-1', [1, 0, 0], 5, { tenant: 'bank-a' })).toEqual([
            { score: 0.8999999999999999, document_id: 'doc-1', chunk },
        ]);
        expect(client.search).toHaveBeenCalledWith({
            index: 'kb-1',
            size: 5,
            knn: {
                field: 'vector',
                query_vector: [1, 0, 0],
                k: 5,
                num_candidates: 100,
                filter: [{ term: { 'metadata.tenant': 'bank-a' } }],
            },
            source_includes: ['document_id', 'chunk'],
        });
        await expect(store.search('kb-1', [1], 10_001)).rejects.toThrow('10000');
    });

    test('listDocuments follows composite pagination', async () => {
        const client = fakeClient();
        const chunk = record('doc-1', 0, { tenant: 'bank-a' }).chunk;
        (client.search as jest.Mock)
            .mockResolvedValueOnce({
                aggregations: {
                    documents: {
                        buckets: [
                            {
                                key: { document_id: 'doc-1' },
                                doc_count: 2,
                                sample: { hits: { hits: [{ _source: { chunk } }] } },
                            },
                        ],
                        after_key: { document_id: 'doc-1' },
                    },
                },
            })
            .mockResolvedValueOnce({ aggregations: { documents: { buckets: [] } } });
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        expect(await store.listDocuments('kb-1', { tenant: 'bank-a' })).toEqual([
            {
                document_id: 'doc-1',
                source: 'doc-1.txt',
                chunk_count: 2,
                metadata: { tenant: 'bank-a' },
            },
        ]);
        expect(
            (client.search as jest.Mock).mock.calls[1][0].aggs.documents.composite.after
        ).toEqual({ document_id: 'doc-1' });
    });

    test('listChunks scans PIT, selects its window, and always closes', async () => {
        const client = fakeClient();
        const chunks: Chunk[] = [2, 0, 3, 1].map(index => record('doc-1', index).chunk);
        (client.search as jest.Mock)
            .mockResolvedValueOnce({
                hits: {
                    hits: chunks
                        .slice(0, 2)
                        .map((chunk, index) => ({ _source: { chunk }, sort: [index] })),
                },
                pit_id: 'pit-1',
            })
            .mockResolvedValueOnce({
                hits: {
                    hits: chunks
                        .slice(2)
                        .map((chunk, index) => ({ _source: { chunk }, sort: [index + 2] })),
                },
                pit_id: 'pit-2',
            })
            .mockResolvedValueOnce({ hits: { hits: [] }, pit_id: 'pit-2' });
        const store = new ElasticsearchStore({ hosts: 'http://localhost', client });
        const page = await store.listChunks('kb-1', 'doc-1', {
            offset: 1,
            limit: 2,
            metadata_filter: { tenant: 'bank-a' },
        });
        expect(page.map(chunk => chunk.chunk_index)).toEqual([1, 2]);
        expect((client.search as jest.Mock).mock.calls[0][0].query).toEqual({
            bool: {
                filter: [
                    { term: { document_id: 'doc-1' } },
                    { term: { 'metadata.tenant': 'bank-a' } },
                ],
            },
        });
        expect((client.search as jest.Mock).mock.calls[1][0].search_after).toEqual([1]);
        expect(client.closePointInTime).toHaveBeenCalledWith({ id: 'pit-2' });

        (client.search as jest.Mock).mockReset().mockRejectedValue(new Error('boom'));
        await expect(store.listChunks('kb-1', 'doc-1')).rejects.toThrow('boom');
        expect(client.closePointInTime).toHaveBeenLastCalledWith({ id: 'pit-1' });
    });
});
