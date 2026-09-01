/* eslint-disable jsdoc/require-jsdoc */

import { _generateId } from '../_utils';
import type { EmbeddingInput, EmbeddingModelBase, EmbeddingResponse } from '../embedding';
import type { DataBlock, TextBlock } from '../message';
import type { Chunk } from './document';
import type {
    DocumentSummary,
    VectorRecord,
    VectorSearchResult,
    VectorStoreBase,
} from './vector-store';

export interface KnowledgeEmbeddingModel {
    readonly dimensions: number;
    readonly supportsMultimodal: boolean;
    call(inputs: EmbeddingInput[]): Promise<EmbeddingResponse>;
}

export interface KnowledgeBaseOptions {
    name: string;
    description: string;
    embedding_model: KnowledgeEmbeddingModel | EmbeddingModelBase;
    vector_store: VectorStoreBase;
    collection: string;
    metadata_filter?: Record<string, unknown> | null;
}

/** Runtime handle binding one embedding model to one vector-store collection. */
export class KnowledgeBase {
    readonly name: string;
    readonly description: string;
    private readonly boundEmbeddingModel: KnowledgeEmbeddingModel;
    private readonly boundVectorStore: VectorStoreBase;
    private readonly collectionName: string;
    private readonly scopeFilter: Record<string, unknown> | null;
    private collectionReady = false;

    constructor(options: KnowledgeBaseOptions) {
        this.name = options.name;
        this.description = options.description;
        this.boundEmbeddingModel = options.embedding_model;
        this.boundVectorStore = options.vector_store;
        this.collectionName = options.collection;
        this.scopeFilter = options.metadata_filter ?? null;
    }

    get embeddingModel(): KnowledgeEmbeddingModel {
        return this.boundEmbeddingModel;
    }

    get vectorStore(): VectorStoreBase {
        return this.boundVectorStore;
    }

    get collection(): string {
        return this.collectionName;
    }

    get metadataFilter(): Record<string, unknown> | null {
        return this.scopeFilter;
    }

    async ensureCollection(): Promise<void> {
        if (this.collectionReady) return;
        if (!(await this.boundVectorStore.hasCollection(this.collectionName))) {
            await this.boundVectorStore.createCollection(
                this.collectionName,
                this.boundEmbeddingModel.dimensions
            );
        }
        this.collectionReady = true;
    }

    async search(
        queries: Array<string | TextBlock | DataBlock>,
        topK = 5,
        scoreThreshold: number | null = null
    ): Promise<VectorSearchResult[]> {
        if (!queries.length) return [];
        const supported = this.boundEmbeddingModel.supportsMultimodal
            ? queries
            : queries.filter(query => typeof query === 'string' || query.type !== 'data');
        if (!supported.length) return [];

        await this.ensureCollection();
        const response = await this.boundEmbeddingModel.call(supported);
        const groups = await Promise.all(
            response.embeddings.map(vector =>
                this.boundVectorStore.search(this.collectionName, vector, topK, this.scopeFilter)
            )
        );
        const best = new Map<string, VectorSearchResult>();
        for (const result of groups.flat()) {
            if (scoreThreshold !== null && result.score < scoreThreshold) continue;
            const key = JSON.stringify([result.document_id, result.chunk.chunk_index]);
            const previous = best.get(key);
            if (!previous || result.score > previous.score) best.set(key, result);
        }
        return [...best.values()].sort((left, right) => right.score - left.score).slice(0, topK);
    }

    async insertDocument(
        chunks: Chunk[],
        documentId: string | null = null,
        documentMetadata: Record<string, unknown> | null = null
    ): Promise<string> {
        if (!chunks.length) return documentId ?? _generateId();
        const resolvedDocumentId = documentId ?? _generateId();
        await this.ensureCollection();
        for (const chunk of chunks) {
            chunk.metadata = {
                ...(documentMetadata ?? {}),
                ...chunk.metadata,
                ...(this.scopeFilter ?? {}),
            };
        }
        const response = await this.boundEmbeddingModel.call(chunks.map(chunk => chunk.content));
        if (response.embeddings.length !== chunks.length) {
            throw new Error(
                `Embedding model returned ${response.embeddings.length} vectors for ` +
                    `${chunks.length} chunks.`
            );
        }
        const records: VectorRecord[] = response.embeddings.map((vector, index) => ({
            vector,
            document_id: resolvedDocumentId,
            chunk: chunks[index],
        }));
        await this.boundVectorStore.insert(this.collectionName, records);
        return resolvedDocumentId;
    }

    async deleteDocument(documentId: string): Promise<void> {
        await this.ensureCollection();
        await this.boundVectorStore.delete(this.collectionName, documentId);
    }

    async listDocuments(): Promise<DocumentSummary[]> {
        await this.ensureCollection();
        return this.boundVectorStore.listDocuments(this.collectionName, this.scopeFilter);
    }

    async listChunks(documentId: string, offset = 0, limit = 30): Promise<Chunk[]> {
        await this.ensureCollection();
        return this.boundVectorStore.listChunks(this.collectionName, documentId, {
            offset,
            limit,
            metadata_filter: this.scopeFilter,
        });
    }
}
