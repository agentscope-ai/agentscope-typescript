import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

import { HttpMCPConfig, MCPClient } from '../mcp';
import { TextBlock } from '../message';
import { PermissionBehavior } from '../permission';
import { BackendBase, ExecResult, ToolChunk } from '../tool';
import { BODY_INLINE_LIMIT, GATEWAY_SHIM_SCRIPT, GatewayClient, GatewayMCPClient } from './gateway';

/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

describe('GatewayClient Python parity', () => {
    test('relays JSON with encoded scope and bearer token through the sandbox shim', async () => {
        const backend = new FakeBackend();
        backend.results.push(envelope(201, Buffer.from('{"ok":true}')));
        const gateway = new GatewayClient({
            backend,
            gatewayPort: 5600,
            timeout: 12,
            authToken: 'secret',
        });

        await expect(
            gateway.execRequest('POST', '/mcps', {
                params: { agent_id: 'a/b', session_id: 's p' },
                body: { name: 'echo' },
            })
        ).resolves.toEqual([201, Buffer.from('{"ok":true}')]);

        expect(backend.calls).toEqual([
            {
                command: [
                    'python3',
                    '-c',
                    GATEWAY_SHIM_SCRIPT,
                    'POST',
                    'http://127.0.0.1:5600/mcps?agent_id=a%2Fb&session_id=s+p',
                    expect.stringMatching(/^\/tmp\/[a-f0-9]+\.json$/),
                    String(BODY_INLINE_LIMIT),
                    '/tmp',
                    'secret',
                ],
                options: { timeout: 12 },
            },
        ]);
        expect([...backend.files.keys()]).toEqual([]);
        expect(backend.deleted).toEqual([expect.stringMatching(/^\/tmp\/[a-f0-9]+\.json$/)]);
    });

    test('pulls spilled response bodies and always removes the spill file', async () => {
        const backend = new FakeBackend();
        backend.files.set('/tmp/large.bin', Buffer.from('large'));
        backend.results.push(
            new ExecResult({
                exitCode: 0,
                stdout: Buffer.from(JSON.stringify({ status: 200, body_file: '/tmp/large.bin' })),
            })
        );
        const gateway = new GatewayClient({ backend, gatewayPort: 5600 });

        await expect(gateway.execRequest('GET', '/large')).resolves.toEqual([
            200,
            Buffer.from('large'),
        ]);
        expect(backend.deleted).toEqual(['/tmp/large.bin']);
    });

    test('health omits auth and securely verifies an expected nonce', async () => {
        const backend = new FakeBackend();
        backend.results.push(
            envelope(200, Buffer.from(JSON.stringify({ status: 'ok', instance_nonce: 'nonce' }))),
            envelope(200, Buffer.from(JSON.stringify({ status: 'ok', instance_nonce: 'wrong' }))),
            envelope(200, Buffer.from(JSON.stringify(['nonce'])))
        );
        const gateway = new GatewayClient({
            backend,
            gatewayPort: 5600,
            authToken: 'must-not-leak',
            instanceNonce: 'nonce',
        });

        await expect(gateway.health()).resolves.toBe(true);
        await expect(gateway.health()).resolves.toBe(false);
        await expect(gateway.health()).resolves.toBe(false);
        expect(backend.calls.map(call => call.command.at(-1))).toEqual(['', '', '']);
    });

    test('rejects transport and malformed-envelope failures', async () => {
        const backend = new FakeBackend();
        backend.results.push(
            new ExecResult({ exitCode: 2, stderr: Buffer.from('crash') }),
            envelope(-1, Buffer.alloc(0), 'offline'),
            new ExecResult({ exitCode: 0, stdout: Buffer.from('not-json') })
        );
        const gateway = new GatewayClient({ backend, gatewayPort: 5600 });

        await expect(gateway.execRequest('GET', '/health')).rejects.toThrow(
            'Gateway shim exited with 2'
        );
        await expect(gateway.execRequest('GET', '/health')).rejects.toThrow(
            'Gateway request failed: offline'
        );
        await expect(gateway.execRequest('GET', '/health')).rejects.toThrow('non-JSON stdout');
    });
});

