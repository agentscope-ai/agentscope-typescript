/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EmbeddingResponse } from '@agentscope-ai/agentscope/embedding';
import {
    KnowledgeBase,
    TextParser,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
    VectorStoreBase,
} from '@agentscope-ai/agentscope/rag';

import { enqueueIndexTask } from '../src/bus-ops';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import { CollectionPerKbManager, LocalBlobStore } from '../src/rag';
import {
    buildParserRegistry,
    IndexSweeper,
    IndexTaskConsumer,
    IndexWorker,
    sanitizeIndexError,
} from '../src/service';
import { InMemoryStorage, KnowledgeDocumentRecordSchema } from '../src/storage';

class BufferSource {
    private offset = 0;

    constructor(private readonly value: Buffer) {}

    read(size: number): Uint8Array | null {
        if (this.offset === this.value.length) return null;
        const result = this.value.subarray(this.offset, this.offset + size);
        this.offset += result.byteLength;
        return result;
    }
}

class IndexVectorStore extends VectorStoreBase {
    readonly collections = new Map<string, number>();
    readonly deletions: string[] = [];
    readonly insertions: VectorRecord[][] = [];

    async createCollection(name: string, dimensions: number): Promise<void> {
        this.collections.set(name, dimensions);
    }
    async deleteCollection(name: string): Promise<void> {
        this.collections.delete(name);
    }
    async hasCollection(name: string): Promise<boolean> {
        return this.collections.has(name);
    }
    async insert(_collection: string, records: VectorRecord[]): Promise<void> {
        this.insertions.push(structuredClone(records));
    }
    async delete(_collection: string, documentId: string): Promise<void> {
        this.deletions.push(documentId);
    }
    async search(): Promise<VectorSearchResult[]> {
        return [];
    }
    async listDocuments(): Promise<DocumentSummary[]> {
        return [];
    }
}

