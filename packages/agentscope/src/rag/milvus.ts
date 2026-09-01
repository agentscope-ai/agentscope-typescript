/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

import type { Chunk } from './document';
import {
    VectorStoreBase,
    type ChunkListOptions,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
} from './vector-store';

export type MilvusMetric = 'COSINE' | 'IP' | 'L2';

interface MilvusRow {
    id: string;
    vector: number[];
    document_id: string;
    chunk: Chunk;
    metadata: Record<string, unknown>;
}

export interface MilvusDriver {
    close(): Promise<void>;
    hasCollection(name: string): Promise<boolean>;
    createCollection(
        name: string,
        dimensions: number,
        metric: MilvusMetric,
        indexType: string
    ): Promise<void>;
    loadCollection(name: string): Promise<void>;
    dropCollection(name: string): Promise<void>;
    upsert(collection: string, rows: MilvusRow[]): Promise<void>;
    deleteDocument(collection: string, documentId: string): Promise<void>;
    search(
        collection: string,
        vector: number[],
        topK: number,
        metric: MilvusMetric,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Array<{ score: number; document_id: string; chunk: Chunk }>>;
    listRows(
        collection: string,
        metadataFilter: Record<string, unknown> | null
    ): Promise<MilvusRow[]>;
    listChunks(
        collection: string,
        documentId: string,
        offset: number,
        limit: number,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Chunk[]>;
}

export interface MilvusLiteStoreOptions {
    uri?: string;
    metric_type?: MilvusMetric;
    index_type?: string;
    client_kwargs?: Record<string, unknown>;
    batch_size?: number;
    driver?: MilvusDriver;
}

/** Milvus-compatible vector store with a persistent local TypeScript backend. */
export class MilvusLiteStore extends VectorStoreBase {
    private readonly uri: string;
    private readonly metricType: MilvusMetric;
    private readonly indexType: string;
    private readonly clientKwargs: Record<string, unknown>;
    private readonly batchSize: number;
    private driver: MilvusDriver | null;
    private ownsDriver: boolean;

    constructor(options: MilvusLiteStoreOptions = {}) {
        super();
        this.uri = options.uri ?? './agentscope_milvus_lite.db';
        this.metricType = options.metric_type ?? 'COSINE';
        this.indexType = options.index_type ?? 'AUTOINDEX';
        this.clientKwargs = { ...(options.client_kwargs ?? {}) };
        this.batchSize = options.batch_size ?? 256;
        if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
            throw new Error('batch_size must be a positive integer');
        }
        this.driver = options.driver ?? null;
        this.ownsDriver = options.driver === undefined;
    }

    async getDriver(): Promise<MilvusDriver> {
        if (!this.driver) {
            this.driver = MilvusLiteStore.isLocalDbUri(this.uri)
                ? new LocalMilvusDriver(this.uri)
                : await MilvusSdkDriver.create(this.uri, this.clientKwargs, this.batchSize);
            this.ownsDriver = true;
        }
        return this.driver;
    }

    override async close(): Promise<void> {
        if (this.driver && this.ownsDriver) await this.driver.close();
        this.driver = null;
    }

    async createCollection(name: string, dimensions: number): Promise<void> {
        const driver = await this.getDriver();
        if (await driver.hasCollection(name)) {
            await driver.loadCollection(name);
            return;
        }
        await driver.createCollection(name, dimensions, this.metricType, this.indexType);
        await driver.loadCollection(name);
    }

    async deleteCollection(name: string): Promise<void> {
        await (await this.getDriver()).dropCollection(name);
    }

    async hasCollection(name: string): Promise<boolean> {
        return (await this.getDriver()).hasCollection(name);
    }

    async insert(collection: string, records: VectorRecord[]): Promise<void> {
        const driver = await this.getDriver();
        for (let start = 0; start < records.length; start += this.batchSize) {
            await driver.upsert(
                collection,
                records.slice(start, start + this.batchSize).map(record => ({
                    id: MilvusLiteStore.recordId(record),
                    vector: record.vector,
                    document_id: record.document_id,
                    chunk: record.chunk,
                    metadata: record.chunk.metadata,
                }))
            );
        }
    }

    async delete(collection: string, documentId: string): Promise<void> {
        await (await this.getDriver()).deleteDocument(collection, documentId);
    }

    async search(
        collection: string,
        queryVector: number[],
        topK = 5,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<VectorSearchResult[]> {
        return (await this.getDriver()).search(
            collection,
            queryVector,
            topK,
            this.metricType,
            metadataFilter
        );
    }

    async listDocuments(
        collection: string,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<DocumentSummary[]> {
        const rows = await (await this.getDriver()).listRows(collection, metadataFilter);
        const summaries = new Map<string, DocumentSummary>();
        const seen = new Set<string>();
        for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            const summary = summaries.get(row.document_id);
            if (summary) summary.chunk_count++;
            else
                summaries.set(row.document_id, {
                    document_id: row.document_id,
                    source: row.chunk.source ?? '',
                    chunk_count: 1,
                    metadata: { ...(row.chunk.metadata ?? {}) },
                });
        }
        return [...summaries.values()];
    }

    override async listChunks(
        collection: string,
        documentId: string,
        options: ChunkListOptions = {}
    ): Promise<Chunk[]> {
        const limit = options.limit ?? 30;
        if (limit <= 0) return [];
        const chunks = await (
            await this.getDriver()
        ).listChunks(
            collection,
            documentId,
            options.offset ?? 0,
            limit,
            options.metadata_filter ?? null
        );
        const byIndex = new Map<number, Chunk>();
        for (const chunk of chunks)
            if (!byIndex.has(chunk.chunk_index)) byIndex.set(chunk.chunk_index, chunk);
        return [...byIndex.values()]
            .sort((left, right) => left.chunk_index - right.chunk_index)
            .slice(0, limit);
    }

    static recordId(record: VectorRecord): string {
        return createHash('sha256')
            .update(`${record.document_id}\0${record.chunk.chunk_index}`, 'utf8')
            .digest('hex');
    }

    static buildDocumentFilter(documentId: string): string {
        return `document_id == ${JSON.stringify(documentId)}`;
    }

    static buildMetadataFilter(metadataFilter?: Record<string, unknown> | null): string {
        return Object.entries(metadataFilter ?? {})
            .map(([key, value]) => `metadata[${JSON.stringify(key)}] == ${JSON.stringify(value)}`)
            .join(' and ');
    }

    static extractScore(hit: Record<string, unknown>): number {
        if ('distance' in hit) return Number(hit.distance);
        if ('score' in hit) return Number(hit.score);
        return 0;
    }

    static isLocalDbUri(uri: string): boolean {
        return !uri.startsWith('http://') && !uri.startsWith('https://') && extname(uri) === '.db';
    }
}

interface LocalState {
    collections: Record<string, { dimensions: number; records: Record<string, MilvusRow> }>;
}

class LocalMilvusDriver implements MilvusDriver {
    private state: LocalState | null = null;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly path: string) {}

    async close(): Promise<void> {
        await this.writeQueue;
    }

    async hasCollection(name: string): Promise<boolean> {
        return Boolean((await this.load()).collections[name]);
    }

    async createCollection(name: string, dimensions: number): Promise<void> {
        const state = await this.load();
        state.collections[name] ??= { dimensions, records: {} };
        await this.persist();
    }

    async loadCollection(_name: string): Promise<void> {}

    async dropCollection(name: string): Promise<void> {
        delete (await this.load()).collections[name];
        await this.persist();
    }

    async upsert(collection: string, rows: MilvusRow[]): Promise<void> {
        const target = this.collection(await this.load(), collection);
        for (const row of rows) {
            if (row.vector.length !== target.dimensions) {
                throw new Error(
                    `Vector dimension mismatch: expected ${target.dimensions}, got ${row.vector.length}`
                );
            }
            target.records[row.id] = structuredClone(row);
        }
        await this.persist();
    }

    async deleteDocument(collection: string, documentId: string): Promise<void> {
        const target = this.collection(await this.load(), collection);
        for (const [id, row] of Object.entries(target.records)) {
            if (row.document_id === documentId) delete target.records[id];
        }
        await this.persist();
    }

    async search(
        collection: string,
        vector: number[],
        topK: number,
        metric: MilvusMetric,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Array<{ score: number; document_id: string; chunk: Chunk }>> {
        if (topK <= 0) return [];
        const rows = Object.values(this.collection(await this.load(), collection).records)
            .filter(row => metadataMatches(row.metadata, metadataFilter))
            .map(row => ({
                score: vectorScore(vector, row.vector, metric),
                document_id: row.document_id,
                chunk: structuredClone(row.chunk),
            }));
        rows.sort((left, right) =>
            metric === 'L2' ? left.score - right.score : right.score - left.score
        );
        return rows.slice(0, topK);
    }

    async listRows(
        collection: string,
        metadataFilter: Record<string, unknown> | null
    ): Promise<MilvusRow[]> {
        return Object.values(this.collection(await this.load(), collection).records)
            .filter(row => metadataMatches(row.metadata, metadataFilter))
            .map(row => structuredClone(row));
    }

    async listChunks(
        collection: string,
        documentId: string,
        offset: number,
        limit: number,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Chunk[]> {
        return Object.values(this.collection(await this.load(), collection).records)
            .filter(row => row.document_id === documentId)
            .filter(row => metadataMatches(row.metadata, metadataFilter))
            .map(row => row.chunk)
            .filter(chunk => chunk.chunk_index >= offset && chunk.chunk_index < offset + limit)
            .map(chunk => structuredClone(chunk));
    }

    private async load(): Promise<LocalState> {
        if (this.state) return this.state;
        try {
            this.state = JSON.parse(await readFile(this.path, 'utf8')) as LocalState;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.state = { collections: {} };
        }
        return this.state;
    }

    private collection(state: LocalState, name: string): LocalState['collections'][string] {
        const collection = state.collections[name];
        if (!collection) throw new Error(`Milvus collection does not exist: ${name}`);
        return collection;
    }

    private async persist(): Promise<void> {
        const snapshot = JSON.stringify(this.state);
        this.writeQueue = this.writeQueue.then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            const temporary = `${this.path}.${process.pid}.tmp`;
            await writeFile(temporary, snapshot, 'utf8');
            await rename(temporary, this.path);
        });
        await this.writeQueue;
    }
}

class MilvusSdkDriver implements MilvusDriver {
    private constructor(
        private readonly client: Record<string, (...args: unknown[]) => Promise<unknown> | void>,
        private readonly dataType: Record<string, unknown>,
        private readonly batchSize: number
    ) {}

