import type { MCPClient } from '@agentscope-ai/agentscope/mcp';
import { z } from 'zod';

import { ChannelClients } from '../../channel';
import type { MCPHubBase, SkillHubBase } from '../../hub';
import { MCPRenderError, renderMCP } from '../../service';
import {
    MCPRecordSchema,
    SkillRecordSchema,
    type ChannelRecord,
    type MCPRecord,
    type SkillRecord,
} from '../../storage';
import { HTTPError } from '../errors';
import { emptyResponse, jsonResponse } from '../response';
import type { AgentScopeHTTPRouter, HTTPContext } from '../router';
import {
    CreateChannelRequestSchema,
    HubPageQuerySchema,
    InstallMCPRequestSchema,
    UpdateChannelRequestSchema,
    UpdateMCPRequestSchema,
} from '../schemas';

/**
 * Register channels, hubs, and user-level MCP/skill libraries.
 * @param router
 */
export function registerLibraryRoutes(router: AgentScopeHTTPRouter): void {
    registerChannelRoutes(router);
    registerHubRoutes(router);
    registerMCPRoutes(router);
    registerSkillRoutes(router);
}

/**
 *
 * @param router
 */
function registerChannelRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/channels/types', context => {
        context.userId();
        return jsonResponse(context.app.channelTypeRegistry.listTypes().map(item => item.toJSON()));
    });
    router.get('/channels/', async context => {
        const records = await context.app.storage.listChannels(context.userId());
        return jsonResponse(records.map(record => channelView(context, record)));
    });
    router.post('/channels/', async context => {
        const body = (await context.json(CreateChannelRequestSchema)) as z.output<
            typeof CreateChannelRequestSchema
        >;
        try {
            const record = await context.app.services.channel.create({
                userId: context.userId(),
                channelType: body.channel_type,
                name: body.name,
                credentials: body.credentials,
                platformConfig: body.platform_config,
                routing: body.routing,
                session: body.session,
                enabled: body.enabled,
            });
            return jsonResponse(channelView(context, record), 201);
        } catch (error) {
            throw routeError(error, 400);
        }
    });
    router.get('/channels/{channel_id}', async context =>
        jsonResponse(channelView(context, await ownedChannel(context)))
    );
    router.patch('/channels/{channel_id}', async context => {
        await ownedChannel(context);
        const body = (await context.json(UpdateChannelRequestSchema)) as z.output<
            typeof UpdateChannelRequestSchema
        >;
        if (Object.keys(body).length === 0) throw new HTTPError(400, 'No fields to update.');
        try {
            return jsonResponse(
                channelView(
                    context,
                    await context.app.services.channel.update(context.params.channel_id, body)
                )
            );
        } catch (error) {
            throw routeError(error, 400);
        }
    });
    router.delete('/channels/{channel_id}', async context => {
        await ownedChannel(context);
        await context.app.services.channel.delete(context.params.channel_id);
        return emptyResponse();
    });
    for (const [action, enabled] of [
        ['enable', true],
        ['disable', false],
    ] as const) {
        router.post(`/channels/{channel_id}/${action}`, async context => {
            await ownedChannel(context);
            await context.app.services.channel.setEnabled(context.params.channel_id, enabled);
            return jsonResponse({ status: enabled ? 'enabled' : 'disabled' });
        });
    }
    router.get('/channels/{channel_id}/status', async context => {
        await ownedChannel(context);
        return jsonResponse(
            (await context.app.services.channel.getStatus(context.params.channel_id)).toJSON()
        );
    });
    router.get('/channels/{channel_id}/sessions', async context => {
        await ownedChannel(context);
        const sessions = await context.app.storage.listSessionsByChannel(
            context.userId(),
            context.params.channel_id
        );
        return jsonResponse({ sessions, total: sessions.length });
    });
    router.get('/channels/{channel_id}/chat_ids', async context => {
        await ownedChannel(context);
        const chats: Array<{ chat_id: string; name: string; source: string }> = [];
        const platformIds = new Set<string>();
        if (context.app.channelClients instanceof ChannelClients) {
            const channel = await context.app.channelClients.get(context.params.channel_id);
            for (const item of channel ? await channel.listBotChats() : []) {
                const chatId = typeof item.chat_id === 'string' ? item.chat_id : '';
                if (chatId) {
                    platformIds.add(chatId);
                    chats.push({
                        chat_id: chatId,
                        name: typeof item.name === 'string' ? item.name : '',
                        source: 'platform',
                    });
                }
            }
        }
        for (const chatId of await context.app.services.channel.listSeenChatIds(
            context.params.channel_id
        )) {
            if (!platformIds.has(chatId)) {
                chats.push({ chat_id: chatId, name: '', source: 'recorded' });
            }
        }
        return jsonResponse({ chats });
    });
}

