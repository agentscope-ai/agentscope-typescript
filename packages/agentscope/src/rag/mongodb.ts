/* eslint-disable jsdoc/require-jsdoc */

import type { Chunk } from './document';
import {
    VectorStoreBase,
    type ChunkListOptions,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
} from './vector-store';

export type MongoDBDistance = 'cosine' | 'euclidean' | 'dotProduct';

type MongoDocument = Record<string, unknown>;

interface MongoCursorLike<T = MongoDocument> extends AsyncIterable<T> {
    toArray?: () => Promise<T[]>;
    sort?: (key: string, direction: number) => MongoCursorLike<T>;
    skip?: (count: number) => MongoCursorLike<T>;
    limit?: (count: number) => MongoCursorLike<T>;
}

interface MongoCollectionLike {
    createSearchIndex(model: Record<string, unknown>): Promise<unknown>;
    listSearchIndexes(options?: Record<string, unknown>): MongoCursorLike;
    drop(): Promise<unknown>;
    bulkWrite(
        operations: Array<Record<string, unknown>>,
        options?: Record<string, unknown>
    ): Promise<unknown>;
    deleteMany(filter: Record<string, unknown>): Promise<unknown>;
    aggregate(pipeline: Array<Record<string, unknown>>): MongoCursorLike;
    find(filter: Record<string, unknown>, options?: Record<string, unknown>): MongoCursorLike;
}

interface MongoDatabaseLike {
    listCollections(
        filter?: Record<string, unknown>,
        options?: Record<string, unknown>
    ): MongoCursorLike;
    createCollection(name: string): Promise<unknown>;
    collection(name: string): MongoCollectionLike;
}

export interface MongoDBClientLike {
    db(name: string): MongoDatabaseLike;
    close(): Promise<void>;
}

export interface MongoDBStoreOptions {
    uri: string;
    database: string;
    distance?: MongoDBDistance;
    index_name?: string;
    filter_fields?: string[] | null;
    client_kwargs?: Record<string, unknown>;
    client?: MongoDBClientLike;
}

/** MongoDB Vector Search store for Atlas and compatible self-hosted servers. */
export class MongoDBStore extends VectorStoreBase {
    private readonly uri: string;
    private readonly databaseName: string;
    private readonly distance: MongoDBDistance;
    private readonly indexName: string;
    private readonly filterFields: string[];
    private readonly clientKwargs: Record<string, unknown>;
    private client: MongoDBClientLike | null;
    private ownsClient: boolean;

    constructor(options: MongoDBStoreOptions) {
        super();
        this.uri = options.uri;
        this.databaseName = options.database;
        this.distance = options.distance ?? 'cosine';
        this.indexName = options.index_name ?? 'vector_index';
        this.filterFields = options.filter_fields?.length
            ? [...options.filter_fields]
            : ['document_id'];
        this.clientKwargs = { ...(options.client_kwargs ?? {}) };
        this.client = options.client ?? null;
        this.ownsClient = options.client === undefined;
    }

    async getClient(): Promise<MongoDBClientLike> {
        if (!this.client) {
            let module: typeof import('mongodb');
            try {
                module = await import('mongodb');
            } catch (error) {
                throw new Error('MongoDBStore requires the optional mongodb package.', {
                    cause: error,
                });
            }
            this.client = new module.MongoClient(
                this.uri,
                this.clientKwargs
            ) as unknown as MongoDBClientLike;
            this.ownsClient = true;
        }
        return this.client;
    }

    override async close(): Promise<void> {
        if (this.client && this.ownsClient) await this.client.close();
        this.client = null;
    }

    async createCollection(name: string, dimensions: number): Promise<void> {
        if (await this.hasCollection(name)) return;
        const database = await this.database();
        await database.createCollection(name);
        const collection = database.collection(name);
        await collection.createSearchIndex({
            definition: {
                fields: [
                    {
                        type: 'vector',
                        path: 'vector',
                        numDimensions: dimensions,
                        similarity: this.distance,
                    },
                    ...this.filterFields.map(path => ({ type: 'filter', path })),
                ],
            },
            name: this.indexName,
            type: 'vectorSearch',
        });
        await this.waitForIndexReady(collection, name);
    }

    async deleteCollection(name: string): Promise<void> {
        await (await this.collection(name)).drop();
    }

    async hasCollection(name: string): Promise<boolean> {
        const cursor = (await this.database()).listCollections({ name }, { nameOnly: true });
        return (await cursorItems(cursor)).length > 0;
    }

