/* eslint-disable jsdoc/require-jsdoc */

import { EmbeddingResponse, type EmbeddingInput } from '../embedding';
import { Base64Source, DataBlock, TextBlock } from '../message';
import { Chunk, type Chunk as ChunkValue } from './document';
import { KnowledgeBase, type KnowledgeEmbeddingModel } from './knowledge';
import {
    VectorStoreBase,
    type ChunkListOptions,
    type DocumentSummary,
    type VectorRecord,
    type VectorSearchResult,
} from './vector-store';

class StubEmbedding implements KnowledgeEmbeddingModel {
    readonly dimensions = 3;
    readonly calls: EmbeddingInput[][] = [];
    responses: number[][] = [];

    constructor(readonly supportsMultimodal = false) {}

    async call(inputs: EmbeddingInput[]): Promise<EmbeddingResponse> {
        this.calls.push(inputs);
        return new EmbeddingResponse({
            embeddings: this.responses.length
                ? this.responses
                : inputs.map((_input, index) => [index + 1, 0, 0]),
        });
    }
}

class StubStore extends VectorStoreBase {
    exists = false;
    readonly createCollection = jest.fn(async (_name: string, _dimensions: number) => {
        this.exists = true;
    });
    readonly deleteCollection = jest.fn(async (_name: string) => undefined);
    readonly hasCollection = jest.fn(async (_name: string) => this.exists);
    readonly insert = jest.fn(async (_collection: string, _records: VectorRecord[]) => undefined);
    readonly delete = jest.fn(async (_collection: string, _documentId: string) => undefined);
    readonly search = jest.fn(
        async (
            _collection: string,
            _queryVector: number[],
            _topK?: number,
            _metadataFilter?: Record<string, unknown> | null
        ): Promise<VectorSearchResult[]> => []
    );
    readonly listDocuments = jest.fn(
        async (
            _collection: string,
            _metadataFilter?: Record<string, unknown> | null
        ): Promise<DocumentSummary[]> => []
    );
    override readonly listChunks = jest.fn(
        async (
            _collection: string,
            _documentId: string,
            _options?: ChunkListOptions
        ): Promise<ChunkValue[]> => []
    );
}

function chunk(text: string, index = 0, metadata: Record<string, unknown> = {}): ChunkValue {
    return Chunk({
        content: TextBlock({ text }),
        source: 'document.txt',
        chunk_index: index,
        total_chunks: 1,
        metadata,
    });
}

function result(documentId: string, index: number, score: number): VectorSearchResult {
    return { score, document_id: documentId, chunk: chunk(`${documentId}-${index}`, index) };
}

function fixture(
    options: {
        model?: StubEmbedding;
        store?: StubStore;
        metadataFilter?: Record<string, unknown> | null;
    } = {}
): { knowledge: KnowledgeBase; model: StubEmbedding; store: StubStore } {
    const model = options.model ?? new StubEmbedding();
    const store = options.store ?? new StubStore();
    return {
        model,
        store,
        knowledge: new KnowledgeBase({
            name: 'company-handbook',
            description: 'Internal policies.',
            embedding_model: model,
            vector_store: store,
            collection: 'handbook',
            metadata_filter: options.metadataFilter,
        }),
    };
}