    static async create(
        uri: string,
        kwargs: Record<string, unknown>,
        batchSize: number
    ): Promise<MilvusSdkDriver> {
        let module: typeof import('@zilliz/milvus2-sdk-node');
        try {
            module = await import('@zilliz/milvus2-sdk-node');
        } catch (error) {
            throw new Error(
                'Remote Milvus requires the optional @zilliz/milvus2-sdk-node package.',
                { cause: error }
            );
        }
        const client = new module.MilvusClient({ address: uri, ...kwargs });
        return new MilvusSdkDriver(
            client as unknown as Record<string, (...args: unknown[]) => Promise<unknown> | void>,
            module.DataType as unknown as Record<string, unknown>,
            batchSize
        );
    }

    async close(): Promise<void> {
        await this.client.close();
    }

    async hasCollection(name: string): Promise<boolean> {
        const response = (await this.client.hasCollection({ collection_name: name })) as Record<
            string,
            unknown
        >;
        return Boolean(response.value);
    }

    async createCollection(
        name: string,
        dimensions: number,
        metric: MilvusMetric,
        indexType: string
    ): Promise<void> {
        await this.client.createCollection({
            collection_name: name,
            enable_dynamic_field: false,
            schema: [
                {
                    name: 'id',
                    data_type: this.dataType.VarChar,
                    is_primary_key: true,
                    autoID: false,
                    max_length: 64,
                },
                { name: 'vector', data_type: this.dataType.FloatVector, dim: dimensions },
                { name: 'document_id', data_type: this.dataType.VarChar, max_length: 512 },
                { name: 'chunk', data_type: this.dataType.JSON },
                { name: 'metadata', data_type: this.dataType.JSON },
            ],
            index_params: [{ field_name: 'vector', index_type: indexType, metric_type: metric }],
        });
    }