class IndexManager extends CollectionPerKbManager {
    override async getKnowledge(userId: string, knowledgeBaseId: string): Promise<KnowledgeBase> {
        const record = await this.storage.getKnowledgeBase(userId, knowledgeBaseId);
        if (!record) return super.getKnowledge(userId, knowledgeBaseId);
        return new KnowledgeBase({
            name: record.data.name,
            description: record.data.description,
            embedding_model: {
                dimensions: 2,
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

describe('index worker, consumer, and sweeper', () => {
    let temporaryDirectory: string;
    let storage: InMemoryStorage;
    let blobStore: LocalBlobStore;
    let vectorStore: IndexVectorStore;
    let manager: IndexManager;
    let knowledgeBaseId: string;

    beforeEach(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-index-test-'));
        storage = new InMemoryStorage();
        blobStore = await new LocalBlobStore(temporaryDirectory).openStore();
        vectorStore = new IndexVectorStore();
        manager = new IndexManager(storage, vectorStore);
        knowledgeBaseId = (
            await manager.createKnowledgeBase({
                userId: 'user',
                name: 'Knowledge',
                description: '',
                embeddingModelConfig: {
                    type: 'test',
                    credential_id: 'unused',
                    model: 'embed',
                    dimensions: 2,
                    parameters: {},
                },
                chunkerConfig: {
                    type: 'approx_token',
                    parameters: { chunk_size: 2, overlap: 0 },
                },
            })
        ).id;
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    async function document(
        id: string,
        content: string,
        options: { contentType?: string | null; createdAt?: string } = {}
    ) {
        const blobUri = await blobStore.writeStream(
            `kb/${knowledgeBaseId}/${id}`,
            new BufferSource(Buffer.from(content))
        );
        return storage.upsertKnowledgeDocument(
            'user',
            KnowledgeDocumentRecordSchema.parse({
                id,
                user_id: 'user',
                knowledge_base_id: knowledgeBaseId,
                created_at: options.createdAt,
                data: {
                    filename: `${id}.txt`,
                    size: Buffer.byteLength(content),
                    content_type:
                        options.contentType === undefined ? 'text/plain' : options.contentType,
                    blob_uri: blobUri,
                },
            })
        );
    }

    test('runs parse, chunk, replace, embed and ready transitions under a lease', async () => {
        await document('document', 'abcdefghijklmnopq');
        const worker = new IndexWorker(storage, blobStore, manager, [new TextParser()], 'node', {
            leaseTtlMs: 60_000,
        });
        await worker.process('user', knowledgeBaseId, 'document');

        expect(
            await storage.getKnowledgeDocument('user', knowledgeBaseId, 'document')
        ).toMatchObject({
            status: 'ready',
            processing_node: null,
            lease_expires_at: null,
            data: { chunk_count: 3, error: null },
        });
        expect(vectorStore.deletions).toEqual(['document']);
        expect(vectorStore.insertions).toHaveLength(1);
        expect(vectorStore.insertions[0]).toHaveLength(3);
        expect(vectorStore.insertions[0][0]).toMatchObject({
            document_id: 'document',
            chunk: {
                metadata: {
                    filename: 'document.txt',
                    media_type: 'text/plain',
                    size_bytes: 17,
                },
            },
        });
    });

    test('deduplicates a held lease and persists sanitized terminal failures', async () => {
        await document('held', 'value');
        expect(
            await storage.acquireKnowledgeDocumentLease({
                userId: 'user',
                knowledgeBaseId,
                documentId: 'held',
                processingNode: 'other',
                leaseTtlMs: 60_000,
            })
        ).toBe(true);
        const worker = new IndexWorker(storage, blobStore, manager, [], 'node');
        await worker.process('user', knowledgeBaseId, 'held');
        expect((await storage.getKnowledgeDocument('user', knowledgeBaseId, 'held'))?.status).toBe(
            'pending'
        );

        await document('failure', 'value', { contentType: 'application/x-missing' });
        await worker.process('user', knowledgeBaseId, 'failure');
        expect(
            await storage.getKnowledgeDocument('user', knowledgeBaseId, 'failure')
        ).toMatchObject({
            status: 'error',
            data: {
                error: "Error: No parser registered for media type 'application/x-missing'.",
            },
        });
        expect(sanitizeIndexError(new TypeError('first\nsecret second line'))).toBe(
            'TypeError: first'
        );
    });

    test('expands parser lists with last-one-wins routing', () => {
        const first = new TextParser('utf-8');
        const second = new TextParser('ascii');
        expect(buildParserRegistry([first, second]).get('text/plain')).toBe(second);
        expect(buildParserRegistry({ alias: first })).toEqual(new Map([['alias', first]]));
    });

    test('consumer performs startup drain and ignores malformed entries', async () => {
        const bus = new InMemoryMessageBus();
        const process = jest.fn(async () => undefined);
        await bus.queuePush(MessageBusKeys.indexTasksQueue(), { malformed: true });
        await enqueueIndexTask(bus, {
            userId: 'user',
            knowledgeBaseId,
            documentId: 'document',
        });
        const consumer = new IndexTaskConsumer(bus, { process } as never);
        await consumer.start();
        await new Promise(resolve => setImmediate(resolve));
        await consumer.stop();
        expect(process).toHaveBeenCalledWith('user', knowledgeBaseId, 'document');
    });

    test('sweeper de-duplicates old pending records and publishes recovery tasks', async () => {
        await document('orphan', 'value', {
            createdAt: '2020-01-01T00:00:00.000Z',
        });
        const bus = new InMemoryMessageBus();
        const sweeper = new IndexSweeper(storage, bus, 60_000, 1_000);
        expect(await sweeper.sweepOnce(new Date('2020-01-01T00:01:00.000Z'))).toBe(1);
        expect(await bus.queueDrain(MessageBusKeys.indexTasksQueue())).toEqual([
            [
                expect.any(String),
                {
                    user_id: 'user',
                    knowledge_base_id: knowledgeBaseId,
                    document_id: 'orphan',
                },
            ],
        ]);
        await sweeper.start();
        await sweeper.stop();
    });
});
