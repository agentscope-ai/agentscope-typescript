/* eslint-disable jsdoc/require-jsdoc */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { v5 as uuidv5 } from 'uuid';

import type { Chunk } from './document';
import {
    VectorStoreBase,
    type ChunkListOptions,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
} from './vector-store';

export type QdrantDistance = 'Cosine' | 'Dot' | 'Euclid' | 'Manhattan';

interface QdrantPoint {
    id: string;
    vector?: number[];
    payload: { document_id: string; chunk: Chunk };
    score?: number;
}

export interface QdrantClientLike {
    collectionExists(name: string): Promise<boolean>;
    createCollection(name: string, options: Record<string, unknown>): Promise<unknown>;
    deleteCollection(name: string): Promise<unknown>;
    upsert(name: string, options: Record<string, unknown>): Promise<unknown>;
    delete(name: string, options: Record<string, unknown>): Promise<unknown>;
    query(name: string, options: Record<string, unknown>): Promise<{ points: QdrantPoint[] }>;
    scroll(
        name: string,
        options: Record<string, unknown>
    ): Promise<{ points: QdrantPoint[]; next_page_offset?: unknown }>;
}

export interface QdrantStoreOptions {
    location?: string | null;
    url?: string | null;
    path?: string | null;
    api_key?: string | null;
    distance?: QdrantDistance;
    client_kwargs?: Record<string, unknown>;
    client?: QdrantClientLike;
}

/** Qdrant vector store supporting in-memory, persistent, and remote modes. */
export class QdrantStore extends VectorStoreBase {
    private readonly options: QdrantStoreOptions;
    private readonly distance: QdrantDistance;
    private client: QdrantClientLike | null;

    constructor(options: QdrantStoreOptions = {}) {
        super();
        const modes = [options.location, options.url, options.path].filter(value => value != null);
        if (modes.length > 1) throw new Error('location, url, and path are mutually exclusive');
        this.options = options;
        this.distance = options.distance ?? 'Cosine';
        this.client = options.client ?? null;
    }

    async getClient(): Promise<QdrantClientLike> {
        if (!this.client) {
            if (this.options.location === ':memory:' || this.options.path) {
                this.client = new LocalQdrantClient(
                    this.options.path ? join(this.options.path, 'agentscope-qdrant.json') : null
                );
            } else {
                let module: typeof import('@qdrant/js-client-rest');
                try {
                    module = await import('@qdrant/js-client-rest');
                } catch (error) {
                    throw new Error(
                        'Remote Qdrant requires the optional @qdrant/js-client-rest package.',
                        { cause: error }
                    );
                }
                const sdk = new module.QdrantClient({
                    url: this.options.url ?? this.options.location ?? undefined,
                    apiKey: this.options.api_key ?? undefined,
                    ...(this.options.client_kwargs ?? {}),
                });
                this.client = {
                    collectionExists: async name => (await sdk.collectionExists(name)).exists,
                    createCollection: (name, options) =>
                        sdk.createCollection(name, options as never),
                    deleteCollection: name => sdk.deleteCollection(name),
                    upsert: (name, options) => sdk.upsert(name, options as never),
                    delete: (name, options) => sdk.delete(name, options as never),
                    query: (name, options) =>
                        sdk.query(name, options as never) as unknown as Promise<{
                            points: QdrantPoint[];
                        }>,
                    scroll: (name, options) =>
                        sdk.scroll(name, options as never) as unknown as Promise<{
                            points: QdrantPoint[];
                            next_page_offset?: unknown;
                        }>,
                } as QdrantClientLike;
            }
        }
        return this.client;
    }

    override async close(): Promise<void> {
        const close = (this.client as QdrantClientLike & { close?: () => Promise<void> })?.close;
        if (close) await close.call(this.client);
        this.client = null;
    }

    async createCollection(name: string, dimensions: number): Promise<void> {
        const client = await this.getClient();
        if (await client.collectionExists(name)) return;
        await client.createCollection(name, {
            vectors: { size: dimensions, distance: this.distance },
        });
    }

    async deleteCollection(name: string): Promise<void> {
        await (await this.getClient()).deleteCollection(name);
    }

    async hasCollection(name: string): Promise<boolean> {
        return (await this.getClient()).collectionExists(name);
    }

