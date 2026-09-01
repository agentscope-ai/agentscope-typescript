/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';

import type { Chunk } from './document';
import {
    VectorStoreBase,
    type ChunkListOptions,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
} from './vector-store';

type ElasticResponse = Record<string, unknown>;

export interface ElasticsearchClientLike {
    indices: {
        exists(options: Record<string, unknown>): Promise<unknown>;
        create(options: Record<string, unknown>): Promise<unknown>;
        delete(options: Record<string, unknown>): Promise<unknown>;
    };
    bulk(options: Record<string, unknown>): Promise<ElasticResponse>;
    deleteByQuery(options: Record<string, unknown>): Promise<unknown>;
    search(options: Record<string, unknown>): Promise<ElasticResponse>;
    openPointInTime(options: Record<string, unknown>): Promise<ElasticResponse>;
    closePointInTime(options: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}

export interface ElasticsearchStoreOptions {
    hosts: string | string[];
    num_candidates?: number;
    refresh?: boolean | 'wait_for';
    client_kwargs?: Record<string, unknown>;
    client?: ElasticsearchClientLike;
}

/** Elasticsearch dense-vector store with deterministic record IDs. */
export class ElasticsearchStore extends VectorStoreBase {
    private readonly hosts: string | string[];
    private readonly numCandidates: number;
    private readonly refresh: boolean | 'wait_for';
    private readonly clientKwargs: Record<string, unknown>;
    private client: ElasticsearchClientLike | null;
    private ownsClient: boolean;

    constructor(options: ElasticsearchStoreOptions) {
        super();
        const numCandidates = options.num_candidates ?? 100;
        if (numCandidates <= 0 || numCandidates > 10_000) {
            throw new Error('num_candidates must be between 1 and 10000');
        }
        this.hosts = options.hosts;
        this.numCandidates = numCandidates;
        this.refresh = options.refresh ?? 'wait_for';
        this.clientKwargs = { ...(options.client_kwargs ?? {}) };
        this.client = options.client ?? null;
        this.ownsClient = options.client === undefined;
    }