/**
 *
 * @param router
 */
function registerHubRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/hub/mcp', context => {
        context.userId();
        return jsonResponse(describeHubs(context.app.mcpHubs));
    });
    router.get('/hub/skill', context => {
        context.userId();
        return jsonResponse(describeHubs(context.app.skillHubs));
    });
    router.get('/hub/mcp/{hub_id}/cards', async context => {
        const query = context.query(HubPageQuerySchema) as z.output<typeof HubPageQuerySchema>;
        const page = await pickHub(context.app.mcpHubs, context.params.hub_id).listMCPs(
            context.userId(),
            query.q,
            query.cursor,
            query.limit
        );
        return jsonResponse(page.toJSON());
    });
    router.get('/hub/mcp/{hub_id}/cards/{card_id}', async context => {
        try {
            return jsonResponse(
                (
                    await pickHub(context.app.mcpHubs, context.params.hub_id).getMCP(
                        context.userId(),
                        context.params.card_id
                    )
                ).toJSON()
            );
        } catch (error) {
            throw hubCardError(error, context.params.hub_id, 'MCP', context.params.card_id);
        }
    });
    router.post('/hub/mcp/{hub_id}/cards/{card_id}/install', async context => {
        const userId = context.userId();
        const body = (await context.json(InstallMCPRequestSchema)) as z.output<
            typeof InstallMCPRequestSchema
        >;
        let card;
        try {
            card = await pickHub(context.app.mcpHubs, context.params.hub_id).getMCP(
                userId,
                context.params.card_id
            );
        } catch (error) {
            throw hubCardError(error, context.params.hub_id, 'MCP', context.params.card_id);
        }
        let client;
        try {
            client = renderMCP(card, body.values, body.name);
        } catch (error) {
            if (error instanceof MCPRenderError) throw new HTTPError(400, error.message);
            throw error;
        }
        const record = MCPRecordSchema.parse({
            user_id: userId,
            client: mcpClientWire(client),
            values: body.values,
            display_name: card.displayName,
            description: card.description,
            tags: card.tags,
            author: card.author,
            icon_url: card.iconUrl,
            url: card.url,
            hub_id: card.hubId,
            card_id: card.id,
            version: card.version,
        });
        try {
            await context.app.storage.upsertMCP(userId, record);
        } catch (error) {
            throw new HTTPError(
                409,
                `${String(error)} Pass a different 'name' to install it alongside the existing one.`
            );
        }
        return jsonResponse(mcpView(record), 201);
    });
    router.get('/hub/skill/{hub_id}/cards', async context => {
        const query = context.query(HubPageQuerySchema) as z.output<typeof HubPageQuerySchema>;
        const page = await pickHub(context.app.skillHubs, context.params.hub_id).listSkills(
            context.userId(),
            query.q,
            query.cursor,
            query.limit
        );
        return jsonResponse(page.toJSON());
    });
    router.post('/hub/skill/{hub_id}/cards/{card_id:path}/install', async context => {
        const userId = context.userId();
        let card;
        try {
            card = await pickHub(context.app.skillHubs, context.params.hub_id).getSkill(
                userId,
                context.params.card_id
            );
        } catch (error) {
            throw hubCardError(error, context.params.hub_id, 'skill', context.params.card_id);
        }
        const record = SkillRecordSchema.parse({
            user_id: userId,
            name: context.url.searchParams.get('name') || card.name,
            display_name: card.displayName,
            description: card.description,
            tags: card.tags,
            author: card.author,
            icon_url: card.iconUrl,
            url: card.url,
            markdown: card.markdown ?? '',
            hub_id: card.hubId,
            card_id: card.id,
            version: card.version,
        });
        try {
            await context.app.storage.upsertSkill(userId, record);
        } catch (error) {
            throw new HTTPError(
                409,
                `${String(error)} Pass a different 'name' to install it alongside the existing one.`
            );
        }
        return jsonResponse(skillView(record), 201);
    });
    router.get('/hub/skill/{hub_id}/cards/{card_id:path}', async context => {
        try {
            return jsonResponse(
                (
                    await pickHub(context.app.skillHubs, context.params.hub_id).getSkill(
                        context.userId(),
                        context.params.card_id
                    )
                ).toJSON()
            );
        } catch (error) {
            throw hubCardError(error, context.params.hub_id, 'skill', context.params.card_id);
        }
    });
}

