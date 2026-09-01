/* eslint-disable @typescript-eslint/no-explicit-any, jsdoc/require-jsdoc */

import { TextBlock } from '../message';
import { MongoDBStore, type MongoDBClientLike } from './mongodb';
import type { VectorRecord } from './vector-store';

type Row = Record<string, any>;

class Cursor<T> implements AsyncIterable<T> {
    constructor(private values: T[]) {}

    sort(path: string, direction: number): this {
        this.values.sort((left, right) => {
            const result = Number(readPath(left, path)) - Number(readPath(right, path));
            return direction < 0 ? -result : result;
        });
        return this;
    }

    skip(count: number): this {
        this.values = this.values.slice(count);
        return this;
    }

    limit(count: number): this {
        this.values = this.values.slice(0, count);
        return this;
    }

    async toArray(): Promise<T[]> {
        return this.values;
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        yield* this.values;
    }
}

class FakeCollection {
    readonly rows = new Map<string, Row>();
    readonly createSearchIndex = jest.fn(async () => 'vector_index');
    readonly drop = jest.fn(async () => {
        this.database.collections.delete(this.name);
    });
    readonly bulkWrite = jest.fn(
        async (operations: Array<{ replaceOne: { replacement: Row } }>) => {
            for (const operation of operations) {
                const row = operation.replaceOne.replacement;
                this.rows.set(String(row._id), structuredClone(row));
            }
        }
    );
    readonly deleteMany = jest.fn(async (filter: Row) => {
        for (const [id, row] of this.rows) {
            if (row.document_id === filter.document_id) this.rows.delete(id);
        }
    });
    readonly aggregate = jest.fn((pipeline: Row[]) => {
        if ('$vectorSearch' in pipeline[0]) return this.vectorSearch(pipeline[0].$vectorSearch);
        return this.listDocuments(pipeline);
    });
    readonly find = jest.fn((filter: Row) => {
        return new Cursor(
            [...this.rows.values()].filter(row =>
                Object.entries(filter).every(([key, value]) => readPath(row, key) === value)
            )
        );
    });

    constructor(
        private readonly database: FakeDatabase,
        private readonly name: string
    ) {}

    listSearchIndexes(): Cursor<Row> {
        return new Cursor([{ queryable: true }]);
    }

