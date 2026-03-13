import * as http from 'http';

import { HTTPMCPClient } from './http';
import { Toolkit, ToolResponse } from '../tool';

/**
 * Creates a minimal MCP HTTP server for testing purposes.
 *
 * @param port - The port number to listen on
 * @returns An HTTP server instance
 */
function createTestMCPServer(port: number): http.Server {
    const sessions = new Map<string, Record<string, unknown>>();
    let sessionCounter = 0;

    const server = http.createServer(async (req, res) => {
        // Handle CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const message = JSON.parse(body);
                let response: Record<string, unknown>;

                switch (message.method) {
                    case 'initialize': {
                        sessionCounter++;
                        const sessionId = `session-${sessionCounter}`;
                        sessions.set(sessionId, {});
                        response = {
                            jsonrpc: '2.0',
                            id: message.id,
                            result: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} },
                                serverInfo: {
                                    name: 'test-mcp-server',
                                    version: '1.0.0',
                                },
                                sessionId,
                            },
                        };
                        break;
                    }

                    case 'tools/list': {
                        response = {
                            jsonrpc: '2.0',
                            id: message.id,
                            result: {
                                tools: [
                                    {
                                        name: 'add',
                                        description: 'Adds two numbers together',
                                        inputSchema: {
                                            type: 'object',
                                            properties: {
                                                a: {
                                                    type: 'number',
                                                    description: 'First number',
                                                },
                                                b: {
                                                    type: 'number',
                                                    description: 'Second number',
                                                },
                                            },
                                            required: ['a', 'b'],
                                        },
                                    },
                                ],
                            },
                        };
                        break;
                    }

                    case 'tools/call': {
                        if (message.params.name === 'add') {
                            const { a, b } = message.params.arguments;
                            const result = a + b;
                            response = {
                                jsonrpc: '2.0',
                                id: message.id,
                                result: {
                                    content: [
                                        {
                                            type: 'text',
                                            text: `Result: ${a} + ${b} = ${result}`,
                                        },
                                    ],
                                },
                            };
                        } else {
                            response = {
                                jsonrpc: '2.0',
                                id: message.id,
                                error: {
                                    code: -32601,
                                    message: 'Tool not found',
                                },
                            };
                        }
                        break;
                    }

                    default: {
                        response = {
                            jsonrpc: '2.0',
                            id: message.id,
                            error: {
                                code: -32601,
                                message: 'Method not found',
                            },
                        };
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: null,
                        error: {
                            code: -32700,
                            message: 'Parse error',
                        },
                    })
                );
            }
        });
    });

    server.listen(port);
    return server;
}

describe('HTTPStatefulMCPClient', () => {
    const TEST_PORT = 13579;
    const TEST_URL = `http://localhost:${TEST_PORT}/mcp`;
    let testServer: http.Server;

    beforeAll(() => {
        testServer = createTestMCPServer(TEST_PORT);
    });

    afterAll(done => {
        testServer.close(done);
    });

    test('Create HTTP MCP client, list and execute tools', async () => {
        const client = new HTTPMCPClient({
            name: 'test-mcp-server',
            transportType: 'streamable-http',
            url: TEST_URL,
            stateful: true,
        });
        await client.connect();

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        const func = await client.getCallableFunction({ name: 'add' });
        const res = await func.call({ a: 5, b: 3 });
        expect(res.content.length).toBeGreaterThan(0);
        expect(res.content[0].type).toBe('text');
        if (res.content[0].type === 'text') {
            expect(res.content[0].text).toContain('8');
        }

        await client.close();

        // Try to reconnect and list tools again
        await client.connect();
        const tools2 = await client.listTools();
        expect(tools2.length).toBeGreaterThan(0);

        await client.close();
    }, 10000);

    test('Test toolkit works with HTTPStatefulMCPClient', async () => {
        const client = new HTTPMCPClient({
            name: 'test-mcp-server',
            transportType: 'streamable-http',
            url: TEST_URL,
            stateful: true,
        });
        await client.connect();

        const toolkit = new Toolkit();
        await toolkit.registerMCPClient({ client, enabledTools: ['add'] });

        const schema = toolkit.getJSONSchemas();
        expect(schema.length).toBe(2);
        expect(schema[1].type).toBe('function');
        expect(schema[1].function.name).toBe('add');
        expect(schema[1].function.parameters).toBeDefined();

        const res = toolkit.callToolFunction({
            id: '123',
            name: 'add',
            type: 'tool_call',
            input: `{"a": 10, "b": 20}`,
        });
        for await (const item of res) {
            expect(item.content.length).toBeGreaterThan(0);
            expect(item.content[0].type).toBe('text');
            if (item.content[0].type === 'text') {
                expect(item.content[0].text).toContain('30');
            }
        }

        await client.close();
    }, 10000);
});

describe('HTTPStatelessMCPClient', () => {
    const TEST_PORT = 13580;
    const TEST_URL = `http://localhost:${TEST_PORT}/mcp`;
    let testServer: http.Server;

    beforeAll(() => {
        testServer = createTestMCPServer(TEST_PORT);
    });

    afterAll(done => {
        testServer.close(done);
    });

    test('Create stateless HTTP MCP client, list and execute tools without explicit connect/close', async () => {
        const client = new HTTPMCPClient({
            name: 'test-mcp-server',
            transportType: 'streamable-http',
            url: TEST_URL,
            stateful: false,
        });

        // connect() and close() are no-ops for stateless clients
        await client.connect();

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        const func = await client.getCallableFunction({ name: 'add' });
        const res = await func.call({ a: 7, b: 13 });
        expect(res.content.length).toBeGreaterThan(0);
        expect(res.content[0].type).toBe('text');
        if (res.content[0].type === 'text') {
            expect(res.content[0].text).toContain('20');
        }

        await client.close();
    }, 10000);

    test('Test toolkit works with HTTPStatelessMCPClient', async () => {
        const client = new HTTPMCPClient({
            name: 'test-mcp-server',
            transportType: 'streamable-http',
            url: TEST_URL,
            stateful: false,
        });

        const toolkit = new Toolkit();
        await toolkit.registerMCPClient({ client, enabledTools: ['add'] });

        const schema = toolkit.getJSONSchemas();
        expect(schema.length).toBe(2);
        expect(schema[1].type).toBe('function');
        expect(schema[1].function.name).toBe('add');
        expect(schema[1].function.parameters).toBeDefined();

        const res = toolkit.callToolFunction({
            id: '123',
            name: 'add',
            type: 'tool_call',
            input: `{"a": 15, "b": 25}`,
        });
        const collectedRes: ToolResponse[] = [];
        for await (const item of res) {
            collectedRes.push(item);
            expect(item.content.length).toBeGreaterThan(0);
            expect(item.content[0].type).toBe('text');
            if (item.content[0].type === 'text') {
                expect(item.content[0].text).toContain('40');
            }
        }
        expect(collectedRes.length).toBe(1);
    }, 10000);
});
