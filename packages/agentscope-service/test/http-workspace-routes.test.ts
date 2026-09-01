import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, type AgentScopeServiceApp } from '../src/app';
import {
    AgentScopeHTTPRouter,
    registerFoundationRoutes,
    registerLibraryRoutes,
    registerSessionRoutes,
    registerWorkspaceRoutes,
} from '../src/http';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

const headers = { 'content-type': 'application/json', 'x-user-id': 'alice' };

describe('workspace HTTP routes', () => {
    let directory: string;
    let app: AgentScopeServiceApp;
    let router: AgentScopeHTTPRouter;
    let agentId: string;
    let sessionId: string;
    let scope: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-workspace-http-'));
        app = createApp({
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({
                baseDirectory: join(directory, 'workspaces'),
            }),
            enableScheduler: false,
            downloadSecret: 'workspace-secret',
        });
        await app.open();
        router = new AgentScopeHTTPRouter(app);
        registerFoundationRoutes(router);
        registerLibraryRoutes(router);
        registerSessionRoutes(router);
        registerWorkspaceRoutes(router);
        agentId = (
            (await (
                await call('/agent/', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: 'Agent' }),
                })
            ).json()) as { agent_id: string }
        ).agent_id;
        sessionId = (
            (await (
                await call('/sessions/', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ agent_id: agentId }),
                })
            ).json()) as { session_id: string }
        ).session_id;
        scope = `agent_id=${agentId}&session_id=${sessionId}`;
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    const call = (path: string, init?: RequestInit) =>
        router.fetch(new Request(`http://service${path}`, init));

    test('adds/removes MCPs and mirrors hand-entered MCPs into the library', async () => {
        const wire = {
            name: 'echo',
            is_stateful: false,
            mcp_config: { type: 'http_mcp', url: 'https://example.invalid/mcp' },
            enable_tools: null,
            disable_tools: null,
            execution_timeout: null,
        };
        const added = await call(`/workspace/mcp?${scope}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(wire),
        });
        expect(added.status).toBe(201);
        expect(await (await call('/mcp', { headers })).json()).toEqual([
            expect.objectContaining({ name: 'echo', hub_id: null, enabled: true }),
        ]);
        const duplicate = await call(`/workspace/mcp?${scope}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(wire),
        });
        expect(duplicate.status).toBe(409);
        expect(
            (await call(`/workspace/mcp/echo?${scope}`, { method: 'DELETE', headers })).status
        ).toBe(204);

        const missing = await call(`/workspace/mcp/from-library?${scope}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ mcp_ids: ['missing'] }),
        });
        expect(await missing.json()).toEqual({
            added: [],
            failed: { missing: 'Not in your library.' },
        });
    });

    test('validates and installs multipart skill folders', async () => {
        const invalid = new FormData();
        invalid.append(
            'manifest',
            JSON.stringify({ entries: [{ path: 'bad/readme.md', size: 1 }] })
        );
        invalid.append('files', new Blob(['x']), 'readme.md');
        expect(
            (
                await call(`/workspace/skill/upload?${scope}`, {
                    method: 'POST',
                    headers: { 'x-user-id': 'alice' },
                    body: invalid,
                })
            ).status
        ).toBe(422);

        const markdown = '---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo\n';
        const form = new FormData();
        form.append(
            'manifest',
            JSON.stringify({ entries: [{ path: 'demo/SKILL.md', size: markdown.length }] })
        );
        form.append('files', new Blob([markdown], { type: 'text/markdown' }), 'SKILL.md');
        const installed = await call(`/workspace/skill/upload?${scope}`, {
            method: 'POST',
            headers: { 'x-user-id': 'alice' },
            body: form,
        });
        expect(installed.status).toBe(201);
        expect(await (await call(`/workspace/skill?${scope}`, { headers })).json()).toEqual([
            expect.objectContaining({
                name: 'demo',
                description: 'Demo skill.',
                markdown: '\n# Demo\n',
            }),
        ]);
        expect(
            (await call(`/workspace/skill/demo?${scope}`, { method: 'DELETE', headers })).status
        ).toBe(204);
        expect(await (await call(`/workspace/skill?${scope}`, { headers })).json()).toEqual([]);
    });

    test('lists directories, reports status, and streams files with signed tokens', async () => {
        const workspace = await app.services.workspace.resolve('alice', agentId, sessionId);
        const backend = workspace.getBackend();
        const file = backend.joinPath(workspace.workdir, 'report.txt');
        await backend.writeFile(file, Buffer.from('report body'));

        expect(await (await call(`/workspace/directories?${scope}`, { headers })).json()).toEqual({
            path: workspace.workdir,
            entries: expect.arrayContaining([
                expect.objectContaining({
                    name: 'report.txt',
                    is_dir: false,
                    size_bytes: 11,
                }),
            ]),
        });
        expect(await (await call(`/workspace/status?${scope}`, { headers })).json()).toMatchObject({
            workdir: workspace.workdir,
            cwd: workspace.workdir,
            git: null,
        });
        expect(
            (
                await call(`/workspace/files/download-token?${scope}`, {
                    method: 'POST',
                    headers,
                })
            ).status
        ).toBe(422);
        expect((await call(`/workspace/files?${scope}`, { headers })).status).toBe(422);

        const direct = await call(`/workspace/files?${scope}&path=report.txt`, {
            headers: { 'x-user-id': 'alice' },
        });
        expect(direct.status).toBe(200);
        expect(direct.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(await direct.text()).toBe('report body');

        const tokenResponse = await call(
            `/workspace/files/download-token?${scope}&path=report.txt`,
            { method: 'POST', headers }
        );
        const token = ((await tokenResponse.json()) as { token: string }).token;
        const downloaded = await call(
            `/workspace/files?${scope}&path=report.txt&download=true&token=${encodeURIComponent(token)}`
        );
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get('content-disposition')).toBe(
            "attachment; filename*=UTF-8''report.txt"
        );
        expect(await downloaded.text()).toBe('report body');
        expect((await call(`/workspace/files?${scope}&path=report.txt`)).status).toBe(401);
        expect(
            (await call(`/workspace/directories?${scope}&path=report.txt`, { headers })).status
        ).toBe(400);
    });
});