    async insert(collection: string, records: VectorRecord[]): Promise<void> {
        if (!records.length) return;
        await (
            await this.getClient()
        ).upsert(collection, {
            points: records.map(record => ({
                id: QdrantStore.pointId(record),
                vector: record.vector,
                payload: { document_id: record.document_id, chunk: record.chunk },
            })),
        });
    }

    async delete(collection: string, documentId: string): Promise<void> {
        await (
            await this.getClient()
        ).delete(collection, {
            filter: {
                must: [{ key: 'document_id', match: { value: documentId } }],
            },
        });
    }

    async search(
        collection: string,
        queryVector: number[],
        topK = 5,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<VectorSearchResult[]> {
        const response = await (
            await this.getClient()
        ).query(collection, {
            query: queryVector,
            limit: topK,
            with_payload: true,
            filter: QdrantStore.buildMetadataFilter(metadataFilter),
        });
        return response.points.map(point => ({
            score: Number(point.score),
            document_id: point.payload.document_id,
            chunk: point.payload.chunk,
        }));
    }

    async listDocuments(
        collection: string,
        metadataFilter: Record<string, unknown> | null = null
    ): Promise<DocumentSummary[]> {
        const summaries = new Map<string, DocumentSummary>();
        let offset: unknown;
        do {
            const response = await (
                await this.getClient()
            ).scroll(collection, {
                filter: QdrantStore.buildMetadataFilter(metadataFilter),
                limit: 256,
                offset,
                with_payload: true,
                with_vector: false,
            });
            for (const point of response.points) {
                const documentId = point.payload.document_id;
                const summary = summaries.get(documentId);
                if (summary) summary.chunk_count++;
                else
                    summaries.set(documentId, {
                        document_id: documentId,
                        source: point.payload.chunk.source ?? '',
                        chunk_count: 1,
                        metadata: { ...(point.payload.chunk.metadata ?? {}) },
                    });
            }
            offset = response.next_page_offset;
        } while (offset !== null && offset !== undefined);
        return [...summaries.values()];
    }

    override async listChunks(
        collection: string,
        documentId: string,
        options: ChunkListOptions = {}
    ): Promise<Chunk[]> {
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 30;
        if (limit <= 0) return [];
        const metadataFilter = QdrantStore.buildMetadataFilter(options.metadata_filter);
        const must = [
            { key: 'document_id', match: { value: documentId } },
            { key: 'chunk.chunk_index', range: { gte: offset, lt: offset + limit } },
            ...((metadataFilter?.must ?? []) as Array<Record<string, unknown>>),
        ];
        const byIndex = new Map<number, Chunk>();
        let scrollOffset: unknown;
        do {
            const response = await (
                await this.getClient()
            ).scroll(collection, {
                filter: { must },
                limit: 256,
                offset: scrollOffset,
                with_payload: true,
                with_vector: false,
            });
            for (const point of response.points) {
                const chunk = point.payload.chunk;
                if (!byIndex.has(chunk.chunk_index)) byIndex.set(chunk.chunk_index, chunk);
            }
            scrollOffset = response.next_page_offset;
        } while (scrollOffset !== null && scrollOffset !== undefined);
        return [...byIndex.values()]
            .sort((left, right) => left.chunk_index - right.chunk_index)
            .slice(0, limit);
    }

    static pointId(record: VectorRecord): string {
        return uuidv5(`${record.document_id}\0${record.chunk.chunk_index}`, uuidv5.URL);
    }

    static buildMetadataFilter(
        metadataFilter?: Record<string, unknown> | null
    ): { must: Array<Record<string, unknown>> } | null {
        if (!metadataFilter || !Object.keys(metadataFilter).length) return null;
        return {
            must: Object.entries(metadataFilter).map(([key, value]) => ({
                key: `chunk.metadata.${key}`,
                match: { value },
            })),
        };
    }
}

interface LocalQdrantState {
    collections: Record<
        string,
        {
            dimensions: number;
            distance: QdrantDistance;
            points: Record<string, QdrantPoint>;
        }
    >;
}

class LocalQdrantClient implements QdrantClientLike {
    private state: LocalQdrantState | null = null;

    constructor(private readonly persistencePath: string | null) {}

    async collectionExists(name: string): Promise<boolean> {
        return Boolean((await this.load()).collections[name]);
    }

