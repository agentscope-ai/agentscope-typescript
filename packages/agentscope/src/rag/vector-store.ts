/* eslint-disable jsdoc/require-jsdoc */

import type { Chunk } from './document';

export interface VectorRecord {
    vector: number[];
    document_id: string;
    chunk: Chunk;
}

export interface VectorSearchResult {
    score: number;
    document_id: string;
    chunk: Chunk;
}

export interface DocumentSummary {
    document_id: string;
    source: string;
    chunk_count: number;
    metadata: Record<string, unknown>;
}

export interface ChunkListOptions {
    offset?: number;
    limit?: number;
    metadata_filter?: Record<string, unknown> | null;
}

/** Common lifecycle and data contract for vector database adapters. */
export abstract class VectorStoreBase {
    async close(): Promise<void> {}

    abstract createCollection(name: string, dimensions: number): Promise<void>;
    abstract deleteCollection(name: string): Promise<void>;
    abstract hasCollection(name: string): Promise<boolean>;
    abstract insert(collection: string, records: VectorRecord[]): Promise<void>;
    abstract delete(collection: string, documentId: string): Promise<void>;
    abstract search(
        collection: string,
        queryVector: number[],
        topK?: number,
        metadataFilter?: Record<string, unknown> | null
    ): Promise<VectorSearchResult[]>;
    abstract listDocuments(
        collection: string,
        metadataFilter?: Record<string, unknown> | null
    ): Promise<DocumentSummary[]>;

    async listChunks(
        _collection: string,
        _documentId: string,
        _options: ChunkListOptions = {}
    ): Promise<Chunk[]> {
        throw new Error(`${this.constructor.name} does not implement listChunks().`);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}
