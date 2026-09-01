/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { OllamaCredential } from '@agentscope-ai/agentscope/credential';
import { EmbeddingModelCard } from '@agentscope-ai/agentscope/model';
import type {
    DocumentSummary,
    VectorRecord,
    VectorSearchResult,
} from '@agentscope-ai/agentscope/rag';
import { VectorStoreBase } from '@agentscope-ai/agentscope/rag';

import {
    CollectionPerKbManager,
    DimensionPolicy,
    DimensionPolicyKind,
    KnowledgeBaseNotFoundError,
    LocalBlobStore,
    S3BlobStore,
} from '../src/rag';
import { InMemoryStorage } from '../src/storage';

class BufferSource {
    private offset = 0;

    constructor(
        private readonly value: Buffer,
        private readonly chunkSize = 3
    ) {}

    read(size: number): Uint8Array | null {
        const end = Math.min(this.value.length, this.offset + Math.min(size, this.chunkSize));
        if (end === this.offset) return null;
        const result = this.value.subarray(this.offset, end);
        this.offset = end;
        return result;
    }
}

class FakeVectorStore extends VectorStoreBase {
    readonly collections = new Map<string, number>();
    readonly deleted: string[] = [];

    async createCollection(name: string, dimensions: number): Promise<void> {
        this.collections.set(name, dimensions);
    }

    async deleteCollection(name: string): Promise<void> {
        this.collections.delete(name);
        this.deleted.push(name);
    }

    async hasCollection(name: string): Promise<boolean> {
        return this.collections.has(name);
    }

    async insert(_collection: string, _records: VectorRecord[]): Promise<void> {}
    async delete(): Promise<void> {}
    async search(): Promise<VectorSearchResult[]> {
        return [];
    }
    async listDocuments(): Promise<DocumentSummary[]> {
        return [];
    }
}

