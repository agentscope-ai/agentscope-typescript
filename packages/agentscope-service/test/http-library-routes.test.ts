import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { createApp, type AgentScopeServiceApp } from '../src/app';
import { ChannelBase, type ChannelEmitter, type ChannelEvent } from '../src/channel';
import { AgentScopeHTTPRouter, registerFoundationRoutes, registerLibraryRoutes } from '../src/http';
import {
    MCPCard,
    MCPHubBase,
    MCPHubPage,
    SkillCard,
    SkillHubBase,
    SkillHubPage,
    type SkillArchive,
} from '../src/hub';
import type { BusPayload } from '../src/message-bus';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { LocalWorkspaceManager } from '../src/workspace-manager';

/**
 *
 */
class FakeChannel extends ChannelBase {
    static override readonly channelType = 'fake';
    static override readonly displayName = 'Fake';
    static override readonly platformBotIdField = 'bot_id';
    static override readonly credentialsSchema = z.object({
        bot_id: z.string(),
        secret: z.string(),
    });
    static override readonly configSchema = z.object({ region: z.string().default('global') });
    readonly channelId: string;

    /**
     *
     * @param channelId
     */
    constructor(channelId: string) {
        super();
        this.channelId = channelId;
    }

    /**
     *
     * @param _emit
     */
    async startListening(_emit: ChannelEmitter): Promise<void> {}
    /**
     *
     * @param _event
     * @param _events
     */
    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}
    /**
     *
     */
    override async listBotChats(): Promise<Record<string, unknown>[]> {
        return [{ chat_id: 'chat-platform', name: 'Platform chat' }];
    }
}

/**
 *
 */
class FakeMCPHub extends MCPHubBase {
    /**
     *
     */
    constructor() {
        super({ hubId: 'fake', displayName: 'Fake MCP' });
    }

    /**
     *
     */
    async listMCPs(): Promise<MCPHubPage> {
        return new MCPHubPage([await this.getMCP('', 'echo')], 'next');
    }

    /**
     *
     * @param _userId
     * @param cardId
     */
    async getMCP(_userId: string, cardId: string): Promise<MCPCard> {
        if (cardId !== 'echo') throw new Error('missing');
        return new MCPCard({
            hubId: 'fake',
            name: 'echo',
            displayName: 'Echo',
            description: 'Echo server',
            isStateful: false,
            inputsSchema: {
                type: 'object',
                properties: { key: { type: 'string', writeOnly: true } },
                required: ['key'],
            },
            configTemplate: {
                type: 'http_mcp',
                url: 'https://example.invalid/${key}',
            },
        });
    }
}

/**
 *
 */
class FakeSkillHub extends SkillHubBase {
    /**
     *
     */
    constructor() {
        super({ hubId: 'skills', displayName: 'Skills' });
    }

    /**
     *
     */
    async listSkills(): Promise<SkillHubPage> {
        return new SkillHubPage([await this.getSkill('', 'owner/music')]);
    }

    /**
     *
     * @param _userId
     * @param cardId
     */
    async getSkill(_userId: string, cardId: string): Promise<SkillCard> {
        if (cardId !== 'owner/music') throw new Error('missing');
        return new SkillCard({
            hubId: 'skills',
            id: cardId,
            name: 'music',
            displayName: 'Music',
            markdown: '# Music',
        });
    }

    /**
     *
     */
    async download(): Promise<SkillArchive> {
        return { format: 'zip', stream: (async function* () {})() };
    }
}

const headers = { 'content-type': 'application/json', 'x-user-id': 'alice' };

