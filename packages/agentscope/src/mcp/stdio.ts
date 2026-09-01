import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    StdioClientTransport,
    StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ListToolsRequest, ListToolsResultSchema, Tool } from '@modelcontextprotocol/sdk/types.js';

import { MCPTool } from './base';

/**
 * The STDIO MCP client class.
 */
export class StdioMCPClient {
    name: string;
    private stdioServerParameters: StdioServerParameters;
    private transport?: StdioClientTransport;
    private client?: Client;
    private requestOptions?: RequestOptions;

    /**
     * Initialize the StdioMCPClient with the given Stdio parameters.
     *
     * @param root0
     * @param root0.name
     */
    constructor({
        name,
        ...rest
    }: {
        name: string;
        requestOptions?: RequestOptions;
    } & StdioServerParameters) {
        this.name = name;
        this.requestOptions = rest.requestOptions;
        delete rest.requestOptions;
        this.stdioServerParameters = rest;
    }

    /**
     * Connect to the MCP server using Stdio transport. Note the Stdio client will start an
     * MCP server process under the hood.
     */
    async connect() {
        this.transport = new StdioClientTransport(this.stdioServerParameters);
        this.client = new Client({
            name: this.name,
            version: '1.0.0',
        });
        await this.client.connect(this.transport);
    }

    /**
     * Close the connection and stop the MCP server process.
     */
    async close() {
        try {
            if (this.client) {
                await this.client.close();
            }
        } finally {
            this.client = undefined;
            this.transport = undefined;
        }
    }

    /**
     * List raw tool descriptors available on the MCP server.
     *
     * @returns Raw MCP tool descriptors.
     */
    async listRawTools(): Promise<Tool[]> {
        if (!this.client) {
            throw new Error(
                `Client not initialized, call 'connect()' method first for the MCP client named '${this.name}'`
            );
        }

        const toolsRequest: ListToolsRequest = {
            method: 'tools/list',
            params: {},
        };

        const toolsResult = await this.client.request(
            toolsRequest,
            ListToolsResultSchema,
            this.requestOptions
        );
        if (toolsResult.tools === undefined) {
            return [];
        }

        return toolsResult.tools;
    }

    /**
     * List all tools available on the MCP server.
     *
     * @returns An array of MCPTool instances representing the tools available on the server.
     */
    async listTools(): Promise<MCPTool[]> {
        const tools = await this.listRawTools();
        return tools.map((tool: Tool) => {
            return new MCPTool({
                mcpName: this.name,
                tool,
                getClient: async () => this.client!,
                releaseClient: async () => {},
                requestOptions: this.requestOptions,
            });
        });
    }

    /**
     * Get a callable function for a specific tool by its name.
     * @param root0
     * @param root0.name
     * @returns An instance of MCPTool that can be called to execute the tool's functionality.
     */
    async getCallableFunction({ name }: { name: string }) {
        if (!this.client) {
            throw new Error(
                `Client not initialized, call 'connect()' method first for the MCP client named '${this.name}'`
            );
        }

        const tools = await this.listTools();
        const targetTool = tools.find(tool => tool.name === name || tool.originalName === name);

        if (!targetTool) {
            throw new Error(
                `Tool '${name}' not found in MCP server '${this.name}'. Available tools: ${tools.map(t => t.name).join(', ')}`
            );
        }

        return targetTool;
    }
}
