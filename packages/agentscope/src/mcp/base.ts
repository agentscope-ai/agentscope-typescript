/* eslint-disable jsdoc/require-jsdoc */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

import { Base64Source, DataBlock, TextBlock, URLSource } from '../message';
import type { PermissionDecision } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import { ToolBase } from '../tool/base';
import { ToolChunk } from '../tool/response';
import type { ToolInputSchema } from '../type';

type GetClient = () => Promise<Client>;
type ReleaseClient = (client: Client) => Promise<void>;

export interface MCPToolOptions {
    mcpName: string;
    tool: MCPToolDefinition;
    getClient: GetClient;
    releaseClient: ReleaseClient;
    requestOptions?: RequestOptions;
}

/** Convert one MCP server tool to AgentScope's ToolBase contract. */
export class MCPTool extends ToolBase {
    readonly name: string;
    readonly originalName: string;
    readonly description: string;
    readonly inputSchema: ToolInputSchema;
    readonly isConcurrencySafe = false;
    readonly isReadOnly: boolean;
    override isMcp = true;
    override mcpName: string;
    private readonly getClient: GetClient;
    private readonly releaseClient: ReleaseClient;
    private readonly requestOptions?: RequestOptions;

    constructor(options: MCPToolOptions) {
        super();
        this.originalName = options.tool.name;
        const sanitized = options.tool.name.replace(/[^a-zA-Z0-9_-]/g, 'x');
        this.name = `mcp__${options.mcpName}__${sanitized}`;
        this.mcpName = options.mcpName;
        this.description = options.tool.description ?? '';
        const schema = options.tool.inputSchema as ToolInputSchema;
        this.inputSchema = {
            ...schema,
            type: schema.type ?? 'object',
            properties: schema.properties ?? {},
            required: schema.required ?? [],
        };
        this.isReadOnly = options.tool.annotations?.readOnlyHint ?? false;
        this.getClient = options.getClient;
        this.releaseClient = options.releaseClient;
        this.requestOptions = options.requestOptions;
    }

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: this.isReadOnly ? PermissionBehavior.ALLOW : PermissionBehavior.ASK,
            message: this.isReadOnly
                ? 'This is a read-only MCP tool. Allowing execution.'
                : 'MCP tools must be explicitly allowed by the user.',
        });
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const client = await this.getClient();
        try {
            const result = await client.request(
                {
                    method: 'tools/call',
                    params: { name: this.originalName, arguments: input },
                },
                CallToolResultSchema,
                this.requestOptions
            );
            const content: Array<ReturnType<typeof TextBlock> | ReturnType<typeof DataBlock>> = [];
            for (const item of result.content) {
                if (item.type === 'text') content.push(TextBlock({ text: item.text }));
                else if (item.type === 'image' || item.type === 'audio') {
                    content.push(
                        DataBlock({
                            source: Base64Source({ data: item.data, media_type: item.mimeType }),
                        })
                    );
                } else if (item.type === 'resource') {
                    if ('text' in item.resource) {
                        content.push(TextBlock({ text: JSON.stringify(item.resource, null, 2) }));
                    } else {
                        content.push(
                            DataBlock({
                                source: Base64Source({
                                    data: item.resource.blob,
                                    media_type:
                                        item.resource.mimeType ?? 'application/octet-stream',
                                }),
                            })
                        );
                    }
                } else if (item.type === 'resource_link') {
                    content.push(
                        DataBlock({
                            source: URLSource({
                                url: item.uri,
                                media_type: item.mimeType ?? 'application/octet-stream',
                            }),
                            name: item.name,
                        })
                    );
                }
            }
            return new ToolChunk({
                content,
                state: result.isError ? 'error' : 'running',
            });
        } finally {
            await this.releaseClient(client);
        }
    }
}