describe('service RAG blob stores', () => {
    let temporaryDirectory: string;

    beforeEach(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-blob-test-'));
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    test('round-trips local blobs in bounded chunks and cleans empty parents', async () => {
        const store = await new LocalBlobStore(temporaryDirectory).openStore();
        const uri = await store.writeStream(
            'kb/one/document',
            new BufferSource(Buffer.from('abcde'))
        );
        expect(uri).toBe('local://kb/one/document');
        expect(await store.exists(uri)).toBe(true);
        expect(await store.size(uri)).toBe(5);
        const reader = await store.open(uri);
        expect(Buffer.from(await reader.read(2)).toString()).toBe('ab');
        expect(Buffer.from(await reader.read(8)).toString()).toBe('cde');
        expect(await reader.read(1)).toHaveLength(0);
        await reader.close();
        await store.delete(uri);
        await store.delete(uri);
        expect(await store.exists(uri)).toBe(false);
        expect(await fs.readdir(temporaryDirectory)).toEqual([]);
    });

    test('rejects local traversal and foreign URI schemes', async () => {
        const store = await new LocalBlobStore(temporaryDirectory).openStore();
        await expect(
            store.writeStream('../escape', new BufferSource(Buffer.from('x')))
        ).rejects.toThrow('Invalid blob key');
        await expect(store.exists('s3://bucket/key')).rejects.toThrow('Not a local blob URI');
    });

    test('preserves S3 URI buckets for reads but restricts mutations to the configured bucket', async () => {
        const objects = new Map<string, Buffer>();
        const driver = {
            async upload(bucket: string, key: string, body: Readable) {
                const chunks: Buffer[] = [];
                for await (const chunk of body) chunks.push(Buffer.from(chunk));
                objects.set(`${bucket}/${key}`, Buffer.concat(chunks));
            },
            async get(bucket: string, key: string) {
                return Readable.from([objects.get(`${bucket}/${key}`) ?? Buffer.alloc(0)]);
            },
            async delete(bucket: string, key: string) {
                objects.delete(`${bucket}/${key}`);
            },
            async head(bucket: string, key: string) {
                return objects.get(`${bucket}/${key}`)?.length ?? null;
            },
            close() {},
        };
        objects.set('legacy/old', Buffer.from('old'));
        const store = await new S3BlobStore('current', { driver }).openStore();
        expect(await store.writeStream('kb/doc', new BufferSource(Buffer.from('value')))).toBe(
            's3://current/kb/doc'
        );
        const legacy = await store.open('s3://legacy/old');
        expect(Buffer.from(await legacy.read()).toString()).toBe('old');
        await legacy.close();
        await expect(store.delete('s3://legacy/old')).rejects.toThrow(
            'does not match configured bucket'
        );
        expect(S3BlobStore.parseUri('s3://bucket/a/b')).toEqual(['bucket', 'a/b']);
    });
});

describe('knowledge-base managers', () => {
    test('enforces and projects dimension policies', () => {
        const any = new DimensionPolicy({ kind: DimensionPolicyKind.ANY });
        const fixed = new DimensionPolicy({ kind: DimensionPolicyKind.FIXED, dimension: 768 });
        const card = new EmbeddingModelCard({
            name: 'embed',
            label: 'Embed',
            dimensions: 1536,
            supported_dimensions: [256, 768, 1536],
            context_size: 8192,
        });
        expect(any.accepts(1)).toBe(true);
        expect(fixed.accepts(1536)).toBe(false);
        expect(fixed.filterCard(card)).toMatchObject({
            dimensions: 768,
            supportedDimensions: [768],
        });
        expect(() => new DimensionPolicy({ kind: DimensionPolicyKind.ANY, dimension: 3 })).toThrow(
            'requires dimension=null'
        );
        expect(() => new DimensionPolicy({ kind: DimensionPolicyKind.FIXED })).toThrow(
            'requires a positive dimension'
        );
    });

    test('allocates one collection per KB and cascades deletion', async () => {
        const storage = new InMemoryStorage();
        const vectorStore = new FakeVectorStore();
        const manager = new CollectionPerKbManager(storage, vectorStore);
        const record = await manager.createKnowledgeBase({
            userId: 'user',
            name: 'Knowledge',
            description: 'Description',
            embeddingModelConfig: {
                type: 'ollama_credential',
                credential_id: 'credential',
                model: 'nomic-embed-text',
                dimensions: 768,
                parameters: {},
            },
        });
        expect(record.data.collection_name).toBe(`kb_${record.id}`);
        expect(vectorStore.collections.get(record.data.collection_name)).toBe(768);
        expect(await manager.listKnowledgeBases('user')).toEqual([record]);
        expect(
            await manager.updateKnowledgeBase('user', record.id, { name: 'Renamed' })
        ).toMatchObject({ data: { name: 'Renamed' } });
        expect(await manager.deleteKnowledgeBase('user', record.id)).toBe(true);
        expect(vectorStore.deleted).toEqual([record.data.collection_name]);
        expect(await manager.deleteKnowledgeBase('user', record.id)).toBe(false);
    });

    test('resolves credentials and reports missing KB runtime records', async () => {
        const storage = new InMemoryStorage();
        const manager = new CollectionPerKbManager(storage, new FakeVectorStore());
        await expect(manager.getKnowledge('user', 'missing')).rejects.toEqual(
            new KnowledgeBaseNotFoundError("Knowledge base 'missing' not found.")
        );
        await storage.upsertCredential(
            'user',
            new OllamaCredential({ id: 'credential', host: 'http://localhost:11434' })
        );
        const record = await manager.createKnowledgeBase({
            userId: 'user',
            name: 'Knowledge',
            description: '',
            embeddingModelConfig: {
                type: 'ollama_credential',
                credential_id: 'credential',
                model: 'nomic-embed-text',
                dimensions: 768,
                parameters: {},
            },
        });
        await expect(manager.getKnowledge('user', record.id)).resolves.toMatchObject({
            name: 'Knowledge',
            collection: record.data.collection_name,
        });
    });
});