/**
 *
 * @param router
 */
function registerMCPRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/mcp', async context => {
        const records = await context.app.storage.listMCPs(context.userId());
        return jsonResponse(records.map(mcpView).sort((a, b) => a.name.localeCompare(b.name)));
    });
    router.patch('/mcp/{mcp_id}', async context => {
        const userId = context.userId();
        const body = (await context.json(UpdateMCPRequestSchema)) as z.output<
            typeof UpdateMCPRequestSchema
        >;
        const record = await context.app.storage.getMCP(userId, context.params.mcp_id);
        if (!record)
            throw new HTTPError(404, `No installed MCP with id '${context.params.mcp_id}'.`);
        if (body.values !== undefined) {
            const hub = record.hub_id ? context.app.mcpHubs.get(record.hub_id) : null;
            if (!hub || !record.card_id) {
                throw new HTTPError(
                    400,
                    'This MCP has no card to re-render from — its hub is not registered, or it was added by hand.'
                );
            }
            let card;
            try {
                card = await hub.getMCP(userId, record.card_id);
            } catch (error) {
                throw hubCardError(error, record.hub_id!, 'MCP', record.card_id);
            }
            const values = { ...record.values, ...body.values };
            try {
                record.client = mcpClientWire(
                    renderMCP(card, values, body.name ?? record.client.name)
                );
            } catch (error) {
                throw new HTTPError(400, error instanceof Error ? error.message : String(error));
            }
            record.values = values;
            record.version = card.version;
        } else if (body.name !== undefined) {
            record.client.name = body.name;
        }
        if (body.enabled !== undefined) record.enabled = body.enabled;
        try {
            await context.app.storage.upsertMCP(userId, record);
        } catch (error) {
            throw new HTTPError(409, error instanceof Error ? error.message : String(error));
        }
        return jsonResponse(mcpView(record));
    });
    router.delete('/mcp/{mcp_id}', async context => {
        if (!(await context.app.storage.deleteMCP(context.userId(), context.params.mcp_id))) {
            throw new HTTPError(404, `No installed MCP with id '${context.params.mcp_id}'.`);
        }
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerSkillRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/skill', async context => {
        const records = await context.app.storage.listSkills(context.userId());
        return jsonResponse(records.map(skillView).sort((a, b) => a.name.localeCompare(b.name)));
    });
    router.get('/skill/{skill_id}', async context => {
        const record = await context.app.storage.getSkill(
            context.userId(),
            context.params.skill_id
        );
        if (!record)
            throw new HTTPError(404, `No installed skill with id '${context.params.skill_id}'.`);
        return jsonResponse(record);
    });
    router.delete('/skill/{skill_id}', async context => {
        if (!(await context.app.storage.deleteSkill(context.userId(), context.params.skill_id))) {
            throw new HTTPError(404, `No installed skill with id '${context.params.skill_id}'.`);
        }
        return emptyResponse();
    });
}

