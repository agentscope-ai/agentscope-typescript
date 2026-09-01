/* eslint-disable jsdoc/require-jsdoc */

import type { Chunk, ChunkerBase, VectorSearchResult } from '@agentscope-ai/agentscope/rag';
import { ApproxTokenChunker } from '@agentscope-ai/agentscope/rag';

import { enqueueIndexTask } from '../bus-ops';
import type { MessageBus } from '../message-bus';
import type { BlobStoreBase, KnowledgeBaseManagerBase, SyncReadable } from '../rag';
import { KnowledgeBaseNotFoundError } from '../rag/knowledge-base-manager';
import {
    KnowledgeDocumentRecordSchema,
    type ChunkerConfig,
    type EmbeddingModelConfig,
    type KnowledgeBaseRecord,
    type KnowledgeDocumentRecord,
    type StorageBase,
} from '../storage';
import {
    ResourceAccessError,
    type KnowledgeBaseView,
    type ResourceAccessService,
} from './resource-access-service';

interface ChunkerConstructor {
    new (parameters?: Record<string, unknown>): ChunkerBase<object>;
}

export class KnowledgeBaseServiceError extends Error {
    constructor(
        public readonly statusCode: 409 | 422 | 501,
        public readonly detail: string
    ) {
        super(detail);
        this.name = 'KnowledgeBaseServiceError';
    }
}

/** HTTP-independent orchestration for service-owned knowledge bases and documents. */
export class KnowledgeBaseService {
    private readonly chunkers = new Map<string, ChunkerConstructor>();

    constructor(
        private readonly storage: StorageBase,
        private readonly manager: KnowledgeBaseManagerBase,
        private readonly blobStore: BlobStoreBase,
        private readonly messageBus: MessageBus,
        private readonly access: ResourceAccessService,
        chunkers: ChunkerConstructor[] = [ApproxTokenChunker]
    ) {
        for (const Chunker of chunkers) {
            const instance = new Chunker({});
            this.chunkers.set(instance.chunkerType, Chunker);
        }
    }

