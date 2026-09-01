/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { OllamaCredential } from '@agentscope-ai/agentscope/credential';
import { EmbeddingResponse } from '@agentscope-ai/agentscope/embedding';
import { TextBlock } from '@agentscope-ai/agentscope/message';
import {
    KnowledgeBase,
    type Chunk,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
    VectorStoreBase,
} from '@agentscope-ai/agentscope/rag';

import { ResourceAccessPolicyBase } from '../src/access';
import type { ResourceKind, ResourceRef } from '../src/access';
import { MessageBusKeys, InMemoryMessageBus } from '../src/message-bus';
import { CollectionPerKbManager, LocalBlobStore } from '../src/rag';
import {
    KnowledgeBaseService,
    KnowledgeBaseServiceError,
    ResourceAccessService,
} from '../src/service';
import { InMemoryStorage } from '../src/storage';

class BufferSource {
    private offset = 0;

    constructor(private readonly data: Buffer) {}

    read(size: number): Uint8Array | null {
        if (this.offset === this.data.length) return null;
        const result = this.data.subarray(this.offset, this.offset + size);
        this.offset += result.byteLength;
        return result;
    }
}

class SharedEditPolicy extends ResourceAccessPolicyBase {
    constructor(private readonly knowledgeBaseId: () => string) {
        super();
    }

    async listAccessible(viewerId: string, kind: ResourceKind): Promise<ResourceRef[]> {
        return viewerId === 'viewer' && kind === 'knowledge_base'
            ? [
                  {
                      kind,
                      ownerId: 'owner',
                      resourceId: this.knowledgeBaseId(),
                      permission: 'edit',
                  },
              ]
            : [];
    }
}

class TestVectorStore extends VectorStoreBase {
    readonly collections = new Map<string, number>();
    readonly deletedDocuments: string[] = [];
    chunks: Chunk[] = [];
    results: VectorSearchResult[] = [];

    async createCollection(name: string, dimensions: number): Promise<void> {
        this.collections.set(name, dimensions);
    }
    async deleteCollection(name: string): Promise<void> {
        this.collections.delete(name);
    }
    async hasCollection(name: string): Promise<boolean> {
        return this.collections.has(name);
    }
    async insert(_collection: string, _records: VectorRecord[]): Promise<void> {}
    async delete(_collection: string, documentId: string): Promise<void> {
        this.deletedDocuments.push(documentId);
    }
    async search(): Promise<VectorSearchResult[]> {
        return this.results;
    }
    async listDocuments(): Promise<DocumentSummary[]> {
        return [];
    }
    override async listChunks(
        _collection: string,
        _documentId: string,
        options: { offset?: number; limit?: number } = {}
    ): Promise<Chunk[]> {
        return this.chunks.slice(
            options.offset ?? 0,
            (options.offset ?? 0) + (options.limit ?? 30)
        );
    }
}

class TestManager extends CollectionPerKbManager {
    override async getKnowledge(userId: string, knowledgeBaseId: string): Promise<KnowledgeBase> {
        const record = await this.storage.getKnowledgeBase(userId, knowledgeBaseId);
        if (!record) return super.getKnowledge(userId, knowledgeBaseId);
        return new KnowledgeBase({
            name: record.data.name,
            description: record.data.description,
            embedding_model: {
                dimensions: record.data.embedding_model_config.dimensions,
                supportsMultimodal: false,
                async call(inputs: unknown[]) {
                    return new EmbeddingResponse({ embeddings: inputs.map(() => [1, 0]) });
                },
            },
            vector_store: this.vectorStore,
            collection: record.data.collection_name,
        });
    }
}

