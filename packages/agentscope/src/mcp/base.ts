import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolRequest, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import z from 'zod';

import { Tool, ToolResponse } from '../tool';
import { createToolResponse } from '../tool/response';
import { ToolInputSchema } from '../type';

/**
 * Type definition for getting a client instance
 */
type GetClient = () => Promise<Client>;

/**
 * Type definition for releasing a client instance
 */
type ReleaseClient = (client: Client) => Promise<void>;

/**
 * MCPTool class that wraps an MCP tool and provides a callable interface
 */
export class MCPTool implements Tool {
    name: string;
    description: string;
    inputSchema: z.ZodObject | ToolInputSchema;
    requireUserConfirm = false;
    call: (input: Record<string, unknown>) => Promise<ToolResponse>;

    private getClient: GetClient;
    private releaseClient: ReleaseClient;

    /**
     * Initialize an MCPTool instance
     * @param root0
     * @param root0.name
     * @param root0.description
     * @param root0.inputSchema
     * @param root0.getClient
     * @param root0.releaseClient
     */
    constructor({
        name,
        description,
        inputSchema,
        getClient,
        releaseClient,
    }: {
        name: string;
        description: string;
        inputSchema: z.ZodObject | ToolInputSchema;
        getClient: GetClient;
        releaseClient: ReleaseClient;
    }) {
        this.name = name;
        this.description = description;
        this.inputSchema = inputSchema;
        this.getClient = getClient;
        this.releaseClient = releaseClient;
        this.call = this._call.bind(this);
    }

    /**
     * Call the MCP tool with the specified input arguments. This method sends a request to the MCP server to execute
     * the tool and returns the result as a ToolResponse.
     *
     * @param arguments
     * @param input
     * @returns A ToolResponse object containing the result of the tool execution, or an error message if the call fails.
     */
    async _call(input: Record<string, unknown>) {
        const client = await this.getClient();
        try {
            const request: CallToolRequest = {
                method: 'tools/call',
                params: {
                    name: this.name,
                    arguments: input,
                },
            };
            const result = await client.request(request, CallToolResultSchema);

            const content: ToolResponse['content'] = [];
            result.content.forEach(item => {
                if (item.type === 'text') {
                    content.push({ type: 'text', text: item.text, id: crypto.randomUUID() });
                } else if (item.type === 'image' || item.type === 'audio') {
                    content.push({
                        id: crypto.randomUUID(),
                        type: 'data',
                        source: { type: 'base64', media_type: item.mimeType, data: item.data },
                    });
                } else {
                    console.warn(
                        `Unsupported content type '${item.type}' in tool result, skipping...`
                    );
                }
            });
            return createToolResponse({ content, state: 'success' });
        } catch (error) {
            return createToolResponse({
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text: `Error calling tool '${this.name}': ${error}`,
                    },
                ],
                state: 'error',
            });
        } finally {
            await this.releaseClient(client);
        }
    }
}