    async createCollection(name: string, options: Record<string, unknown>): Promise<void> {
        const vectors = options.vectors as Record<string, unknown>;
        (await this.load()).collections[name] ??= {
            dimensions: Number(vectors.size),
            distance: String(vectors.distance) as QdrantDistance,
            points: {},
        };
        await this.persist();
    }

    async deleteCollection(name: string): Promise<void> {
        delete (await this.load()).collections[name];
        await this.persist();
    }

    async upsert(name: string, options: Record<string, unknown>): Promise<void> {
        const collection = this.collection(await this.load(), name);
        for (const point of options.points as QdrantPoint[]) {
            if (point.vector?.length !== collection.dimensions)
                throw new Error('Vector dimension mismatch');
            collection.points[point.id] = structuredClone(point);
        }
        await this.persist();
    }

    async delete(name: string, options: Record<string, unknown>): Promise<void> {
        const collection = this.collection(await this.load(), name);
        for (const [id, point] of Object.entries(collection.points)) {
            if (matchesQdrantFilter(point, options.filter)) delete collection.points[id];
        }
        await this.persist();
    }

    async query(
        name: string,
        options: Record<string, unknown>
    ): Promise<{ points: QdrantPoint[] }> {
        const collection = this.collection(await this.load(), name);
        const query = options.query as number[];
        const points = Object.values(collection.points)
            .filter(point => matchesQdrantFilter(point, options.filter))
            .map(point => ({
                ...structuredClone(point),
                score: qdrantScore(query, point.vector ?? [], collection.distance),
            }));
        points.sort((left, right) =>
            collection.distance === 'Euclid' || collection.distance === 'Manhattan'
                ? left.score! - right.score!
                : right.score! - left.score!
        );
        return { points: points.slice(0, Number(options.limit)) };
    }

    async scroll(
        name: string,
        options: Record<string, unknown>
    ): Promise<{ points: QdrantPoint[]; next_page_offset?: unknown }> {
        const points = Object.values(this.collection(await this.load(), name).points)
            .filter(point => matchesQdrantFilter(point, options.filter))
            .sort((left, right) => left.id.localeCompare(right.id));
        const start =
            options.offset == null
                ? 0
                : Math.max(0, points.findIndex(point => point.id === options.offset) + 1);
        const page = points.slice(start, start + Number(options.limit));
        const next = start + page.length < points.length ? page.at(-1)?.id : undefined;
        return { points: page.map(point => structuredClone(point)), next_page_offset: next };
    }

    private async load(): Promise<LocalQdrantState> {
        if (this.state) return this.state;
        if (this.persistencePath) {
            try {
                this.state = JSON.parse(
                    await readFile(this.persistencePath, 'utf8')
                ) as LocalQdrantState;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        this.state ??= { collections: {} };
        return this.state;
    }

    private collection(
        state: LocalQdrantState,
        name: string
    ): LocalQdrantState['collections'][string] {
        const collection = state.collections[name];
        if (!collection) throw new Error(`Qdrant collection does not exist: ${name}`);
        return collection;
    }

    private async persist(): Promise<void> {
        if (!this.persistencePath) return;
        await mkdir(dirname(this.persistencePath), { recursive: true });
        await writeFile(this.persistencePath, JSON.stringify(this.state), 'utf8');
    }
}

function matchesQdrantFilter(point: QdrantPoint, filter: unknown): boolean {
    if (!filter || typeof filter !== 'object') return true;
    const must = (filter as { must?: Array<Record<string, unknown>> }).must ?? [];
    return must.every(condition => {
        const key = String(condition.key);
        const value = getPath(point.payload, key.split('.'));
        if (condition.match)
            return Object.is(value, (condition.match as Record<string, unknown>).value);
        if (condition.range) {
            const range = condition.range as Record<string, number>;
            return Number(value) >= range.gte && Number(value) < range.lt;
        }
        return true;
    });
}

function getPath(value: unknown, parts: string[]): unknown {
    let current = value;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function qdrantScore(left: number[], right: number[], distance: QdrantDistance): number {
    if (left.length !== right.length) throw new Error('Vector dimensions must match');
    if (distance === 'Dot')
        return left.reduce((sum, value, index) => sum + value * right[index], 0);
    if (distance === 'Euclid')
        return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0));
    if (distance === 'Manhattan')
        return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);
    const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
    const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
    const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