    async createKnowledgeBase(options: {
        userId: string;
        name: string;
        description: string;
        embeddingModelConfig: EmbeddingModelConfig;
        chunkerConfig?: ChunkerConfig | null;
    }): Promise<KnowledgeBaseRecord> {
        const chunkerConfig = options.chunkerConfig ?? {
            type: this.chunkers.keys().next().value as string,
            parameters: {},
        };
        const Chunker = this.chunkers.get(chunkerConfig.type);
        if (!Chunker) {
            throw new KnowledgeBaseServiceError(
                422,
                `Unknown chunker type: '${chunkerConfig.type}', available: ${JSON.stringify([...this.chunkers.keys()].sort())}`
            );
        }
        try {
            new Chunker(chunkerConfig.parameters);
        } catch (error) {
            throw new KnowledgeBaseServiceError(
                422,
                `Invalid chunker parameters: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        const policy = await this.manager.getDimensionPolicy();
        if (!policy.accepts(options.embeddingModelConfig.dimensions)) {
            throw new KnowledgeBaseServiceError(
                409,
                `Embedding dimension ${options.embeddingModelConfig.dimensions} is not allowed by the ${policy.kind} policy.`
            );
        }
        return this.manager.createKnowledgeBase({ ...options, chunkerConfig });
    }

    listKnowledgeBases(userId: string): Promise<KnowledgeBaseRecord[]> {
        return this.manager.listKnowledgeBases(userId);
    }

    async listKnowledgeBaseViews(
        userId: string,
        options: {
            knowledgeBaseId?: string | null;
            name?: string | null;
            page?: number;
            pageSize?: number;
            orderBy?: 'create_time' | 'update_time';
            descending?: boolean;
        } = {}
    ): Promise<[views: KnowledgeBaseView[], total: number]> {
        let views = await this.access.listResource(userId, 'knowledge_base');
        if (options.knowledgeBaseId != null) {
            views = views.filter(view => view.id === options.knowledgeBaseId);
        }
        if (options.name != null) {
            const needle = options.name.toLocaleLowerCase();
            views = views.filter(view => view.name.toLocaleLowerCase().includes(needle));
        }
        const total = views.length;
        const field = options.orderBy === 'update_time' ? 'updated_at' : 'created_at';
        const direction = (options.descending ?? true) ? -1 : 1;
        views.sort((left, right) => {
            const comparison =
                left[field].localeCompare(right[field]) || left.id.localeCompare(right.id);
            return comparison * direction;
        });
        const page = options.page ?? 1;
        const pageSize = options.pageSize ?? 30;
        return [views.slice((page - 1) * pageSize, page * pageSize), total];
    }

    async updateKnowledgeBase(
        userId: string,
        knowledgeBaseId: string,
        options: { name?: string | null; description?: string | null }
    ): Promise<KnowledgeBaseRecord> {
        const ownerId = await this.requireEdit(userId, knowledgeBaseId);
        const record = await this.manager.updateKnowledgeBase(ownerId, knowledgeBaseId, options);
        if (!record) throw this.notFound('Knowledge base', knowledgeBaseId);
        return record;
    }

    async deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<void> {
        const ownerId = await this.requireEdit(userId, knowledgeBaseId);
        for (const document of await this.storage.listKnowledgeDocuments(
            ownerId,
            knowledgeBaseId
        )) {
            await this.deleteBlobQuietly(document.data.blob_uri);
        }
        if (!(await this.manager.deleteKnowledgeBase(ownerId, knowledgeBaseId))) {
            throw this.notFound('Knowledge base', knowledgeBaseId);
        }
    }

    async registerDocument(options: {
        userId: string;
        knowledgeBaseId: string;
        filename: string;
        stream: SyncReadable;
        size: number;
        contentType?: string | null;
    }): Promise<KnowledgeDocumentRecord> {
        const ownerId = await this.requireEdit(options.userId, options.knowledgeBaseId);
        const documentId = crypto.randomUUID().replaceAll('-', '');
        const blobUri = await this.blobStore.writeStream(
            `kb/${options.knowledgeBaseId}/${documentId}`,
            options.stream
        );
        const record = KnowledgeDocumentRecordSchema.parse({
            id: documentId,
            user_id: ownerId,
            knowledge_base_id: options.knowledgeBaseId,
            data: {
                filename: options.filename,
                size: options.size,
                content_type: options.contentType ?? null,
                blob_uri: blobUri,
            },
        });
        let stored: KnowledgeDocumentRecord;
        try {
            stored = await this.storage.upsertKnowledgeDocument(ownerId, record);
        } catch (error) {
            await this.deleteBlobQuietly(blobUri);
            throw error;
        }
        await enqueueIndexTask(this.messageBus, {
            userId: ownerId,
            knowledgeBaseId: options.knowledgeBaseId,
            documentId,
        });
        return stored;
    }

    async listDocuments(
        userId: string,
        knowledgeBaseId: string,
        options: {
            documentId?: string | null;
            keywords?: string | null;
            status?: string | null;
            page?: number;
            pageSize?: number;
            orderBy?: 'create_time' | 'update_time';
            descending?: boolean;
        } = {}
    ): Promise<[documents: KnowledgeDocumentRecord[], total: number]> {
        const kb = await this.access.resolveKnowledgeBase(userId, knowledgeBaseId);
        let documents = await this.storage.listKnowledgeDocuments(kb.user_id, knowledgeBaseId);
        if (options.documentId != null) {
            documents = documents.filter(record => record.id === options.documentId);
        }
        if (options.keywords != null) {
            const needle = options.keywords.toLocaleLowerCase();
            documents = documents.filter(record =>
                record.data.filename.toLocaleLowerCase().includes(needle)
            );
        }
        if (options.status != null) {
            documents = documents.filter(record => record.status === options.status);
        }
        const total = documents.length;
        const field = options.orderBy === 'update_time' ? 'updated_at' : 'created_at';
        const direction = (options.descending ?? true) ? -1 : 1;
        documents.sort(
            (left, right) =>
                (left[field].localeCompare(right[field]) || left.id.localeCompare(right.id)) *
                direction
        );
        const page = options.page ?? 1;
        const pageSize = options.pageSize ?? 30;
        return [documents.slice((page - 1) * pageSize, page * pageSize), total];
    }

    async getDocumentStatus(
        userId: string,
        knowledgeBaseId: string,
        documentIds: string[]
    ): Promise<KnowledgeDocumentRecord[]> {
        const kb = await this.access.resolveKnowledgeBase(userId, knowledgeBaseId);
        const result: KnowledgeDocumentRecord[] = [];
        for (const documentId of documentIds) {
            const document = await this.storage.getKnowledgeDocument(
                kb.user_id,
                knowledgeBaseId,
                documentId
            );
            if (document) result.push(document);
        }
        return result;
    }

    async getDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<KnowledgeDocumentRecord> {
        const kb = await this.access.resolveKnowledgeBase(userId, knowledgeBaseId);
        const document = await this.storage.getKnowledgeDocument(
            kb.user_id,
            knowledgeBaseId,
            documentId
        );
        if (!document) throw this.notFound('Document', documentId);
        return document;
    }

    async listDocumentChunks(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        options: { page?: number; pageSize?: number } = {}
    ): Promise<[chunks: Chunk[], total: number]> {
        const document = await this.getDocument(userId, knowledgeBaseId, documentId);
        const knowledge = await this.resolveKnowledge(userId, knowledgeBaseId);
        try {
            return [
                await knowledge.listChunks(
                    documentId,
                    ((options.page ?? 1) - 1) * (options.pageSize ?? 30),
                    options.pageSize ?? 30
                ),
                document.data.chunk_count,
            ];
        } catch (error) {
            if (error instanceof Error && /does not implement listChunks/.test(error.message)) {
                throw new KnowledgeBaseServiceError(
                    501,
                    'The configured vector store does not support chunk listing.'
                );
            }
            throw error;
        }
    }

    async streamDocumentContent(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<{
        document: KnowledgeDocumentRecord;
        size: number | null;
        content: AsyncIterable<Uint8Array>;
    }> {
        const document = await this.getDocument(userId, knowledgeBaseId, documentId);
        let size: number | null;
        let available: boolean;
        try {
            size = await this.blobStore.size(document.data.blob_uri);
            available = size !== null || (await this.blobStore.exists(document.data.blob_uri));
        } catch {
            size = null;
            available = false;
        }
        if (!available)
            throw new ResourceAccessError(404, 'The original file is no longer available.');
        const store = this.blobStore;
        const uri = document.data.blob_uri;
        return {
            document,
            size,
            content: {
                async *[Symbol.asyncIterator]() {
                    const reader = await store.open(uri);
                    try {
                        while (true) {
                            const chunk = await reader.read(1 << 20);
                            if (chunk.byteLength === 0) return;
                            yield chunk;
                        }
                    } finally {
                        await reader.close();
                    }
                },
            },
        };
    }

    async deleteDocument(
        userId: string,
        knowledgeBaseId: string,
        documentId: string
    ): Promise<void> {
        const ownerId = await this.requireEdit(userId, knowledgeBaseId);
        const document = await this.storage.getKnowledgeDocument(
            ownerId,
            knowledgeBaseId,
            documentId
        );
        if (!document) return;
        const knowledge = await this.resolveKnowledge(userId, knowledgeBaseId);
        await knowledge.deleteDocument(documentId);
        await this.storage.deleteKnowledgeDocument(ownerId, knowledgeBaseId, documentId);
        await this.deleteBlobQuietly(document.data.blob_uri);
    }

    async search(
        userId: string,
        knowledgeBaseId: string,
        query: string,
        topK = 5
    ): Promise<VectorSearchResult[]> {
        return (await this.resolveKnowledge(userId, knowledgeBaseId)).search([query], topK);
    }

    private async requireEdit(userId: string, knowledgeBaseId: string): Promise<string> {
        return (await this.access.resolveForEdit(userId, 'knowledge_base', knowledgeBaseId))[0];
    }

    private async resolveKnowledge(userId: string, knowledgeBaseId: string) {
        const record = await this.access.resolveKnowledgeBase(userId, knowledgeBaseId);
        try {
            return await this.manager.getKnowledge(record.user_id, knowledgeBaseId);
        } catch (error) {
            if (error instanceof KnowledgeBaseNotFoundError) {
                throw new ResourceAccessError(404, error.message);
            }
            throw error;
        }
    }

    private async deleteBlobQuietly(uri: string): Promise<void> {
        try {
            await this.blobStore.delete(uri);
        } catch {
            // Blob deletion is best-effort cleanup; storage/vector state remains authoritative.
        }
    }

    private notFound(label: string, id: string): ResourceAccessError {
        return new ResourceAccessError(404, `${label} '${id}' not found.`);
    }
}
