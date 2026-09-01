/* eslint-disable jsdoc/require-jsdoc */

import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

import type { MCPTool } from './base';
import { HTTPMCPClient } from './http';
import { StdioMCPClient } from './stdio';

/** Configuration for an MCP server started over standard IO. */
export class StdioMCPConfig {
    readonly type = 'stdio_mcp' as const;
    readonly command: string;
    readonly args?: string[];
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly encodingErrorHandler: 'strict' | 'ignore' | 'replace';

    /**
     * Create a standard-IO MCP configuration.
     * @param config
     * @param config.command
     * @param config.args
     * @param config.env
     * @param config.cwd
     * @param config.encodingErrorHandler
     */
    constructor(config: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        encodingErrorHandler?: 'strict' | 'ignore' | 'replace';
    }) {
        this.command = config.command;
        this.args = config.args;
        this.env = config.env;
        this.cwd = config.cwd;
        this.encodingErrorHandler = config.encodingErrorHandler ?? 'strict';
    }
}

/** Configuration for a streamable-HTTP or legacy SSE MCP endpoint. */
export class HttpMCPConfig {
    readonly type = 'http_mcp' as const;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly timeout: number | null;

    /**
     * Create an HTTP MCP configuration.
     * @param config
     * @param config.url
     * @param config.headers
     * @param config.timeout
     */
    constructor(config: {
        url: string;
        headers?: Record<string, string>;
        timeout?: number | null;
    }) {
        this.url = config.url;
        this.headers = config.headers;
        this.timeout = config.timeout === undefined ? 30 : config.timeout;
    }
}

export type MCPConfig = StdioMCPConfig | HttpMCPConfig;

export interface MCPClientOptions {
    name: string;
    isStateful: boolean;
    mcpConfig: MCPConfig;
    enableTools?: string[] | null;
    disableTools?: string[] | null;
    executionTimeout?: number | null;
}

type TransportClient = HTTPMCPClient | StdioMCPClient;

/** Python-compatible unified MCP client with stateful and stateless modes. */
export class MCPClient {
    readonly name: string;
    readonly isStateful: boolean;
    readonly mcpConfig: MCPConfig;
    readonly enableTools: string[] | null;
    readonly disableTools: string[] | null;
    readonly executionTimeout: number | null;
    private client: TransportClient;
    private connected = false;
    private cachedTools: MCPTool[] | null = null;

    /**
     * Validate the public configuration and create its transport adapter.
     * @param options
     */
    constructor(options: MCPClientOptions) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.name)) {
            throw new Error(
                `MCPClient name '${options.name}' contains characters not allowed by LLM ` +
                    'providers (only [a-zA-Z0-9_-] are permitted). Please rename it.'
            );
        }
        if (options.mcpConfig.type === 'stdio_mcp' && !options.isStateful) {
            throw new Error('STDIO MCP must be stateful (isStateful=true).');
        }
        validateToolFilter('enableTools', options.enableTools);
        validateToolFilter('disableTools', options.disableTools);
        const enabled = options.enableTools ?? null;
        const disabled = options.disableTools ?? null;
        const overlap = enabled?.filter(name => disabled?.includes(name)) ?? [];
        if (overlap.length > 0) {
            throw new Error(
                `The tools in enableTools and disableTools should not overlap, but got ` +
                    `${overlap.join(', ')}.`
            );
        }

        this.name = options.name;
        this.isStateful = options.isStateful;
        this.mcpConfig = options.mcpConfig;
        this.enableTools = enabled;
        this.disableTools = disabled;
        this.executionTimeout = options.executionTimeout ?? null;
        this.client = this.createTransportClient();
    }

    /** Return whether a stateful transport is currently connected. */
    get isConnected(): boolean {
        return this.connected;
    }

    /** Connect a stateful MCP client; stateless HTTP clients need no setup. */
    async connect(): Promise<void> {
        if (!this.isStateful) return;
        if (this.connected) {
            throw new Error(
                `MCP '${this.name}' is already connected. Call close() before reconnecting.`
            );
        }
        try {
            await this.client.connect();
            this.connected = true;
        } catch (error) {
            this.client = this.createTransportClient();
            throw error;
        }
    }

    /**
     * Close a stateful MCP client and make it ready for reconnection.
     * @param ignoreErrors
     */
    async close(ignoreErrors = true): Promise<void> {
        if (!this.isStateful) return;
        if (!this.connected) {
            throw new Error(`MCP '${this.name}' is not connected. Call connect() first.`);
        }
        try {
            await this.client.close();
        } catch (error) {
            if (!ignoreErrors) throw error;
        } finally {
            this.connected = false;
            this.client = this.createTransportClient();
        }
    }

    /** List wrapped tools after applying the configured allow/deny filters. */
    async listTools(): Promise<MCPTool[]> {
        const tools = await this.listAllTools();
        return tools.filter(tool => this.isToolEnabled(tool.originalName));
    }

    /** List raw MCP descriptors after applying the configured allow/deny filters. */
    async listRawTools(): Promise<MCPToolDefinition[]> {
        this.validateConnection();
        const tools = await this.client.listRawTools();
        return tools.filter(tool => this.isToolEnabled(tool.name));
    }

    /**
     * Resolve a tool by its original MCP name or model-facing prefixed name.
     * @param name
     */
    async getTool(name: string): Promise<MCPTool> {
        this.validateConnection();
        const tools = this.cachedTools ?? (await this.listAllTools());
        const tool = tools.find(item => item.originalName === name || item.name === name);
        if (!tool) throw new Error(`Tool '${name}' not found in MCP server '${this.name}'`);
        return tool;
    }

    /**
     * Legacy alias retained for existing TypeScript integrations.
     * @param root0
     * @param root0.name
     */
    async getCallableFunction({ name }: { name: string }): Promise<MCPTool> {
        return this.getTool(name);
    }

    private async listAllTools(): Promise<MCPTool[]> {
        this.validateConnection();
        const tools = await this.client.listTools();
        this.cachedTools = tools;
        return tools;
    }

    private isToolEnabled(name: string): boolean {
        if (this.enableTools && !this.enableTools.includes(name)) return false;
        return !this.disableTools?.includes(name);
    }

    private validateConnection(): void {
        if (this.isStateful && !this.connected) {
            throw new Error(`MCP '${this.name}' is not connected. Call connect() first.`);
        }
    }

    private createTransportClient(): TransportClient {
        const requestOptions: RequestOptions | undefined =
            this.executionTimeout == null ? undefined : { timeout: this.executionTimeout * 1000 };
        if (this.mcpConfig.type === 'stdio_mcp') {
            return new StdioMCPClient({
                name: this.name,
                command: this.mcpConfig.command,
                args: this.mcpConfig.args,
                env: this.mcpConfig.env,
                cwd: this.mcpConfig.cwd,
                requestOptions,
            });
        }

        const url = new URL(this.mcpConfig.url);
        const transportType =
            url.pathname.endsWith('/sse') || url.pathname.endsWith('/messages/')
                ? 'sse'
                : 'streamable-http';
        const requestInit = this.mcpConfig.headers
            ? { headers: this.mcpConfig.headers }
            : undefined;
        return new HTTPMCPClient({
            name: this.name,
            transportType,
            url: this.mcpConfig.url,
            stateful: this.isStateful,
            transportOpts: requestInit ? { requestInit } : undefined,
            requestOptions,
        });
    }
}

function validateToolFilter(name: string, value: string[] | null | undefined): void {
    if (value != null && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        throw new Error(`${name} should be a list of strings, but got ${String(value)}.`);
    }
}
