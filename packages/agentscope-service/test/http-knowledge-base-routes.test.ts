/* eslint-disable jsdoc/require-description, jsdoc/require-param, jsdoc/require-returns */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { createApp, type AgentScopeServiceApp } from '../src/app';
import {
    AgentScopeHTTPRouter,
    registerFoundationRoutes,
    registerKnowledgeBaseRoutes,
} from '../src/http';
import { InMemoryMessageBus } from '../src/message-bus';
import { CollectionPerKbManager, LocalBlobStore } from '../src/rag';
import { InMemoryStorage, KnowledgeDocumentRecordSchema } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

/**
 *
 */
class TestVectorStore extends VectorStoreBase {
    readonly collections = new Map<string, number>();
    chunks: Chunk[] = [];
    results: VectorSearchResult[] = [];

    /**
     *
     * @param name
     * @param dimensions
     */
    async createCollection(name: string, dimensions: number): Promise<void> {
        this.collections.set(name, dimensions);
    }
    /**
     *
     * @param name
     */
    async deleteCollection(name: string): Promise<void> {
        this.collections.delete(name);
    }
    /**
     *
     * @param name
     */
    async hasCollection(name: string): Promise<boolean> {
        return this.collections.has(name);
    }
    /**
     *
     * @param _collection
     * @param _records
     */
    async insert(_collection: string, _records: VectorRecord[]): Promise<void> {}
    /**
     *
     */
    async delete(): Promise<void> {}
    /**
     *
     */
    async search(): Promise<VectorSearchResult[]> {
        return this.results;
    }
    /**
     *
     */
    async listDocuments(): Promise<DocumentSummary[]> {
        return [];
    }
    /**
     *
     * @param _collection
     * @param _documentId
     * @param options
     * @param options.offset
     * @param options.limit
     */
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

/**
 *
 */
class TestManager extends CollectionPerKbManager {
    /**
     *
     * @param userId
     * @param knowledgeBaseId
     */
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

const headers = { 'content-type': 'application/json', 'x-user-id': 'alice' };

/** Serialize JSON with lexicographically sorted object keys. */
function canonicalJSON(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** Hash one JSON value using Python's canonical fixture encoding. */
function schemaDigest(value: unknown): string {
    return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

describe('knowledge-base HTTP routes', () => {
    let directory: string;
    let app: AgentScopeServiceApp;
    let router: AgentScopeHTTPRouter;
    let vectorStore: TestVectorStore;
    let knowledgeBaseId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-kb-http-'));
        const storage = new InMemoryStorage();
        vectorStore = new TestVectorStore();
        app = createApp({
            storage,
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({
                baseDirectory: join(directory, 'workspaces'),
            }),
            knowledgeBaseManager: new TestManager(storage, vectorStore),
            blobStore: new LocalBlobStore(join(directory, 'blobs')),
            enableIndexWorker: false,
            enableScheduler: false,
            downloadSecret: 'test-secret',
        });
        await app.open();
        router = new AgentScopeHTTPRouter(app);
        registerFoundationRoutes(router);
        registerKnowledgeBaseRoutes(router);
        const credential = await call('/credential/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                data: { type: 'ollama_credential', name: 'Local', host: null },
            }),
        });
        const credentialId = ((await credential.json()) as { credential_id: string }).credential_id;
        const created = await call('/knowledge_bases/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: 'Docs',
                description: 'Reference',
                embedding_model_config: {
                    type: 'ollama_credential',
                    credential_id: credentialId,
                    model: 'nomic-embed-text',
                    dimensions: 2,
                    parameters: {},
                },
            }),
        });
        expect(created.status).toBe(201);
        knowledgeBaseId = ((await created.json()) as { knowledge_base_id: string })
            .knowledge_base_id;
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    const call = (path: string, init?: RequestInit) =>
        router.fetch(new Request(`http://service${path}`, init));

    test('advertises parser/chunker/middleware capabilities and filtered KB views', async () => {
        expect(await (await call('/knowledge_bases/chunkers', { headers })).json()).toEqual({
            chunkers: [
                {
                    type: 'approx_token',
                    parameter_schema: {
                        description: 'The tunable parameters of the approximate-token chunker.',
                        properties: {
                            chunk_size: {
                                default: 512,
                                description: 'Maximum number of approximate tokens per chunk.',
                                minimum: 1,
                                title: 'Chunk Size',
                                type: 'integer',
                            },
                            overlap: {
                                default: 50,
                                description:
                                    'Number of approximate tokens shared between consecutive chunks.',
                                minimum: 0,
                                title: 'Overlap',
                                type: 'integer',
                            },
                        },
                        title: 'Parameters',
                        type: 'object',
                    },
                },
            ],
        });
        expect(
            await (await call('/knowledge_bases/supported_content_types', { headers })).json()
        ).toMatchObject({ extensions: expect.arrayContaining(['.md', '.txt']) });
        const middlewareSchema = (await (
            await call('/knowledge_bases/middleware/parameters_schema', { headers })
        ).json()) as { parameter_schema: Record<string, unknown> };
        expect(schemaDigest(middlewareSchema.parameter_schema)).toBe(
            '24fc88b6d9d73ab0bf86eb3d09ca1b4b356649b47c2719f5da09e993892c8d3b'
        );
        const listed = await call('/knowledge_bases/?name=doc&page=1&page_size=1&desc=false', {
            headers,
        });
        expect(await listed.json()).toMatchObject({
            total: 1,
            page: 1,
            page_size: 1,
            knowledge_bases: [
                {
                    id: knowledgeBaseId,
                    name: 'Docs',
                    editable: true,
                    document_count: 0,
                    chunk_count: 0,
                },
            ],
        });
        const updated = await call(`/knowledge_bases/${knowledgeBaseId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ name: 'Updated' }),
        });
        expect(await updated.json()).toMatchObject({
            id: knowledgeBaseId,
            name: 'Updated',
            editable: true,
        });
    });

    test('uploads, filters, polls, downloads, and deletes a document', async () => {
        const form = new FormData();
        form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'hello.txt');
        const uploaded = await call(`/knowledge_bases/${knowledgeBaseId}/documents`, {
            method: 'POST',
            headers: { 'x-user-id': 'alice' },
            body: form,
        });
        expect(uploaded.status).toBe(201);
        const upload = (await uploaded.json()) as { document_id: string };
        expect(upload).toMatchObject({ filename: 'hello.txt', status: 'pending' });

        const expectedDocument = {
            id: upload.document_id,
            filename: 'hello.txt',
            size: 11,
            content_type: 'text/plain',
            status: 'pending',
            error: null,
            chunk_count: 0,
            created_at: expect.any(String),
            updated_at: expect.any(String),
        };
        expect(
            await (
                await call(
                    `/knowledge_bases/${knowledgeBaseId}/documents?keywords=HELLO&status=pending`,
                    { headers }
                )
            ).json()
        ).toEqual({
            total: 1,
            documents: [expectedDocument],
            page: 1,
            page_size: 30,
        });
        expect(
            await (
                await call(
                    `/knowledge_bases/${knowledgeBaseId}/documents/status?ids=${upload.document_id},missing`,
                    { headers }
                )
            ).json()
        ).toEqual({ items: [expectedDocument] });

        expect(
            (
                await call(
                    `/knowledge_bases/${knowledgeBaseId}/documents/${upload.document_id}?download=invalid`,
                    { headers }
                )
            ).status
        ).toBe(422);

        const direct = await call(
            `/knowledge_bases/${knowledgeBaseId}/documents/${upload.document_id}`,
            { headers: { 'x-user-id': 'alice' } }
        );
        expect(direct.status).toBe(200);
        expect(direct.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(direct.headers.get('content-disposition')).toBe(
            "inline; filename*=UTF-8''hello.txt"
        );
        expect(direct.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await direct.text()).toBe('hello world');

        const tokenResponse = await call(
            `/knowledge_bases/${knowledgeBaseId}/documents/${upload.document_id}/download_token`,
            { method: 'POST', headers }
        );
        const token = ((await tokenResponse.json()) as { token: string }).token;
        const tokenDownload = await call(
            `/knowledge_bases/${knowledgeBaseId}/documents/${upload.document_id}?download=true&token=${encodeURIComponent(token)}`
        );
        expect(tokenDownload.status).toBe(200);
        expect(tokenDownload.headers.get('content-disposition')).toBe(
            "attachment; filename*=UTF-8''hello.txt"
        );
        expect(await tokenDownload.text()).toBe('hello world');

        expect(
            (
                await call(`/knowledge_bases/${knowledgeBaseId}/documents/${upload.document_id}`, {
                    method: 'DELETE',
                    headers,
                })
            ).status
        ).toBe(204);
    });

    test('paginates chunks and returns search results as whole structures', async () => {
        const document = await app.storage.upsertKnowledgeDocument(
            'alice',
            // The vector store source of truth and storage record use the same id.
            KnowledgeDocumentRecordSchema.parse({
                id: 'document-1',
                user_id: 'alice',
                knowledge_base_id: knowledgeBaseId,
                status: 'ready',
                data: {
                    filename: 'ready.txt',
                    size: 1,
                    blob_uri: 'local://missing',
                    chunk_count: 2,
                },
            })
        );
        vectorStore.chunks = [
            {
                content: TextBlock({ text: 'one' }),
                source: 'ready.txt',
                chunk_index: 0,
                total_chunks: 2,
                metadata: {},
            },
            {
                content: TextBlock({ text: 'two' }),
                source: 'ready.txt',
                chunk_index: 1,
                total_chunks: 2,
                metadata: {},
            },
        ];
        vectorStore.results = [
            {
                score: 0.9,
                document_id: document.id,
                chunk: vectorStore.chunks[0],
            },
        ];
        expect(
            await (
                await call(
                    `/knowledge_bases/${knowledgeBaseId}/documents/${document.id}/chunks?page=2&page_size=1`,
                    { headers }
                )
            ).json()
        ).toEqual({
            chunks: [vectorStore.chunks[1]],
            total: 2,
            page: 2,
            page_size: 1,
        });
        expect(
            await (
                await call(`/knowledge_bases/${knowledgeBaseId}/search`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ query: 'one', top_k: 1 }),
                })
            ).json()
        ).toEqual({ results: vectorStore.results, total: 1 });
        expect(
            (
                await call(`/knowledge_bases/${knowledgeBaseId}/search`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ query: 'one', top_k: 51 }),
                })
            ).status
        ).toBe(422);
    });
});