describe('Gateway MCP facade Python parity', () => {
    test('connects, filters tools, calls a tool, and closes within one scope', async () => {
        const backend = new FakeBackend();
        const gateway = new StubGateway({ backend, gatewayPort: 5600 });
        const source = new MCPClient({
            name: 'server',
            isStateful: false,
            mcpConfig: new HttpMCPConfig({ url: 'https://example.com/mcp' }),
            enableTools: ['echo'],
        });
        const client = gateway.makeClient(source, { agentId: 'agent', sessionId: 'session' });
        const descriptor = toolDescriptor();
        const chunk = new ToolChunk({
            id: 'chunk',
            content: [
                TextBlock({ id: 'text', created_at: '2026-01-01T00:00:00.000Z', text: 'ok' }),
            ],
            state: 'success',
        });
        gateway.responses.push(
            [200, Buffer.from('{}')],
            [200, Buffer.from(JSON.stringify([descriptor, { ...descriptor, name: 'hidden' }]))],
            [200, Buffer.from(JSON.stringify({ chunk: chunk.toJSON() }))],
            [200, Buffer.from('{}')]
        );

        expect(client).toBeInstanceOf(GatewayMCPClient);
        await client.connect();
        const tools = await client.listTools();
        expect(tools.map(tool => ({ name: tool.name, originalName: tool.originalName }))).toEqual([
            { name: 'mcp__server__echo', originalName: 'echo' },
        ]);
        await expect(tools[0].checkPermissions()).resolves.toEqual(
            expect.objectContaining({ behavior: PermissionBehavior.ALLOW })
        );
        await expect(tools[0].call({ value: 'hello' })).resolves.toEqual(chunk);
        await client.close(false);

        expect(gateway.requests).toEqual([
            expect.objectContaining({ method: 'POST', path: '/mcps' }),
            expect.objectContaining({
                method: 'GET',
                path: '/mcps/server/tools',
                options: { params: { agent_id: 'agent', session_id: 'session' } },
            }),
            expect.objectContaining({
                method: 'POST',
                path: '/mcps/server/tools/echo',
                options: {
                    params: { agent_id: 'agent', session_id: 'session' },
                    body: { arguments: { value: 'hello' } },
                },
            }),
            expect.objectContaining({ method: 'DELETE', path: '/mcps/server' }),
        ]);
    });

    test('turns gateway tool errors into error chunks and detects missing chunks', async () => {
        const gateway = new StubGateway({ backend: new FakeBackend(), gatewayPort: 5600 });
        const client = gateway.makeClient(httpClient('server'), { connected: true });
        gateway.responses.push(
            [200, Buffer.from(JSON.stringify([toolDescriptor()]))],
            [404, Buffer.from(JSON.stringify({ detail: 'missing' }))],
            [200, Buffer.from('{}')]
        );
        const tool = await client.getTool('echo');

        await expect(tool.call({})).resolves.toEqual(
            expect.objectContaining({
                state: 'error',
                content: [expect.objectContaining({ text: 'HTTP 404: missing' })],
            })
        );
        await expect(tool.call({})).rejects.toThrow('returned no chunk');
    });
});

/**
 *
 */
class FakeBackend extends BackendBase {
    readonly results: ExecResult[] = [];
    readonly calls: Array<{ command: string[]; options: unknown }> = [];
    readonly files = new Map<string, Buffer>();
    readonly deleted: string[] = [];

    /**
     *
     * @param command
     * @param options
     * @param options.cwd
     * @param options.timeout
     * @param options.signal
     */
    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        this.calls.push({ command, options });
        return this.results.shift() ?? envelope(200, Buffer.from('ok'));
    }

    /**
     *
     * @param filePath
     */
    async readFile(filePath: string): Promise<Buffer> {
        const value = this.files.get(filePath);
        if (!value) throw new Error(`Missing ${filePath}`);
        return value;
    }

    /**
     *
     * @param filePath
     * @param data
     */
    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        this.files.set(filePath, Buffer.from(data));
    }

    /**
     *
     * @param filePath
     */
    override async deletePath(filePath: string): Promise<void> {
        this.deleted.push(filePath);
        this.files.delete(filePath);
    }
}

/**
 *
 */
class StubGateway extends GatewayClient {
    readonly responses: Array<[number, Buffer]> = [];
    readonly requests: Array<{ method: string; path: string; options: unknown }> = [];

    /**
     *
     * @param method
     * @param path
     * @param options
     */
    override async execRequest(
        method: string,
        path: string,
        options: unknown = {}
    ): Promise<[number, Buffer]> {
        this.requests.push({ method, path, options });
        const response = this.responses.shift();
        if (!response) throw new Error('Missing stub response');
        return response;
    }
}

/**
 *
 * @param status
 * @param body
 * @param error
 */
function envelope(status: number, body: Buffer, error?: string): ExecResult {
    return new ExecResult({
        exitCode: 0,
        stdout: Buffer.from(
            JSON.stringify({ status, body: body.toString('base64'), ...(error ? { error } : {}) })
        ),
    });
}

/**
 *
 */
function toolDescriptor(): MCPToolDefinition {
    return {
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
        },
        annotations: { readOnlyHint: true },
    };
}

/**
 *
 * @param name
 */
function httpClient(name: string): MCPClient {
    return new MCPClient({
        name,
        isStateful: false,
        mcpConfig: new HttpMCPConfig({ url: `https://example.com/${name}` }),
    });
}