    async getClient(): Promise<ElasticsearchClientLike> {
        if (!this.client) {
            let module: typeof import('@elastic/elasticsearch');
            try {
                module = await import('@elastic/elasticsearch');
            } catch (error) {
                throw new Error(
                    'ElasticsearchStore requires the optional @elastic/elasticsearch package.',
                    { cause: error }
                );
            }
            const connection = Array.isArray(this.hosts)
                ? { nodes: this.hosts }
                : { node: this.hosts };
            this.client = new module.Client({
                ...connection,
                ...this.clientKwargs,
            }) as unknown as ElasticsearchClientLike;
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
        const client = await this.getClient();
        await client.indices.create({
            index: name,
            mappings: {
                dynamic: false,
                properties: {
                    vector: {
                        type: 'dense_vector',
                        dims: dimensions,
                        index: true,
                        similarity: 'cosine',
                    },
                    document_id: { type: 'keyword' },
                    chunk: { type: 'object', enabled: false },
                    metadata: { type: 'object', dynamic: 'runtime' },
                },
            },
        });
    }

    async deleteCollection(name: string): Promise<void> {
        await (await this.getClient()).indices.delete({ index: name });
    }

    async hasCollection(name: string): Promise<boolean> {
        return Boolean(await (await this.getClient()).indices.exists({ index: name }));
    }

    async insert(collection: string, records: VectorRecord[]): Promise<void> {
        if (!records.length) return;
        const operations = records.flatMap(record => [
            { index: { _index: collection, _id: ElasticsearchStore.recordId(record) } },
            {
                vector: record.vector,
                document_id: record.document_id,
                chunk: record.chunk,
                metadata: record.chunk.metadata,
            },
        ]);
        const response = await (
            await this.getClient()
        ).bulk({
            operations,
            refresh: this.refresh,
        });
        if (response.errors) {
            const items = Array.isArray(response.items) ? response.items : [];
            const failures = items.filter(item => {
                const operation = Object.values(item as Record<string, unknown>)[0];
                return operation && typeof operation === 'object' && 'error' in operation;
            });
            throw new Error(`Elasticsearch bulk insert failed for ${failures.length} record(s)`);
        }
    }

    async delete(collection: string, documentId: string): Promise<void> {
        await (
            await this.getClient()
        ).deleteByQuery({
            index: collection,
            query: { term: { document_id: documentId } },
            conflicts: 'proceed',
            refresh: this.refresh !== false,
        });
    }

    async search(
        collection: string,
        queryVector: number[],
        topK = 5,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<VectorSearchResult[]> {
        if (topK <= 0) return [];
        if (topK > 10_000) throw new Error("top_k cannot exceed Elasticsearch's 10000 limit");
        const knn: Record<string, unknown> = {
            field: 'vector',
            query_vector: queryVector,
            k: topK,
            num_candidates: Math.min(Math.max(this.numCandidates, topK), 10_000),
        };
        const filters = ElasticsearchStore.metadataFilters(metadataFilter);
        if (filters.length) knn.filter = filters;
        const response = await (
            await this.getClient()
        ).search({
            index: collection,
            size: topK,
            knn,
            source_includes: ['document_id', 'chunk'],
        });
        return hitsFrom(response).map(hit => {
            const source = hit._source as Record<string, unknown>;
            return {
                score: 2 * Number(hit._score) - 1,
                document_id: String(source.document_id),
                chunk: source.chunk as Chunk,
            };
        });
    }

    async listDocuments(
        collection: string,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<DocumentSummary[]> {
        const summaries: DocumentSummary[] = [];
        let after: Record<string, unknown> | undefined;
        while (true) {
            const composite: Record<string, unknown> = {
                size: 500,
                sources: [{ document_id: { terms: { field: 'document_id' } } }],
            };
            if (after) composite.after = after;
            const response = await (
                await this.getClient()
            ).search({
                index: collection,
                size: 0,
                query: ElasticsearchStore.filterQuery(metadataFilter),
                aggs: {
                    documents: {
                        composite,
                        aggs: { sample: { top_hits: { size: 1, _source: ['chunk'] } } },
                    },
                },
            });
            const documents = ((response.aggregations as Record<string, unknown>)?.documents ??
                {}) as Record<string, unknown>;
            const buckets = Array.isArray(documents.buckets) ? documents.buckets : [];
            for (const bucketValue of buckets) {
                const bucket = bucketValue as Record<string, unknown>;
                const sample = bucket.sample as Record<string, unknown>;
                const hit = hitsFrom(sample)[0];
                const chunk = (hit._source as Record<string, unknown>).chunk as Chunk;
                summaries.push({
                    document_id: String((bucket.key as Record<string, unknown>).document_id),
                    source: chunk.source,
                    chunk_count: Number(bucket.doc_count),
                    metadata: chunk.metadata,
                });
            }
            if (!buckets.length || !documents.after_key) break;
            after = documents.after_key as Record<string, unknown>;
        }
        return summaries;
    }

    override async listChunks(
        collection: string,
        documentId: string,
        options: ChunkListOptions = {}
    ): Promise<Chunk[]> {
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 30;
        if (limit <= 0) return [];
        const filters: Record<string, unknown>[] = [
            { term: { document_id: documentId } },
            ...ElasticsearchStore.metadataFilters(options.metadata_filter),
        ];
        const client = await this.getClient();
        const pit = await client.openPointInTime({ index: collection, keep_alive: '1m' });
        let pitId = String(pit.id);
        const byIndex = new Map<number, Chunk>();
        try {
            let searchAfter: unknown[] | undefined;
            while (true) {
                const request: Record<string, unknown> = {
                    query: { bool: { filter: filters } },
                    size: 1000,
                    pit: { id: pitId, keep_alive: '1m' },
                    sort: [{ _shard_doc: 'asc' }],
                    _source: ['chunk'],
                };
                if (searchAfter) request.search_after = searchAfter;
                const response = await client.search(request);
                const hits = hitsFrom(response);
                if (!hits.length) break;
                for (const hit of hits) {
                    const chunk = (hit._source as Record<string, unknown>).chunk as Chunk;
                    const index = chunk.chunk_index;
                    if (!Number.isInteger(index) || index < offset || index >= offset + limit)
                        continue;
                    if (!byIndex.has(index)) byIndex.set(index, chunk);
                }
                pitId = response.pit_id ? String(response.pit_id) : pitId;
                searchAfter = hits.at(-1)?.sort as unknown[];
            }
        } finally {
            await client.closePointInTime({ id: pitId });
        }
        return [...byIndex.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, chunk]) => chunk);
    }

    static recordId(record: VectorRecord): string {
        return createHash('sha256')
            .update(`${record.document_id}\0${record.chunk.chunk_index}`, 'utf8')
            .digest('hex');
    }

    static metadataFilters(
        metadataFilter?: Record<string, unknown> | null
    ): Record<string, unknown>[] {
        return Object.entries(metadataFilter ?? {}).map(([key, value]) => ({
            term: { [`metadata.${key}`]: value },
        }));
    }

    static filterQuery(metadataFilter?: Record<string, unknown> | null): Record<string, unknown> {
        const filters = ElasticsearchStore.metadataFilters(metadataFilter);
        return filters.length ? { bool: { filter: filters } } : { match_all: {} };
    }
}

function hitsFrom(response: Record<string, unknown>): Array<Record<string, unknown>> {
    const hits = response.hits as Record<string, unknown> | undefined;
    return Array.isArray(hits?.hits) ? (hits.hits as Array<Record<string, unknown>>) : [];
}
