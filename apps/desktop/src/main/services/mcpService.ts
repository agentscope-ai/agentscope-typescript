import { HTTPMCPClient, StdioMCPClient } from '@agentscope-ai/agentscope/mcp';
import type {
    MCPServerConfig,
    MCPServerState,
    MCPServerStatus,
    SSEMCPServerConfig,
    HTTPMCPServerConfig,
    StdioMCPServerConfig,
} from '@shared/types/mcp';

import { readJSON, writeJSON } from '../storage';
import { PATHS } from '../storage/paths';

interface RuntimeEntry {
    client: HTTPMCPClient | StdioMCPClient | null;
    status: MCPServerStatus;
    error?: string;
    tools?: string[];
}

/**
 * Load MCP server configurations from storage
 *
 * @returns Array of MCP server configurations
 */
function loadConfigs(): MCPServerConfig[] {
    return readJSON<MCPServerConfig[]>(PATHS.mcp, []);
}

/**
 * Save MCP server configurations to storage
 *
 * @param configs - Array of configurations to save
 */
function saveConfigs(configs: MCPServerConfig[]): void {
    writeJSON(PATHS.mcp, configs);
}

// In-memory runtime state
const runtime = new Map<string, RuntimeEntry>();

/**
 * Get the current state of an MCP server
 *
 * @param config - The MCP server configuration
 * @returns The current server state
 */
function getState(config: MCPServerConfig): MCPServerState {
    const entry = runtime.get(config.id);
    return {
        config,
        status: entry?.status ?? 'disconnected',
        error: entry?.error,
        tools: entry?.tools,
    };
}

/**
 * Create an MCP client based on the server configuration
 *
 * @param config - The MCP server configuration
 * @returns The created MCP client instance
 */
function createClient(config: MCPServerConfig): HTTPMCPClient | StdioMCPClient {
    if (config.protocol === 'stdio') {
        const c = config as StdioMCPServerConfig;
        return new StdioMCPClient({
            name: c.name,
            command: c.command,
            args: c.args,
            env: c.env,
        });
    }

    if (config.protocol === 'sse') {
        const c = config as SSEMCPServerConfig;
        return new HTTPMCPClient({
            name: c.name,
            transportType: 'sse',
            url: c.url,
            stateful: true,
        });
    }

    // streamable-http
    const c = config as HTTPMCPServerConfig;
    return new HTTPMCPClient({
        name: c.name,
        transportType: 'streamable-http',
        url: c.url,
        stateful: true,
    });
}

/**
 * Get all MCP server states
 *
 * @returns Array of all MCP server states
 */
export function mcpGetAll(): MCPServerState[] {
    return loadConfigs().map(getState);
}

/**
 * Add a new MCP server configuration
 *
 * @param config - The server configuration without ID and createdAt
 * @returns The state of the newly added server
 */
export function mcpAdd(config: Omit<MCPServerConfig, 'id' | 'createdAt'>): MCPServerState {
    const configs = loadConfigs();
    const newConfig: MCPServerConfig = {
        ...config,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
    } as MCPServerConfig;
    configs.push(newConfig);
    saveConfigs(configs);
    return getState(newConfig);
}

/**
 * Remove an MCP server configuration and disconnect if connected
 *
 * @param id - The server ID to remove
 */
export async function mcpRemove(id: string): Promise<void> {
    await mcpDisconnect(id).catch(() => {});
    const configs = loadConfigs().filter(c => c.id !== id);
    saveConfigs(configs);
    runtime.delete(id);
}

/**
 * Connect to an MCP server
 *
 * @param id - The server ID to connect
 * @returns The updated server state
 */
export async function mcpConnect(id: string): Promise<MCPServerState> {
    const configs = loadConfigs();
    const config = configs.find(c => c.id === id);
    if (!config) throw new Error(`MCP server '${id}' not found`);

    const existing = runtime.get(id);
    if (existing?.status === 'connected') return getState(config);

    try {
        const client = createClient(config);
        await client.connect();
        const mcpTools = await client.listTools();
        const toolNames = mcpTools.map(t => t.name);
        runtime.set(id, { client, status: 'connected', tools: toolNames });
    } catch (err) {
        runtime.set(id, { client: null, status: 'error', error: String(err) });
    }

    return getState(config);
}

/**
 * Disconnect from an MCP server
 *
 * @param id - The server ID to disconnect
 * @returns The updated server state
 */
export async function mcpDisconnect(id: string): Promise<MCPServerState> {
    const configs = loadConfigs();
    const config = configs.find(c => c.id === id);
    if (!config) throw new Error(`MCP server '${id}' not found`);

    const entry = runtime.get(id);
    if (entry?.client) {
        await entry.client.close().catch(() => {});
    }
    runtime.set(id, { client: null, status: 'disconnected' });
    return getState(config);
}

/**
 * List all tools available from an MCP server
 *
 * @param id - The server ID
 * @returns Array of tool names
 */
export async function mcpListTools(id: string): Promise<string[]> {
    const entry = runtime.get(id);
    if (!entry || entry.status !== 'connected' || !entry.client) {
        throw new Error(`MCP server '${id}' is not connected`);
    }
    const tools = await entry.client.listTools();
    const names = tools.map(t => t.name);
    entry.tools = names;
    return names;
}

/**
 * Shutdown all connected MCP servers
 */
export async function mcpShutdownAll(): Promise<void> {
    const ids = [...runtime.keys()];
    await Promise.allSettled(ids.map(id => mcpDisconnect(id)));
}

/**
 * Get all available MCP clients for use in chat
 * - For stdio: only return connected clients from runtime
 * - For http/sse: create new clients on demand
 *
 * @returns Array of MCP client instances
 */
export async function mcpGetAvailableClients(): Promise<(HTTPMCPClient | StdioMCPClient)[]> {
    const configs = loadConfigs();
    const clients: (HTTPMCPClient | StdioMCPClient)[] = [];

    for (const config of configs) {
        if (config.protocol === 'stdio') {
            // For stdio, only use already connected clients
            const entry = runtime.get(config.id);
            if (entry?.status === 'connected' && entry.client) {
                clients.push(entry.client);
            }
        } else {
            // For http/sse, create new clients on demand and connect them
            const client = createClient(config);
            await client.connect();
            clients.push(client);
        }
    }

    return clients;
}