    private vectorSearch(stage: Row): Cursor<Row> {
        const rows = [...this.rows.values()]
            .filter(row => matchesMetadata(row, stage.filter))
            .map(row => ({
                document_id: row.document_id,
                chunk: row.chunk,
                score: cosine(stage.queryVector, row.vector),
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, stage.limit);
        return new Cursor(rows);
    }

    private listDocuments(pipeline: Row[]): Cursor<Row> {
        let rows = [...this.rows.values()];
        const match = pipeline.find(stage => stage.$match)?.$match;
        if (match) {
            rows = rows.filter(row =>
                Object.entries(match).every(([key, value]) => readPath(row, key) === value)
            );
        }
        const summaries = new Map<string, Row>();
        for (const row of rows) {
            const documentId = String(row.document_id);
            const current = summaries.get(documentId);
            if (current) current.chunk_count++;
            else {
                summaries.set(documentId, {
                    _id: documentId,
                    source: row.chunk.source,
                    metadata: row.chunk.metadata,
                    chunk_count: 1,
                });
            }
        }
        return new Cursor([...summaries.values()]);
    }
}

class FakeDatabase {
    readonly collections = new Map<string, FakeCollection>();
    readonly createCollection = jest.fn(async (name: string) => {
        const collection = new FakeCollection(this, name);
        this.collections.set(name, collection);
        return collection;
    });

    listCollections(filter: Row): Cursor<Row> {
        return new Cursor(
            [...this.collections.keys()]
                .filter(name => !filter.name || name === filter.name)
                .map(name => ({ name }))
        );
    }

    collection(name: string): FakeCollection {
        let collection = this.collections.get(name);
        if (!collection) {
            collection = new FakeCollection(this, name);
            this.collections.set(name, collection);
        }
        return collection;
    }
}

class FakeClient implements MongoDBClientLike {
    readonly database = new FakeDatabase();
    readonly close = jest.fn(async () => undefined);

    db(): any {
        return this.database;
    }
}

function record(
    documentId: string,
    chunkIndex: number,
    vector: number[] = [1, 0, 0],
    metadata: Record<string, unknown> = {},
    totalChunks = 1
): VectorRecord {
    return {
        vector,
        document_id: documentId,
        chunk: {
            content: TextBlock({ text: `${documentId}-chunk${chunkIndex}` }),
            source: String(metadata.filename ?? `${documentId}.txt`),
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            metadata,
        },
    };
}

function store(client = new FakeClient()): { client: FakeClient; store: MongoDBStore } {
    return {
        client,
        store: new MongoDBStore({ uri: 'mongodb://mock', database: 'test-db', client }),
    };
}

describe('MongoDBStore Python parity', () => {
    test('manages collections and creates the exact vector index definition', async () => {
        const fixture = store();
        expect(await fixture.store.hasCollection('kb-1')).toBe(false);
        await fixture.store.createCollection('kb-1', 3);
        expect(await fixture.store.hasCollection('kb-1')).toBe(true);
        const collection = fixture.client.database.collection('kb-1');
        expect(collection.createSearchIndex).toHaveBeenCalledWith({
            definition: {
                fields: [
                    {
                        type: 'vector',
                        path: 'vector',
                        numDimensions: 3,
                        similarity: 'cosine',
                    },
                    { type: 'filter', path: 'document_id' },
                ],
            },
            name: 'vector_index',
            type: 'vectorSearch',
        });
        await fixture.store.createCollection('kb-1', 3);
        expect(collection.createSearchIndex).toHaveBeenCalledTimes(1);
        await fixture.store.deleteCollection('kb-1');
        expect(await fixture.store.hasCollection('kb-1')).toBe(false);
    });

    test('inserts with stable replacement IDs and skips an empty batch', async () => {
        const fixture = store();
        await fixture.store.createCollection('kb-1', 3);
        const collection = fixture.client.database.collection('kb-1');
        await fixture.store.insert('kb-1', [record('doc-1', 0), record('doc-1', 1)]);
        expect(collection.bulkWrite).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    replaceOne: expect.objectContaining({
                        filter: { _id: 'doc-1_0' },
                        replacement: expect.objectContaining({ _id: 'doc-1_0' }),
                        upsert: true,
                    }),
                }),
                expect.objectContaining({
                    replaceOne: expect.objectContaining({ filter: { _id: 'doc-1_1' } }),
                }),
            ],
            { ordered: false }
        );
        await fixture.store.insert('kb-1', []);
        expect(collection.bulkWrite).toHaveBeenCalledTimes(1);
    });

    test('searches in similarity order and emits the MongoDB vector pipeline', async () => {
        const fixture = store();
        await fixture.store.createCollection('kb-1', 3);
        await fixture.store.insert('kb-1', [
            record('doc-1', 0, [1, 0, 0]),
            record('doc-1', 1, [0, 1, 0]),
        ]);
        expect(await fixture.store.search('kb-1', [1, 0, 0], 2)).toEqual([
            expect.objectContaining({ score: 1, document_id: 'doc-1' }),
            expect.objectContaining({ score: 0, document_id: 'doc-1' }),
        ]);
        const pipeline = fixture.client.database.collection('kb-1').aggregate.mock.calls.at(-1)![0];
        expect(pipeline).toEqual([
            {
                $vectorSearch: {
                    index: 'vector_index',
                    path: 'vector',
                    queryVector: [1, 0, 0],
                    numCandidates: 100,
                    limit: 2,
                },
            },
            {
                $project: {
                    document_id: 1,
                    chunk: 1,
                    score: { $meta: 'vectorSearchScore' },
                },
            },
        ]);
    });

    test('deletes all chunks of only the requested document', async () => {
        const fixture = store();
        await fixture.store.createCollection('kb-1', 3);
        await fixture.store.insert('kb-1', [
            record('doc-1', 0),
            record('doc-1', 1),
            record('doc-2', 0, [0, 1, 0]),
        ]);
        await fixture.store.delete('kb-1', 'doc-1');
        expect(
            (await fixture.store.search('kb-1', [1, 0, 0], 5)).map(row => row.document_id)
        ).toEqual(['doc-2']);
    });

    test('applies metadata filters to search and document listing', async () => {
        const fixture = store();
        await fixture.store.createCollection('kb-1', 3);
        await fixture.store.insert('kb-1', [
            record('doc-1', 0, [1, 0, 0], { tenant: 'a', filename: 'alpha.txt' }, 2),
            record('doc-1', 1, [1, 0, 0], { tenant: 'a', filename: 'alpha.txt' }, 2),
            record('doc-2', 0, [1, 0, 0], { tenant: 'b', filename: 'beta.txt' }),
        ]);
        const results = await fixture.store.search('kb-1', [1, 0, 0], 5, { tenant: 'a' });
        expect(results).toHaveLength(2);
        expect(
            fixture.client.database.collection('kb-1').aggregate.mock.calls.at(-1)![0][0]
        ).toEqual({
            $vectorSearch: expect.objectContaining({
                filter: {
                    $and: [{ 'chunk.metadata.tenant': { $eq: 'a' } }],
                },
            }),
        });
        expect(await fixture.store.listDocuments('kb-1', { tenant: 'a' })).toEqual([
            {
                document_id: 'doc-1',
                source: 'alpha.txt',
                chunk_count: 2,
                metadata: { tenant: 'a', filename: 'alpha.txt' },
            },
        ]);
    });

    test('lists ordered, paginated, tenant-isolated chunks', async () => {
        const fixture = store();
        await fixture.store.createCollection('kb-1', 3);
        await fixture.store.insert('kb-1', [
            ...[3, 0, 4, 1, 2].map(index => record('doc-1', index, [1, 0, 0], { tenant: 'a' }, 5)),
            record('doc-2', 0),
        ]);
        expect(
            (
                await fixture.store.listChunks('kb-1', 'doc-1', {
                    offset: 1,
                    limit: 3,
                    metadata_filter: { tenant: 'a' },
                })
            ).map(chunk => chunk.chunk_index)
        ).toEqual([1, 2, 3]);
        expect(
            await fixture.store.listChunks('kb-1', 'doc-1', {
                metadata_filter: { tenant: 'b' },
            })
        ).toEqual([]);
        expect(await fixture.store.listChunks('kb-1', 'doc-1', { limit: 0 })).toEqual([]);
    });

    test('buildMetadataFilter matches the Python flat-filter translation', () => {
        expect(MongoDBStore.buildMetadataFilter(null)).toBeNull();
        expect(MongoDBStore.buildMetadataFilter({ tenant: 'a', active: true })).toEqual({
            $and: [
                { 'chunk.metadata.tenant': { $eq: 'a' } },
                { 'chunk.metadata.active': { $eq: true } },
            ],
        });
    });

    test('does not close an injected client', async () => {
        const fixture = store();
        await fixture.store.close();
        expect(fixture.client.close).not.toHaveBeenCalled();
    });
});

function readPath(value: unknown, path: string): any {
    let current: any = value;
    for (const part of path.split('.')) current = current?.[part];
    return current;
}

function matchesMetadata(row: Row, filter: Row | undefined): boolean {
    return (filter?.$and ?? []).every((condition: Row) =>
        Object.entries(condition).every(
            ([path, comparison]) => readPath(row, path) === (comparison as Row).$eq
        )
    );
}

function cosine(left: number[], right: number[]): number {
    const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
    const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
    const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