describe('channel, hub, MCP, and skill HTTP routes', () => {
    let directory: string;
    let app: AgentScopeServiceApp;
    let router: AgentScopeHTTPRouter;
    let agentId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'agentscope-library-http-'));
        app = createApp({
            storage: new InMemoryStorage(),
            messageBus: new InMemoryMessageBus(),
            workspaceManager: new LocalWorkspaceManager({ baseDirectory: directory }),
            enableScheduler: false,
            channels: [FakeChannel],
            mcpHubs: [new FakeMCPHub()],
            skillHubs: [new FakeSkillHub()],
        });
        await app.open();
        router = new AgentScopeHTTPRouter(app);
        registerFoundationRoutes(router);
        registerLibraryRoutes(router);
        const created = await call('/agent/', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Agent' }),
        });
        agentId = ((await created.json()) as { agent_id: string }).agent_id;
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    const call = (path: string, init?: RequestInit) =>
        router.fetch(new Request(`http://service${path}`, init));

    test('provides channel schemas and owner-scoped channel lifecycle', async () => {
        expect(await (await call('/channels/types', { headers })).json()).toEqual([
            expect.objectContaining({
                channel_type: 'fake',
                display_name: 'Fake',
                platform_bot_id_field: 'bot_id',
            }),
        ]);
        const created = await call('/channels/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channel_type: 'fake',
                credentials: { bot_id: 'bot-1', secret: 'hidden' },
                routing: { bindings: [{ match_value: '*', agent_id: agentId }] },
                session: { chat_model_config: {} },
            }),
        });
        expect(created.status).toBe(201);
        const body = (await created.json()) as { id: string; credentials?: unknown };
        expect(body).not.toHaveProperty('credentials');
        expect(body).toMatchObject({ channel_type: 'fake', platform_bot_id: 'bot-1' });
        expect(await (await call(`/channels/${body.id}/status`, { headers })).json()).toEqual({
            state: 'stopped',
            last_error: '',
        });
        expect(await (await call(`/channels/${body.id}/chat_ids`, { headers })).json()).toEqual({
            chats: [{ chat_id: 'chat-platform', name: 'Platform chat', source: 'platform' }],
        });
        expect(
            await (await call(`/channels/${body.id}/disable`, { method: 'POST', headers })).json()
        ).toEqual({ status: 'disabled' });
        expect(
            (
                await call(`/channels/${body.id}`, {
                    headers: { ...headers, 'x-user-id': 'bob' },
                })
            ).status
        ).toBe(403);
        expect((await call(`/channels/${body.id}`, { method: 'DELETE', headers })).status).toBe(
            204
        );
    });

    test('browses, installs, updates, and removes MCPs without echoing secrets', async () => {
        expect(await (await call('/hub/mcp', { headers })).json()).toEqual([
            { hub_id: 'fake', display_name: 'Fake MCP', description: '', icon_url: null },
        ]);
        expect(await (await call('/hub/mcp/fake/cards', { headers })).json()).toMatchObject({
            next_cursor: 'next',
            cards: [{ name: 'echo', inputs_schema: { required: ['key'] } }],
        });
        const bad = await call('/hub/mcp/fake/cards/echo/install', {
            method: 'POST',
            headers,
            body: JSON.stringify({ values: {} }),
        });
        expect(bad.status).toBe(400);
        const installed = await call('/hub/mcp/fake/cards/echo/install', {
            method: 'POST',
            headers,
            body: JSON.stringify({ values: { key: 'secret' } }),
        });
        expect(installed.status).toBe(201);
        const view = (await installed.json()) as { id: string };
        expect(JSON.stringify(view)).not.toContain('secret');
        expect(await (await call('/mcp', { headers })).json()).toEqual([
            expect.objectContaining({ id: view.id, name: 'echo', hub_id: 'fake', enabled: true }),
        ]);
        const updated = await call(`/mcp/${view.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ name: 'echo2', enabled: false, values: { key: 'new' } }),
        });
        expect(await updated.json()).toMatchObject({ name: 'echo2', enabled: false });
        expect((await call(`/mcp/${view.id}`, { method: 'DELETE', headers })).status).toBe(204);
    });

    test('preserves slash card ids and keeps skill markdown detail-only', async () => {
        const installed = await call('/hub/skill/skills/cards/owner%2Fmusic/install', {
            method: 'POST',
            headers,
        });
        expect(installed.status).toBe(201);
        const view = (await installed.json()) as { id: string };
        expect(view).toMatchObject({ name: 'music', card_id: 'owner/music' });
        expect(await (await call('/skill', { headers })).json()).toEqual([
            expect.not.objectContaining({ markdown: expect.anything() }),
        ]);
        expect(await (await call(`/skill/${view.id}`, { headers })).json()).toMatchObject({
            markdown: '# Music',
        });
        expect((await call(`/skill/${view.id}`, { method: 'DELETE', headers })).status).toBe(204);
    });
});
