import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStorageContract } from './storage-contract';
import {
    BetterSQLiteDriver,
    MCPRecordSchema,
    SQLStorage,
    StorageConflictError,
} from '../src/storage';

runStorageContract('SQLStorage SQLite', {
    async create() {
        return new SQLStorage().open();
    },
    async destroy(storage) {
        await storage.close();
    },
});

describe('SQLStorage SQLite behavior', () => {
    test('persists records across owned-driver restarts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'agentscope-sql-'));
        const filename = join(directory, 'storage.sqlite');
        try {
            const first = await new SQLStorage({ filename }).open();
            await first.upsertMCP(
                'user-1',
                MCPRecordSchema.parse({
                    id: 'mcp-1',
                    user_id: 'user-1',
                    client: {
                        name: 'persistent',
                        is_stateful: false,
                        mcp_config: { type: 'http_mcp', url: 'https://example.com/mcp' },
                    },
                })
            );
            await first.close();

            const second = await new SQLStorage({ filename }).open();
            expect(await second.getMCPByName('user-1', 'persistent')).toEqual(
                expect.objectContaining({ id: 'mcp-1' })
            );
            await second.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('rolls back a failed transaction', async () => {
        const driver = new BetterSQLiteDriver();
        await driver.open();
        await expect(
            driver.transaction(async () => {
                await driver.compareAndSetRecord(
                    {
                        kind: 'test',
                        id: 'record-1',
                        userId: 'user-1',
                        payload: '{}',
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                    null
                );
                throw new Error('rollback');
            })
        ).rejects.toThrow('rollback');
        expect(await driver.getRecord('test', 'record-1')).toBeNull();
        await driver.close();
    });

    test('allows only one concurrent owner of a unique MCP name', async () => {
        const storage = await new SQLStorage().open();
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
});