    async insert(collection: string, records: VectorRecord[]): Promise<void> {
        if (!records.length) return;
        await (
            await this.collection(collection)
        ).bulkWrite(
            records.map(record => {
                const id = `${record.document_id}_${record.chunk.chunk_index}`;
                return {
                    replaceOne: {
                        filter: { _id: id },
                        replacement: {
                            _id: id,
                            document_id: record.document_id,
                            vector: record.vector,
                            chunk: record.chunk,
                        },
                        upsert: true,
                    },
                };
            }),
            { ordered: false }
        );
    }

    async delete(collection: string, documentId: string): Promise<void> {
        await (await this.collection(collection)).deleteMany({ document_id: documentId });
    }

    async search(
        collection: string,
        queryVector: number[],
        topK = 5,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<VectorSearchResult[]> {
        const target = await this.collection(collection);
        await this.waitForIndexReady(target, collection);
        const vectorSearch: Record<string, unknown> = {
            index: this.indexName,
            path: 'vector',
            queryVector,
            numCandidates: Math.max(100, topK * 20),
            limit: topK,
        };
        const filter = MongoDBStore.buildMetadataFilter(metadataFilter);
        if (filter) vectorSearch.filter = filter;
        const rows = await cursorItems(
            target.aggregate([
                { $vectorSearch: vectorSearch },
                {
                    $project: {
                        document_id: 1,
                        chunk: 1,
                        score: { $meta: 'vectorSearchScore' },
                    },
                },
            ])
        );
        return rows.map(row => ({
            score: Number(row.score),
            document_id: String(row.document_id),
            chunk: row.chunk as Chunk,
        }));
    }

    async listDocuments(
        collection: string,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<DocumentSummary[]> {
        const pipeline: Array<Record<string, unknown>> = [];
        if (metadataFilter && Object.keys(metadataFilter).length) {
            pipeline.push({
                $match: Object.fromEntries(
                    Object.entries(metadataFilter).map(([key, value]) => [
                        `chunk.metadata.${key}`,
                        value,
                    ])
                ),
            });
        }
        pipeline.push({
            $group: {
                _id: '$document_id',
                source: { $first: '$chunk.source' },
                metadata: { $first: '$chunk.metadata' },
                chunk_count: { $sum: 1 },
            },
        });
        const rows = await cursorItems((await this.collection(collection)).aggregate(pipeline));
        return rows.map(row => ({
            document_id: String(row._id),
            source: String(row.source),
            chunk_count: Number(row.chunk_count),
            metadata: (row.metadata as Record<string, unknown> | null) ?? {},
        }));
    }

    override async listChunks(
        collection: string,
        documentId: string,
        options: ChunkListOptions = {}
    ): Promise<Chunk[]> {
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 30;
        if (limit <= 0) return [];
        const query: Record<string, unknown> = { document_id: documentId };
        for (const [key, value] of Object.entries(options.metadata_filter ?? {})) {
            query[`chunk.metadata.${key}`] = value;
        }
        let cursor = (await this.collection(collection)).find(query, {
            projection: { chunk: true },
        });
        cursor = cursor.sort?.('chunk.chunk_index', 1) ?? cursor;
        cursor = cursor.skip?.(offset) ?? cursor;
        cursor = cursor.limit?.(limit) ?? cursor;
        return (await cursorItems(cursor)).map(row => row.chunk as Chunk);
    }

    static buildMetadataFilter(
        metadataFilter?: Record<string, unknown> | null
    ): Record<string, unknown> | null {
        if (!metadataFilter || !Object.keys(metadataFilter).length) return null;
        return {
            $and: Object.entries(metadataFilter).map(([key, value]) => ({
                [`chunk.metadata.${key}`]: { $eq: value },
            })),
        };
    }

    private async database(): Promise<MongoDatabaseLike> {
        return (await this.getClient()).db(this.databaseName);
    }

    private async collection(name: string): Promise<MongoCollectionLike> {
        return (await this.database()).collection(name);
    }

    private async waitForIndexReady(
        collection: MongoCollectionLike,
        collectionName: string,
        timeoutMs = 30_000
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const indexes = await cursorItems(
                collection.listSearchIndexes({ name: this.indexName })
            );
            if (indexes.some(index => index.queryable)) return;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(
            `Vector search index '${this.indexName}' on collection '${collectionName}' ` +
                `was not queryable within ${timeoutMs / 1000}s`
        );
    }
}

async function cursorItems<T>(cursor: MongoCursorLike<T>): Promise<T[]> {
    if (cursor.toArray) return cursor.toArray();
    const items: T[] = [];
    for await (const item of cursor) items.push(item);
    return items;
}