describe('KnowledgeBaseService', () => {
    let temporaryDirectory: string;
    let storage: InMemoryStorage;
    let vectorStore: TestVectorStore;
    let bus: InMemoryMessageBus;
    let blobStore: LocalBlobStore;
    let manager: TestManager;
    let knowledgeBaseId: string;
    let service: KnowledgeBaseService;

    beforeEach(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-kb-test-'));
        storage = new InMemoryStorage();
        vectorStore = new TestVectorStore();
        bus = new InMemoryMessageBus();
        blobStore = await new LocalBlobStore(temporaryDirectory).openStore();
        manager = new TestManager(storage, vectorStore);
        await storage.upsertCredential(
            'owner',
            new OllamaCredential({ id: 'credential', name: 'Embedding' })
        );
        knowledgeBaseId = '';
        const access = new ResourceAccessService(
            storage,
            new SharedEditPolicy(() => knowledgeBaseId)
        );
        service = new KnowledgeBaseService(storage, manager, blobStore, bus, access);
        knowledgeBaseId = (
            await service.createKnowledgeBase({
                userId: 'owner',
                name: 'Knowledge',
                description: 'Description',
                embeddingModelConfig: {
                    type: 'ollama_credential',
                    credential_id: 'credential',
                    model: 'nomic-embed-text',
                    dimensions: 2,
                    parameters: {},
                },
            })
        ).id;
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    test('validates chunker config and provides stable filtered views', async () => {
        await expect(
            service.createKnowledgeBase({
                userId: 'owner',
                name: 'Bad',
                description: '',
                embeddingModelConfig: {
                    type: 'ollama_credential',
                    credential_id: 'credential',
                    model: 'embed',
                    dimensions: 2,
                    parameters: {},
                },
                chunkerConfig: { type: 'missing', parameters: {} },
            })
        ).rejects.toBeInstanceOf(KnowledgeBaseServiceError);
        const [views, total] = await service.listKnowledgeBaseViews('viewer', {
            name: 'KNOWL',
        });
        expect(total).toBe(1);
        expect(views).toEqual([
            expect.objectContaining({
                id: knowledgeBaseId,
                name: 'Knowledge',
                editable: true,
                credential_name: 'Embedding',
            }),
        ]);
        expect(JSON.stringify(views[0])).not.toContain('ownerId');
    });

    test('registers an editor upload under the owner and enqueues durable indexing', async () => {
        const document = await service.registerDocument({
            userId: 'viewer',
            knowledgeBaseId,
            filename: 'notes.txt',
            stream: new BufferSource(Buffer.from('hello knowledge')),
            size: 15,
            contentType: 'text/plain',
        });
        expect(document).toMatchObject({
            user_id: 'owner',
            knowledge_base_id: knowledgeBaseId,
            status: 'pending',
            data: { filename: 'notes.txt', size: 15 },
        });
        expect(await bus.queueDrain(MessageBusKeys.indexTasksQueue())).toEqual([
            [
                expect.any(String),
                {
                    user_id: 'owner',
                    knowledge_base_id: knowledgeBaseId,
                    document_id: document.id,
                },
            ],
        ]);
        expect(
            await service.getDocumentStatus('viewer', knowledgeBaseId, [document.id, 'missing'])
        ).toEqual([document]);
        const content = await service.streamDocumentContent('viewer', knowledgeBaseId, document.id);
        expect(content.size).toBe(15);
        const chunks: Buffer[] = [];
        for await (const chunk of content.content) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe('hello knowledge');
    });

    test('lists chunks, searches, updates, and deletes end to end', async () => {
        const document = await service.registerDocument({
            userId: 'owner',
            knowledgeBaseId,
            filename: 'notes.txt',
            stream: new BufferSource(Buffer.from('hello')),
            size: 5,
        });
        vectorStore.chunks = [
            {
                content: TextBlock({ text: 'chunk' }),
                source: 'notes.txt',
                chunk_index: 0,
                total_chunks: 1,
                metadata: {},
            },
        ];
        vectorStore.results = [
            { score: 0.9, document_id: document.id, chunk: vectorStore.chunks[0] },
        ];
        expect(await service.listDocumentChunks('viewer', knowledgeBaseId, document.id)).toEqual([
            vectorStore.chunks,
            0,
        ]);
        expect(await service.search('viewer', knowledgeBaseId, 'hello')).toEqual(
            vectorStore.results
        );
        expect(
            await service.updateKnowledgeBase('viewer', knowledgeBaseId, { name: 'Renamed' })
        ).toMatchObject({ data: { name: 'Renamed' } });
        await service.deleteDocument('viewer', knowledgeBaseId, document.id);
        expect(vectorStore.deletedDocuments).toEqual([document.id]);
        expect(
            await storage.getKnowledgeDocument('owner', knowledgeBaseId, document.id)
        ).toBeNull();
        expect(await blobStore.exists(document.data.blob_uri)).toBe(false);
        await service.deleteKnowledgeBase('viewer', knowledgeBaseId);
        expect(await storage.getKnowledgeBase('owner', knowledgeBaseId)).toBeNull();
    });
});
