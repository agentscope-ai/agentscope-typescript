import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, type AgentScopeServiceApp } from '../src/app';
import { AgentScopeHTTPRouter, registerFoundationRoutes } from '../src/http';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

const headers = { 'content-type': 'application/json', 'x-user-id': 'alice' };

describe('foundation HTTP routes', () => {
    let directory: string;
    let app: AgentScopeServiceApp;
    let router: AgentScopeHTTPRouter;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-http-'));
        app = createApp({
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({ baseDirectory: directory }),
            enableScheduler: false,
            version: '1.2.3',
        });
        router = new AgentScopeHTTPRouter(app);
        registerFoundationRoutes(router);
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    const call = (path: string, init?: RequestInit) =>
        router.fetch(new Request(`http://service${path}`, init));

    test('reports readiness and requires X-User-ID', async () => {
        expect((await call('/health')).status).toBe(422);
        const cold = await call('/health', { headers });
        expect(cold.status).toBe(503);
        expect(await cold.json()).toMatchObject({
            status: 'not_ready',
            version: '1.2.3',
            components: { chat_service: 'not_ready', knowledge_base: 'disabled' },
        });
        await app.open();
        const ready = await call('/health', { headers });
        expect(ready.status).toBe(200);
        expect(await ready.json()).toMatchObject({
            status: 'ok',
            components: { chat_service: 'ok', storage: 'ok' },
        });
    });

    test('serves schemas and complete agent CRUD with Python status codes', async () => {
        await app.open();
        const schema = await call('/agent/schema/v2', { headers });
        expect(schema.status).toBe(200);
        const schemaBody = (await schema.json()) as { schema: { properties: object } };
        expect(schemaBody.schema.properties).toHaveProperty('invite_config');
        expect(schemaBody.schema.properties).not.toHaveProperty('id');

        const created = await call('/agent/', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Helper' }),
        });
        expect(created.status).toBe(201);
        const agentId = ((await created.json()) as { agent_id: string }).agent_id;
        const listed = await call('/agent/', { headers });
        expect(await listed.json()).toMatchObject({
            total: 1,
            agents: [{ id: agentId, editable: true, data: { name: 'Helper' } }],
        });
        const updated = await call(`/agent/${agentId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ system_prompt: 'Updated' }),
        });
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({
            id: agentId,
            editable: true,
            data: { system_prompt: 'Updated' },
        });
        expect((await call(`/agent/${agentId}`, { method: 'DELETE', headers })).status).toBe(204);
        expect(await (await call('/agent/', { headers })).json()).toMatchObject({ total: 0 });
    });

    test('serves credential CRUD without leaking across users', async () => {
        await app.open();
        const created = await call('/credential/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                data: {
                    type: 'openai_credential',
                    name: 'OpenAI',
                    api_key: 'secret',
                },
            }),
        });
        expect(created.status).toBe(201);
        const credentialId = ((await created.json()) as { credential_id: string }).credential_id;
        expect(await (await call('/credential/', { headers })).json()).toMatchObject({
            total: 1,
            credentials: [{ id: credentialId, data: { api_key: 'secret' }, editable: true }],
        });
        expect(
            await (
                await call('/credential/', { headers: { ...headers, 'x-user-id': 'bob' } })
            ).json()
        ).toEqual({ credentials: [], total: 0 });
        const updated = await call(`/credential/${credentialId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
                data: {
                    type: 'openai_credential',
                    name: 'Renamed',
                    api_key: 'new-secret',
                },
            }),
        });
        expect(await updated.json()).toMatchObject({
            id: credentialId,
            editable: true,
            data: { name: 'Renamed', api_key: 'new-secret' },
        });
        expect(
            (await call(`/credential/${credentialId}`, { method: 'DELETE', headers })).status
        ).toBe(204);
    });

    test('returns provider model catalogs and provider 404s', async () => {
        await app.open();
        const chat = await call('/model/?provider=openai_credential', { headers });
        expect(chat.status).toBe(200);
        expect((await chat.json()) as { total: number }).toMatchObject({ total: 13 });
        const embedding = await call('/embedding-model/?provider=openai_credential', { headers });
        expect((await embedding.json()) as { total: number }).toMatchObject({ total: 2 });
        const tts = await call('/tts-model/?provider=openai_credential', { headers });
        expect((await tts.json()) as { total: number }).toMatchObject({ total: 3 });
        const missing = await call('/model/?provider=missing', { headers });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ detail: "Provider 'missing' not found." });
    });
});