    async loadCollection(name: string): Promise<void> {
        await this.client.loadCollection({ collection_name: name });
    }

    async dropCollection(name: string): Promise<void> {
        await this.client.dropCollection({ collection_name: name });
    }

    async upsert(collection: string, rows: MilvusRow[]): Promise<void> {
        await this.client.upsert({ collection_name: collection, data: rows });
    }

    async deleteDocument(collection: string, documentId: string): Promise<void> {
        await this.client.delete({
            collection_name: collection,
            filter: MilvusLiteStore.buildDocumentFilter(documentId),
        });
    }

    async search(
        collection: string,
        vector: number[],
        topK: number,
        metric: MilvusMetric,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Array<{ score: number; document_id: string; chunk: Chunk }>> {
        const response = (await this.client.search({
            collection_name: collection,
            data: [vector],
            anns_field: 'vector',
            limit: topK,
            filter: MilvusLiteStore.buildMetadataFilter(metadataFilter),
            output_fields: ['document_id', 'chunk'],
            metric_type: metric,
        })) as Record<string, unknown>;
        const raw = Array.isArray(response.results) ? response.results : [];
        const hits = Array.isArray(raw[0]) ? raw[0] : raw;
        return (hits as Array<Record<string, unknown>>).map(hit => ({
            score: MilvusLiteStore.extractScore(hit),
            document_id: String(
                hit.document_id ?? (hit.entity as Record<string, unknown>)?.document_id
            ),
            chunk: (hit.chunk ?? (hit.entity as Record<string, unknown>)?.chunk) as Chunk,
        }));
    }

    async listRows(
        collection: string,
        metadataFilter: Record<string, unknown> | null
    ): Promise<MilvusRow[]> {
        const rows: MilvusRow[] = [];
        let offset = 0;
        while (true) {
            const response = (await this.client.query({
                collection_name: collection,
                filter: MilvusLiteStore.buildMetadataFilter(metadataFilter),
                output_fields: ['id', 'vector', 'document_id', 'chunk', 'metadata'],
                limit: this.batchSize,
                offset,
            })) as Record<string, unknown>;
            const batch = (Array.isArray(response.data) ? response.data : []) as MilvusRow[];
            rows.push(...batch);
            if (batch.length < this.batchSize) break;
            offset += this.batchSize;
        }
        return rows;
    }

    async listChunks(
        collection: string,
        documentId: string,
        offset: number,
        limit: number,
        metadataFilter: Record<string, unknown> | null
    ): Promise<Chunk[]> {
        const clauses = [
            MilvusLiteStore.buildDocumentFilter(documentId),
            `chunk["chunk_index"] >= ${offset}`,
            `chunk["chunk_index"] < ${offset + limit}`,
            MilvusLiteStore.buildMetadataFilter(metadataFilter),
        ].filter(Boolean);
        const response = (await this.client.query({
            collection_name: collection,
            filter: clauses.join(' and '),
            output_fields: ['chunk'],
            limit: 16_384,
        })) as Record<string, unknown>;
        return (
            (Array.isArray(response.data) ? response.data : []) as Array<Record<string, unknown>>
        ).map(row => row.chunk as Chunk);
    }
}

function metadataMatches(
    metadata: Record<string, unknown>,
    filter: Record<string, unknown> | null
): boolean {
    return Object.entries(filter ?? {}).every(([key, value]) => Object.is(metadata[key], value));
}

function vectorScore(left: number[], right: number[], metric: MilvusMetric): number {
    if (left.length !== right.length) throw new Error('Vector dimensions must match');
    if (metric === 'IP') return left.reduce((sum, value, index) => sum + value * right[index], 0);
    if (metric === 'L2')
        return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0));
    const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
    const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
    const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