describe('KnowledgeBase Python parity', () => {
    test('exposes immutable wiring and memoizes collection creation', async () => {
        const { knowledge, model, store } = fixture({ metadataFilter: { tenant: 'a' } });
        expect({
            name: knowledge.name,
            description: knowledge.description,
            embeddingModel: knowledge.embeddingModel,
            vectorStore: knowledge.vectorStore,
            collection: knowledge.collection,
            metadataFilter: knowledge.metadataFilter,
        }).toEqual({
            name: 'company-handbook',
            description: 'Internal policies.',
            embeddingModel: model,
            vectorStore: store,
            collection: 'handbook',
            metadataFilter: { tenant: 'a' },
        });
        await knowledge.ensureCollection();
        await knowledge.ensureCollection();
        expect(store.hasCollection).toHaveBeenCalledTimes(1);
        expect(store.createCollection).toHaveBeenCalledWith('handbook', 3);
        expect(store.createCollection).toHaveBeenCalledTimes(1);
    });

    test('memoizes an existing collection without recreating it', async () => {
        const store = new StubStore();
        store.exists = true;
        const { knowledge } = fixture({ store });
        await knowledge.ensureCollection();
        await knowledge.ensureCollection();
        expect(store.hasCollection).toHaveBeenCalledTimes(1);
        expect(store.createCollection).not.toHaveBeenCalled();
    });

    test('returns early for empty or unsupported-only queries', async () => {
        const { knowledge, model, store } = fixture();
        expect(await knowledge.search([])).toEqual([]);
        expect(
            await knowledge.search([
                DataBlock({ source: Base64Source({ data: 'aGk=', media_type: 'image/png' }) }),
            ])
        ).toEqual([]);
        expect(model.calls).toEqual([]);
        expect(store.hasCollection).not.toHaveBeenCalled();
    });

    test('filters unsupported data blocks before one batch embedding call', async () => {
        const { knowledge, model, store } = fixture({ metadataFilter: { tenant: 'a' } });
        const text = TextBlock({ text: 'Where is Paris?' });
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const hit = result('doc-1', 0, 0.8);
        store.search.mockResolvedValue([hit]);
        expect(await knowledge.search([text, data], 2)).toEqual([hit]);
        expect(model.calls).toEqual([[text]]);
        expect(store.search).toHaveBeenCalledWith('handbook', [1, 0, 0], 2, { tenant: 'a' });
    });

    test('keeps multimodal input and merges concurrent results by stable chunk identity', async () => {
        const model = new StubEmbedding(true);
        model.responses = [
            [1, 0, 0],
            [0, 1, 0],
        ];
        const { knowledge, store } = fixture({ model });
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const weakDuplicate = result('doc-1', 0, 0.4);
        const strongest = result('doc-2', 0, 0.9);
        const strongDuplicate = result('doc-1', 0, 0.8);
        store.search
            .mockResolvedValueOnce([weakDuplicate, strongest])
            .mockResolvedValueOnce([strongDuplicate, result('doc-3', 1, 0.7)]);
        expect(await knowledge.search(['query', data], 2, 0.5)).toEqual([
            strongest,
            strongDuplicate,
        ]);
        expect(model.calls).toEqual([['query', data]]);
        expect(store.search).toHaveBeenCalledTimes(2);
    });

    test('empty insert is a no-op and returns supplied or generated IDs', async () => {
        const { knowledge, model, store } = fixture();
        expect(await knowledge.insertDocument([], 'doc-1')).toBe('doc-1');
        expect(await knowledge.insertDocument([])).toMatch(/^[0-9a-f]{32}$/);
        expect(model.calls).toEqual([]);
        expect(store.insert).not.toHaveBeenCalled();
        expect(store.hasCollection).not.toHaveBeenCalled();
    });

    test('inserts aligned vectors with the exact metadata precedence', async () => {
        const { knowledge, model, store } = fixture({
            metadataFilter: { tenant: 'scope', locked: true },
        });
        const chunks = [
            chunk('A', 0, { tenant: 'chunk', author: 'parser' }),
            chunk('B', 1, { author: 'parser-2' }),
        ];
        const documentId = await knowledge.insertDocument(chunks, 'doc-1', {
            tenant: 'document',
            author: 'document',
            filename: 'handbook.txt',
        });
        expect(documentId).toBe('doc-1');
        expect(chunks.map(value => value.metadata)).toEqual([
            { tenant: 'scope', author: 'parser', filename: 'handbook.txt', locked: true },
            { tenant: 'scope', author: 'parser-2', filename: 'handbook.txt', locked: true },
        ]);
        expect(model.calls).toEqual([[chunks[0].content, chunks[1].content]]);
        const records = store.insert.mock.calls[0][1] as VectorRecord[];
        expect(records).toEqual([
            { vector: [1, 0, 0], document_id: 'doc-1', chunk: chunks[0] },
            { vector: [2, 0, 0], document_id: 'doc-1', chunk: chunks[1] },
        ]);
    });

    test('rejects embedding count mismatches before writing', async () => {
        const model = new StubEmbedding();
        model.responses = [[1, 0, 0]];
        const { knowledge, store } = fixture({ model });
        await expect(knowledge.insertDocument([chunk('A'), chunk('B')], 'doc-1')).rejects.toThrow(
            'Embedding model returned 1 vectors for 2 chunks.'
        );
        expect(store.insert).not.toHaveBeenCalled();
    });

    test('scopes delete, document listing, and chunk pagination after ensuring', async () => {
        const { knowledge, store } = fixture({ metadataFilter: { tenant: 'a' } });
        const summaries: DocumentSummary[] = [
            { document_id: 'doc-1', source: 'a.txt', chunk_count: 2, metadata: {} },
        ];
        const chunks = [chunk('A', 2)];
        store.listDocuments.mockResolvedValue(summaries);
        store.listChunks.mockResolvedValue(chunks);
        await knowledge.deleteDocument('doc-1');
        expect(await knowledge.listDocuments()).toBe(summaries);
        expect(await knowledge.listChunks('doc-1', 2, 4)).toBe(chunks);
        expect(store.delete).toHaveBeenCalledWith('handbook', 'doc-1');
        expect(store.listDocuments).toHaveBeenCalledWith('handbook', { tenant: 'a' });
        expect(store.listChunks).toHaveBeenCalledWith('handbook', 'doc-1', {
            offset: 2,
            limit: 4,
            metadata_filter: { tenant: 'a' },
        } satisfies ChunkListOptions);
        expect(store.hasCollection).toHaveBeenCalledTimes(1);
    });
});
