/* eslint-disable jsdoc/require-jsdoc */

import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

import type { MCPTool } from './base';
import { HttpMCPConfig, MCPClient, StdioMCPConfig } from './client';

const RAW_TOOLS: MCPToolDefinition[] = [
    {
        name: 'read',
        description: 'Read data',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'write',
        description: 'Write data',
        inputSchema: { type: 'object', properties: {} },
    },
];

const WRAPPED_TOOLS = RAW_TOOLS.map(tool => {
    return {
        name: `mcp__demo__${tool.name}`,
        originalName: tool.name,
        description: tool.description,
    } as unknown as MCPTool;
});

interface FakeTransport {
    connect: jest.Mock<Promise<void>, []>;
    close: jest.Mock<Promise<void>, []>;
    listRawTools: jest.Mock<Promise<MCPToolDefinition[]>, []>;
    listTools: jest.Mock<Promise<MCPTool[]>, []>;
}

function fakeTransport(): FakeTransport {
    return {
        connect: jest.fn(async () => {}),
        close: jest.fn(async () => {}),
        listRawTools: jest.fn(async () => RAW_TOOLS),
        listTools: jest.fn(async () => WRAPPED_TOOLS),
    };
}

function replaceTransport(client: MCPClient, transport: FakeTransport): void {
    const internal = client as unknown as { client: FakeTransport };
    internal.client = transport;
}

function transportDetails(client: MCPClient): {
    transportType: string;
    requestOptions?: { timeout?: number };
} {
    const internal = client as unknown as {
        client: { transportType: string; requestOptions?: { timeout?: number } };
    };
    return internal.client;
}

describe('MCPClient', () => {
    test('validates names, stdio state, filters, and overlap', () => {
        expect(
            () =>
                new MCPClient({
                    name: 'bad name',
                    isStateful: true,
                    mcpConfig: new StdioMCPConfig({ command: 'node' }),
                })
        ).toThrow('contains characters not allowed');
        expect(
            () =>
                new MCPClient({
                    name: 'stdio',
                    isStateful: false,
                    mcpConfig: new StdioMCPConfig({ command: 'node' }),
                })
        ).toThrow('STDIO MCP must be stateful');
        expect(
            () =>
                new MCPClient({
                    name: 'filters',
                    isStateful: false,
                    mcpConfig: new HttpMCPConfig({ url: 'https://example.com/mcp' }),
                    enableTools: [1] as unknown as string[],
                })
        ).toThrow('enableTools should be a list of strings');
        expect(
            () =>
                new MCPClient({
                    name: 'overlap',
                    isStateful: false,
                    mcpConfig: new HttpMCPConfig({ url: 'https://example.com/mcp' }),
                    enableTools: ['read'],
                    disableTools: ['read'],
                })
        ).toThrow('should not overlap');
    });

    test('detects SSE from the URL path and converts execution timeout to milliseconds', () => {
        const sse = new MCPClient({
            name: 'sse',
            isStateful: false,
            mcpConfig: new HttpMCPConfig({ url: 'https://example.com/sse?key=value' }),
            executionTimeout: 2.5,
        });
        expect(transportDetails(sse)).toMatchObject({
            transportType: 'sse',
            requestOptions: { timeout: 2500 },
        });

        const streamable = new MCPClient({
            name: 'http',
            isStateful: false,
            mcpConfig: new HttpMCPConfig({ url: 'https://example.com/sse-extra' }),
        });
        expect(transportDetails(streamable).transportType).toBe('streamable-http');
    });

    test('filters raw and wrapped tools while getTool can resolve a filtered tool', async () => {
        const client = new MCPClient({
            name: 'demo',
            isStateful: false,
            mcpConfig: new HttpMCPConfig({ url: 'https://example.com/mcp' }),
            enableTools: ['read'],
        });
        replaceTransport(client, fakeTransport());

        await expect(client.listRawTools()).resolves.toEqual([RAW_TOOLS[0]]);
        await expect(client.listTools()).resolves.toEqual([WRAPPED_TOOLS[0]]);
        await expect(client.getTool('write')).resolves.toBe(WRAPPED_TOOLS[1]);
        await expect(client.getCallableFunction({ name: 'mcp__demo__read' })).resolves.toBe(
            WRAPPED_TOOLS[0]
        );
    });

    test('enforces the stateful connection lifecycle', async () => {
        const client = new MCPClient({
            name: 'lifecycle',
            isStateful: true,
            mcpConfig: new HttpMCPConfig({ url: 'https://example.com/mcp' }),
        });
        const transport = fakeTransport();
        replaceTransport(client, transport);

        await expect(client.listTools()).rejects.toThrow('Call connect() first');
        await client.connect();
        expect(client.isConnected).toBe(true);
        expect(transport.connect).toHaveBeenCalledTimes(1);
        await expect(client.connect()).rejects.toThrow('already connected');
        await client.close();
        expect(transport.close).toHaveBeenCalledTimes(1);
        expect(client.isConnected).toBe(false);
        await expect(client.close()).rejects.toThrow('not connected');
    });
});
