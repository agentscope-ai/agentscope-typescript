import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { PermissionBehavior } from '../permission';
import { MCPTool } from './base';

describe('MCPTool', () => {
    test('sanitizes model names, preserves schemas, permissions, and server names', async () => {
        const request = jest.fn().mockResolvedValue({
            content: [
                { type: 'text', text: 'hello' },
                { type: 'image', data: 'AQID', mimeType: 'image/png' },
                {
                    type: 'resource_link',
                    name: 'docs',
                    uri: 'https://example.com/docs',
                    mimeType: 'text/html',
                },
            ],
            isError: false,
        });
        const client = { request } as unknown as Client;
        const definition = {
            name: 'files.read:item',
            description: 'Read an item',
            inputSchema: {
                type: 'object',
                properties: { value: { $ref: '#/$defs/value' } },
                $defs: { value: { type: 'string' } },
            },
            annotations: { readOnlyHint: true },
        } as Tool;
        const release = jest.fn();
        const tool = new MCPTool({
            mcpName: 'server',
            tool: definition,
            getClient: async () => client,
            releaseClient: release,
        });
        expect(tool.name).toBe('mcp__server__filesxreadxitem');
        expect(tool.originalName).toBe('files.read:item');
        expect(tool.inputSchema).toMatchObject({ $defs: definition.inputSchema.$defs });
        expect((await tool.checkPermissions()).behavior).toBe(PermissionBehavior.ALLOW);
        const result = await tool.call({ value: 'x' });
        expect(result.state).toBe('running');
        expect(result.content.map(block => block.type)).toEqual(['text', 'data', 'data']);
        expect(request.mock.calls[0][0].params).toEqual({
            name: 'files.read:item',
            arguments: { value: 'x' },
        });
        expect(release).toHaveBeenCalledWith(client);
    });

    test('asks for mutable MCP tools and maps MCP errors', async () => {
        const client = {
            request: jest.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'failed' }],
                isError: true,
            }),
        } as unknown as Client;
        const tool = new MCPTool({
            mcpName: 'server',
            tool: { name: 'write', inputSchema: { type: 'object' } } as Tool,
            getClient: async () => client,
            releaseClient: async () => {},
        });
        expect((await tool.checkPermissions()).behavior).toBe(PermissionBehavior.ASK);
        expect((await tool.call({})).state).toBe('error');
    });
});
