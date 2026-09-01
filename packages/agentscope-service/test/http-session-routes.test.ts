import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';

import { createApp, type AgentScopeServiceApp } from '../src/app';
import { AgentScopeHTTPRouter, registerFoundationRoutes, registerSessionRoutes } from '../src/http';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

const headers = { 'content-type': 'application/json', 'x-user-id': 'alice' };

describe('session, chat, schedule, and SSE routes', () => {
    let directory: string;
    let app: AgentScopeServiceApp;
    let router: AgentScopeHTTPRouter;
    let agentId: string;
    let credentialId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-session-http-'));
        app = createApp({
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({ baseDirectory: directory }),
            enableScheduler: false,
        });
        await app.open();
        router = new AgentScopeHTTPRouter(app);
        registerFoundationRoutes(router);
        registerSessionRoutes(router);
        agentId = await createAgent();
        credentialId = await createCredential();
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    const call = (path: string, init?: RequestInit) =>
        router.fetch(new Request(`http://service${path}`, init));

    /**
     *
     */
    async function createAgent(): Promise<string> {
        const response = await call('/agent/', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Agent' }),
        });
        return ((await response.json()) as { agent_id: string }).agent_id;
    }

    /**
     *
     */
    async function createCredential(): Promise<string> {
        const response = await call('/credential/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                data: { type: 'openai_credential', api_key: 'key', name: 'OpenAI' },
            }),
        });
        return ((await response.json()) as { credential_id: string }).credential_id;
    }

    /**
     *
     */
    async function createSession(): Promise<string> {
        const response = await call('/sessions/', {
            method: 'POST',
            headers,
            body: JSON.stringify({ agent_id: agentId, name: 'Chat' }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { session_id: string }).session_id;
    }

    test('creates, lists, patches, probes, and deletes sessions', async () => {
        const sessionId = await createSession();
        const duplicate = await createSession();
        expect(duplicate).toBe(sessionId);
        expect(
            await (await call(`/sessions/?agent_id=${agentId}`, { headers })).json()
        ).toMatchObject({
            total: 1,
            sessions: [
                {
                    session: { id: sessionId, config: { name: 'Chat' }, state: { context: [] } },
                    is_running: false,
                    status: 'idle',
                    team: null,
                },
            ],
        });
        const patched = await call(`/sessions/${sessionId}?agent_id=${agentId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
                cwd: '/work',
                fallback_chat_model_config: null,
                permission_mode: 'dont_ask',
            }),
        });
        expect(patched.status).toBe(200);
        expect(await patched.json()).toMatchObject({
            id: sessionId,
            config: { cwd: '/work', fallback_chat_model_config: null },
            state: { permission_context: { mode: 'dont_ask' } },
        });
        expect(
            await (
                await call(`/sessions/${sessionId}/status?agent_id=${agentId}`, { headers })
            ).json()
        ).toEqual({ session_id: sessionId, status: 'idle' });
        expect(
            await (
                await call(`/sessions/${sessionId}/messages?agent_id=${agentId}`, { headers })
            ).json()
        ).toEqual({ messages: [], is_running: false, has_more: false });
        expect(
            (
                await call(`/sessions/${sessionId}?agent_id=${agentId}`, {
                    method: 'DELETE',
                    headers,
                })
            ).status
        ).toBe(204);
    });

    test('returns 202 for interrupt and rejects a missing session', async () => {
        const sessionId = await createSession();
        const response = await call(`/sessions/${sessionId}/interrupt?agent_id=${agentId}`, {
            method: 'POST',
            headers,
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ session_id: sessionId });
        expect(
            (
                await call(`/sessions/missing/interrupt?agent_id=${agentId}`, {
                    method: 'POST',
                    headers,
                })
            ).status
        ).toBe(404);
    });

    test('replays buffered events as SSE with Python headers', async () => {
        const sessionId = await createSession();
        const event = createEvent({
            type: EventType.REPLY_START,
            session_id: sessionId,
            reply_id: 'reply-1',
            name: 'Agent',
            role: 'assistant',
        });
        await app.messageBus.sessionPublishEvent(sessionId, { ...event });
        const response = await call(`/sessions/${sessionId}/stream?agent_id=${agentId}`, {
            headers,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe(`data: ${JSON.stringify(event)}\n\n`);
        await reader.cancel();
    });

    test('validates schedule references and cron before mutation', async () => {
        const model = {
            type: 'openai_credential',
            credential_id: credentialId,
            model: 'gpt-4.1',
            parameters: {},
        };
        const invalid = await call('/schedule/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: 'Bad',
                cron_expression: 'not a cron',
                agent_id: agentId,
                chat_model_config: model,
            }),
        });
        expect(invalid.status).toBe(422);
        expect(await (await call('/schedule/', { headers })).json()).toEqual({
            schedules: [],
            total: 0,
        });
        const created = await call('/schedule/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: 'Daily',
                cron_expression: '0 9 * * *',
                agent_id: agentId,
                chat_model_config: model,
            }),
        });
        expect(created.status).toBe(201);
        const scheduleId = ((await created.json()) as { schedule_id: string }).schedule_id;
        expect(await (await call('/schedule/', { headers })).json()).toMatchObject({
            total: 1,
            schedules: [{ id: scheduleId, data: { name: 'Daily', timezone: 'UTC' } }],
        });
        const patched = await call(`/schedule/${scheduleId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ enabled: false }),
        });
        expect(await patched.json()).toMatchObject({ id: scheduleId, data: { enabled: false } });
        expect(await (await call(`/schedule/${scheduleId}/sessions`, { headers })).json()).toEqual({
            sessions: [],
            total: 0,
        });
        expect((await call(`/schedule/${scheduleId}`, { method: 'DELETE', headers })).status).toBe(
            204
        );
    });
});