/**
 *
 * @param context
 */
async function ownedChannel(context: HTTPContext): Promise<ChannelRecord> {
    const record = await context.app.storage.getChannel(context.params.channel_id);
    if (!record) throw new HTTPError(404, 'Channel not found.');
    if (record.user_id !== context.userId()) throw new HTTPError(403, 'Access denied.');
    return record;
}

/**
 *
 * @param context
 * @param record
 */
function channelView(context: HTTPContext, record: ChannelRecord) {
    let botId = '';
    try {
        botId = context.app.channelTypeRegistry.extractPlatformBotId(
            record.channel_type,
            record.credentials
        );
    } catch {}
    const { credentials: _credentials, ...safe } = record;
    return { ...safe, platform_bot_id: botId };
}

/**
 *
 * @param hubs
 */
function describeHubs(hubs: ReadonlyMap<string, MCPHubBase | SkillHubBase>) {
    return [...hubs.values()]
        .sort((a, b) => a.hubId.localeCompare(b.hubId))
        .map(hub => hub.toJSON());
}

/**
 *
 * @param hubs
 * @param id
 */
function pickHub<T extends MCPHubBase | SkillHubBase>(hubs: ReadonlyMap<string, T>, id: string): T {
    const hub = hubs.get(id);
    if (!hub) throw new HTTPError(404, `Hub '${id}' is not registered.`);
    return hub;
}

/**
 *
 * @param error
 * @param hubId
 * @param kind
 * @param cardId
 */
function hubCardError(error: unknown, hubId: string, kind: string, cardId: string): HTTPError {
    if (error instanceof HTTPError) return error;
    return new HTTPError(404, `Hub '${hubId}' has no ${kind} '${cardId}'.`);
}

/**
 *
 * @param error
 * @param fallback
 */
function routeError(error: unknown, fallback: number): HTTPError {
    if (error instanceof HTTPError) return error;
    const status =
        error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode: unknown }).statusCode)
            : fallback;
    return new HTTPError(status, error instanceof Error ? error.message : String(error));
}

/**
 *
 * @param client
 */
function mcpClientWire(client: MCPClient): MCPRecord['client'] {
    const config = client.mcpConfig;
    return {
        name: client.name,
        is_stateful: client.isStateful,
        mcp_config:
            config.type === 'http_mcp'
                ? {
                      type: config.type,
                      url: config.url,
                      headers: config.headers ?? null,
                      timeout: config.timeout,
                  }
                : {
                      type: config.type,
                      command: config.command,
                      args: config.args ?? null,
                      env: config.env ?? null,
                      cwd: config.cwd ?? null,
                      encoding_error_handler: config.encodingErrorHandler,
                  },
        enable_tools: client.enableTools,
        disable_tools: client.disableTools,
        execution_timeout: client.executionTimeout,
    };
}

/**
 *
 * @param record
 */
function mcpView(record: MCPRecord) {
    return {
        id: record.id,
        name: record.client.name,
        display_name: record.display_name,
        description: record.description,
        tags: record.tags,
        author: record.author,
        icon_url: record.icon_url,
        url: record.url,
        hub_id: record.hub_id,
        card_id: record.card_id,
        version: record.version,
        enabled: record.enabled,
        created_at: record.created_at,
        updated_at: record.updated_at,
    };
}

/**
 *
 * @param record
 */
function skillView(record: SkillRecord) {
    const { markdown: _markdown, user_id: _userId, ...view } = record;
    return view;
}
