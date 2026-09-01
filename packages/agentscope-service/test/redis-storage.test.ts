/* eslint-disable jsdoc/require-jsdoc */

import { FakeRedisDriver } from './fake-redis-driver';
import { runStorageContract } from './storage-contract';
import {
    KnowledgeBaseRecordSchema,
    KnowledgeDocumentRecordSchema,
    MCPRecordSchema,
    RedisStorage,
    StorageConflictError,
} from '../src/storage';

let sequence = 0;

function createStorage(): RedisStorage {
    sequence += 1;
    return new RedisStorage({
        driver: new FakeRedisDriver(),
        prefix: `test:${sequence}`,
    });
}

runStorageContract('RedisStorage', {
    async create() {
        return createStorage().open();
    },
    async destroy(storage) {
        await storage.close();
    },
});

describe('RedisStorage atomic operations', () => {
    test('allows only one concurrent owner of a unique MCP name', async () => {
        const storage = await createStorage().open();
        const records = ['mcp-1', 'mcp-2'].map(id =>
            MCPRecordSchema.parse({
                id,
                user_id: 'user-1',
                client: {
                    name: 'shared',
                    is_stateful: false,
                    mcp_config: { type: 'http_mcp', url: 'https://example.com/mcp' },
                },
            })
        );

        const results = await Promise.allSettled(
            records.map(record => storage.upsertMCP('user-1', record))
        );

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(StorageConflictError);
        expect(await storage.listMCPs('user-1')).toHaveLength(1);
        await storage.close();
    });

    test('allows only one concurrent knowledge-document lease holder', async () => {
        const storage = await createStorage().open();
        await storage.upsertKnowledgeBase(
            'user-1',
            KnowledgeBaseRecordSchema.parse({
                id: 'kb-1',
                user_id: 'user-1',
                data: {
                    name: 'knowledge',
                    embedding_model_config: {
                        type: 'openai_credential',
                        credential_id: 'credential-1',
                        model: 'text-embedding-3-small',
                        dimensions: 8,
                    },
                    collection_name: 'kb_collection',
                },
            })
        );
        await storage.upsertKnowledgeDocument(
            'user-1',
            KnowledgeDocumentRecordSchema.parse({
                id: 'document-1',
                user_id: 'user-1',
                knowledge_base_id: 'kb-1',
                data: {
                    filename: 'document.txt',
                    size: 42,
                    blob_uri: 'local://document.txt',
                },
            })
        );

        const acquired = await Promise.all(
            ['worker-a', 'worker-b'].map(processingNode =>
                storage.acquireKnowledgeDocumentLease({
                    userId: 'user-1',
                    knowledgeBaseId: 'kb-1',
                    documentId: 'document-1',
                    processingNode,
                    leaseTtlMs: 1_000,
                })
            )
        );

        expect(acquired.filter(Boolean)).toHaveLength(1);
        await storage.close();
    });
});
