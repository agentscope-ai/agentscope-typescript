import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app';
import { serveHTTP } from '../src/http';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

describe('Node HTTP adapter', () => {
    test('owns service lifecycle and bridges native HTTP bodies and responses', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'agentscope-node-http-'));
        const app = createApp({
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({ baseDirectory: directory }),
            enableScheduler: false,
            version: '9.8.7',
        });
        const running = await serveHTTP(app);
        try {
            expect(app.started).toBe(true);
            const address = running.server.address() as AddressInfo;
            const base = `http://127.0.0.1:${address.port}`;
            const health = await fetch(`${base}/health`, {
                headers: { 'x-user-id': 'alice' },
            });
            expect(health.status).toBe(200);
            expect(await health.json()).toMatchObject({ status: 'ok', version: '9.8.7' });

            const created = await fetch(`${base}/agent/`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'alice',
                },
                body: JSON.stringify({ name: 'Native HTTP' }),
            });
            expect(created.status).toBe(201);
            expect(await created.json()).toHaveProperty('agent_id');
        } finally {
            await running.close();
            await rm(directory, { recursive: true, force: true });
        }
        expect(app.started).toBe(false);
    });
});
