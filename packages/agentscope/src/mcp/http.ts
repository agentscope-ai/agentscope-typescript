import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    SSEClientTransport,
    SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ListToolsRequest, ListToolsResultSchema, Tool } from '@modelcontextprotocol/sdk/types.js';

import { MCPTool } from './base';

/**
 * The HTTP MCP client class that connects to an MCP server using either Streamable HTTP or Server-Sent Events (SSE)
 * transport.
 * Note the client is stateful, meaning that developers should manually call the `connect()` and `close()` methods to
 * manage the connection lifecycle.
 */
export class HTTPMCPClient {
    name: string;
    private requestOptions?: RequestOptions;
    private client?: Client;
    private transport?: StreamableHTTPClientTransport | SSEClientTransport;
    private transportType: 'streamable-http' | 'sse';
    private url: string;
    private transportOpts?: StreamableHTTPClientTransportOptions | SSEClientTransportOptions;
    private stateful: boolean;

    /**
     * Initialize the HTTPStatefulMCPClient with the specified transport type, URL, and options.
     *
     * @param root0
     * @param root0.name
     * @param root0.transportType
     * @param root0.url
     * @param root0.stateful
     * @param root0.transportOpts
     * @param root0.requestOptions
     */
    constructor({
        name,
        transportType,
        url,
        stateful = true,
        transportOpts,
        requestOptions,
    }: {
        name: string;
        transportType: 'streamable-http' | 'sse';
        url: string;
        stateful?: boolean;
        transportOpts?: StreamableHTTPClientTransportOptions | SSEClientTransportOptions;
        requestOptions?: RequestOptions;
    }) {
        this.name = name;
        this.transportType = transportType;
        this.transportOpts = transportOpts;
        this.requestOptions = requestOptions;
        this.url = url;
        this.stateful = stateful;
    }

    /**
     * Connect to the MCP server with the specified transport and URL. This method must be called before making any
     * requests to the server.
     */
    async connect() {
        if (!this.stateful) {
            console.log(
                `MCP client '${this.name}' initialized with stateful=false will connect and close the connection automatically for each request, no need to call 'connect()' method explicitly.`
            );
        } else {
            await this._connect();
        }
    }

    /**
     * The internal method to establish the connection to the MCP server. It initializes the appropriate transport
     * based on the specified transport type and creates a new Client instance to manage the connection and requests.
     */
    protected async _connect() {
        const baseUrl = new URL(this.url);
        if (this.transportType === 'streamable-http') {
            this.transport = new StreamableHTTPClientTransport(baseUrl, this.transportOpts);
        } else {
            this.transport = new SSEClientTransport(baseUrl, this.transportOpts);
        }
        this.client = new Client({
            name: this.name,
            version: '1.0.0',
        });
        await this.client.connect(this.transport, this.requestOptions);
        console.log(`MCP client '${this.name}' is connected`);
    }

    /**
     * List raw tool descriptors available on the MCP server.
     *
     * @returns Raw MCP tool descriptors.
     */
    async listRawTools(): Promise<Tool[]> {
        let listClient: Client;

        if (this.stateful) {
            if (!this.client) {
                throw new Error(
                    `Client not initialized, call 'connect()' method first for the MCP client named '${this.name}'`
                );
            }
            listClient = this.client;
        } else {
            listClient = await this._createClient();
        }

        try {
            const toolsRequest: ListToolsRequest = {
                method: 'tools/list',
                params: {},
            };

            const toolsResult = await listClient.request(toolsRequest, ListToolsResultSchema);
            if (toolsResult.tools === undefined) {
                return [];
            }

            return toolsResult.tools;
        } finally {
            if (!this.stateful) {
                await listClient.close();
            }
        }
    }

    /**
     * List all tools available on the MCP server.
     *
     * @returns An array of MCPTool instances representing the tools available on the server.
     */
    async listTools(): Promise<MCPTool[]> {
        const tools = await this.listRawTools();
        return tools.map((tool: Tool) => {
            if (this.stateful) {
                return new MCPTool({
                    mcpName: this.name,
                    tool,
                    getClient: async () => this.client!,
                    releaseClient: async () => {},
                    requestOptions: this.requestOptions,
                });
            }
            return new MCPTool({
                mcpName: this.name,
                tool,
                getClient: () => this._createClient(),
                releaseClient: async (client: Client) => {
                    await client.close();
                },
                requestOptions: this.requestOptions,
            });
        });
    }

    /**
     * Close the connection to the MCP server and clean up any resources used by the client.
     */
    async close() {
        if (!this.stateful) {
            console.log(
                `MCP client '${this.name}' initialized with stateful=false will connect and close the connection automatically for each request, no need to call 'close()' method explicitly.`
            );
        } else {
            await this._close();
        }
    }

    /**
     * The internal method to close the connection to the MCP server.
     */
    protected async _close() {
        try {
            await this.client?.close();
        } finally {
            console.log(`MCP client '${this.name} is closed.'`);
            this.client = undefined;
            this.transport = undefined;
        }
    }

    /**
     * Create a new client instance without storing it in this.client.
     * Used for stateless operations where each request needs its own client.
     * @returns A new connected Client instance
     */
    protected async _createClient(): Promise<Client> {
        const baseUrl = new URL(this.url);
        const transport =
            this.transportType === 'streamable-http'
                ? new StreamableHTTPClientTransport(baseUrl, this.transportOpts)
                : new SSEClientTransport(baseUrl, this.transportOpts);

        const client = new Client({
            name: this.name,
            version: '1.0.0',
        });
        await client.connect(transport, this.requestOptions);
        return client;
    }

    /**
     * Get a callable function for a specific tool by its name.
     * @param root0
     * @param root0.name
     * @returns An instance of MCPTool that can be called to execute the tool's functionality.
     */
    async getCallableFunction({ name }: { name: string }) {
        if (this.stateful && !this.client) {
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
