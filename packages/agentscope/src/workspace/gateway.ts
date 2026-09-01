/* eslint-disable jsdoc/require-jsdoc */

import { timingSafeEqual } from 'node:crypto';

import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';

import { _generateId } from '../_utils';
import { logger } from '../logger';
import { MCPClient, type MCPClientOptions } from '../mcp';
import { TextBlock } from '../message';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import type { PermissionDecision } from '../permission';
import { ToolBase, ToolChunk, parseToolChunk } from '../tool';
import type { BackendBase } from '../tool';
import type { ToolInputSchema } from '../type';
import { type MCPClientWire, deserializeMcpClient, serializeMcpClient } from './base';

export const BODY_INLINE_LIMIT = 4 * 1024 * 1024;
export const SANDBOX_TMP_DIR = '/tmp';

/** Stdlib-only relay executed inside a sandbox through Python. */
export const GATEWAY_SHIM_SCRIPT = String.raw`
import sys, json, base64, uuid, os
import urllib.request, urllib.error

method = sys.argv[1]
url = sys.argv[2]
body_file = sys.argv[3]
inline_limit = int(sys.argv[4])
tmp_dir = sys.argv[5]
auth_token = sys.argv[6] if len(sys.argv) > 6 else ""
body = None
if body_file:
    with open(body_file, "rb") as f:
        body = f.read()
req = urllib.request.Request(url, data=body, method=method)
if body is not None:
    req.add_header("Content-Type", "application/json")
if auth_token:
    req.add_header("Authorization", "Bearer " + auth_token)
try:
    with urllib.request.urlopen(req) as resp:
        status = int(resp.status)
        resp_body = resp.read()
except urllib.error.HTTPError as e:
    status = int(e.code)
    try:
        resp_body = e.read()
    except Exception:
        resp_body = b""
except Exception as e:
    json.dump({"status": -1, "error": type(e).__name__ + ": " + str(e)}, sys.stdout)
    sys.exit(0)
env = {"status": status}
if len(resp_body) > inline_limit:
    p = os.path.join(tmp_dir, uuid.uuid4().hex + ".bin")
    with open(p, "wb") as f:
        f.write(resp_body)
    env["body_file"] = p
else:
    env["body"] = base64.b64encode(resp_body).decode("ascii")
json.dump(env, sys.stdout)
`;

export interface GatewayRequestOptions {
    params?: Record<string, string>;
    body?: unknown;
    includeAuth?: boolean;
}

/** MCP tool whose transport is relayed by an in-sandbox gateway. */
export class GatewayMCPTool extends ToolBase {
    readonly name: string;
    readonly originalName: string;
    readonly description: string;
    readonly inputSchema: ToolInputSchema;
    readonly isConcurrencySafe = false;
    readonly isReadOnly: boolean;
    override isMcp = true;
    override mcpName: string;
    private readonly gateway: GatewayClient;
    private readonly agentId: string;
    private readonly sessionId: string;

    constructor(options: {
        mcpName: string;
        tool: MCPToolDefinition;
        gateway: GatewayClient;
        agentId?: string;
        sessionId?: string;
    }) {
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
        this.gateway = options.gateway;
        this.agentId = options.agentId ?? '';
        this.sessionId = options.sessionId ?? '';
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
        const [status, body] = await this.gateway.execRequest(
            'POST',
            `/mcps/${encodeURIComponent(this.mcpName)}/tools/${encodeURIComponent(this.originalName)}`,
            {
                params: { agent_id: this.agentId, session_id: this.sessionId },
                body: { arguments: input },
            }
        );
        if (status >= 400) {
            return new ToolChunk({
                content: [TextBlock({ text: safeDetail(status, body) })],
                state: 'error',
            });
        }
        const payload = JSON.parse(body.toString('utf8')) as { chunk?: unknown };
        if (payload.chunk === undefined) {
            throw new Error(`Gateway returned no chunk for ${JSON.stringify(this.name)}`);
        }
        return parseToolChunk(payload.chunk);
    }
}

/** MCPClient facade that never opens a host-side MCP transport. */
export class GatewayMCPClient extends MCPClient {
    private gateway: GatewayClient | null = null;
    private agentId = '';
    private sessionId = '';
    private gatewayTools: MCPToolDefinition[] | null = null;

    attach(
        gateway: GatewayClient,
        options: { agentId?: string; sessionId?: string; connected?: boolean } = {}
    ): void {
        this.gateway = gateway;
        this.agentId = options.agentId ?? '';
        this.sessionId = options.sessionId ?? '';
        this.connected = options.connected ?? false;
    }

    override async connect(): Promise<void> {
        if (this.connected) {
            throw new Error(`MCP ${JSON.stringify(this.name)} is already connected.`);
        }
        const [status, body] = await this.requireGateway().execRequest('POST', '/mcps', {
            params: { agent_id: this.agentId, session_id: this.sessionId },
            body: serializeMcpClient(this),
        });
        if (status >= 400) {
            throw new Error(
                `Gateway failed to add MCP ${JSON.stringify(this.name)}: ${safeDetail(status, body)}`
            );
        }
        this.connected = true;
    }

    override async close(ignoreErrors = true): Promise<void> {
        if (!this.connected) {
            if (ignoreErrors) return;
            throw new Error(`MCP ${JSON.stringify(this.name)} is not connected.`);
        }
        try {
            const [status, body] = await this.requireGateway().execRequest(
                'DELETE',
                `/mcps/${encodeURIComponent(this.name)}`,
                { params: { agent_id: this.agentId, session_id: this.sessionId } }
            );
            if (status >= 400 && !ignoreErrors) {
                throw new Error(
                    `Gateway failed to remove MCP ${JSON.stringify(this.name)}: ${safeDetail(status, body)}`
                );
            }
        } catch (error) {
            if (!ignoreErrors) throw error;
        } finally {
            this.connected = false;
            this.gatewayTools = null;
        }
    }

    override async listRawTools(): Promise<MCPToolDefinition[]> {
        this.validateConnection();
        const [status, body] = await this.requireGateway().execRequest(
            'GET',
            `/mcps/${encodeURIComponent(this.name)}/tools`,
            { params: { agent_id: this.agentId, session_id: this.sessionId } }
        );
        if (status >= 400) {
            throw new Error(
                `Gateway failed to list tools for MCP ${JSON.stringify(this.name)}: ${safeDetail(status, body)}`
            );
        }
        const tools = JSON.parse(body.toString('utf8')) as MCPToolDefinition[];
        this.gatewayTools = tools;
        return tools.filter(tool => this.isToolEnabled(tool.name));
    }

    override async listTools(): Promise<GatewayMCPTool[]> {
        return (await this.listRawTools()).map(tool => this.wrapTool(tool));
    }

    override async getTool(name: string): Promise<GatewayMCPTool> {
        this.validateConnection();
        if (!this.gatewayTools) await this.listRawTools();
        const tool = this.gatewayTools?.find(
            item => item.name === name || `mcp__${this.name}__${item.name}` === name
        );
        if (!tool) throw new Error(`Tool ${JSON.stringify(name)} not found in MCP ${this.name}.`);
        return this.wrapTool(tool);
    }

    private wrapTool(tool: MCPToolDefinition): GatewayMCPTool {
        return new GatewayMCPTool({
            mcpName: this.name,
            tool,
            gateway: this.requireGateway(),
            agentId: this.agentId,
            sessionId: this.sessionId,
        });
    }

    private requireGateway(): GatewayClient {
        if (!this.gateway) throw new Error('GatewayMCPClient is not attached.');
        return this.gateway;
    }
}

export interface GatewayClientOptions {
    backend: BackendBase;
    gatewayPort: number;
    timeout?: number | null;
    inlineLimit?: number;
    tmpDir?: string;
    gatewayLogPath?: string | null;
    authToken?: string | null;
    instanceNonce?: string | null;
}

/** Host-side facade over an MCP gateway reachable only inside a sandbox. */
export class GatewayClient {
    readonly backend: BackendBase;
    readonly gatewayPort: number;
    readonly timeout: number | null;
    readonly inlineLimit: number;
    readonly tmpDir: string;
    readonly gatewayLogPath: string | null;
    readonly authToken: string | null;
    readonly instanceNonce: string | null;

    constructor(options: GatewayClientOptions) {
        this.backend = options.backend;
        this.gatewayPort = options.gatewayPort;
        this.timeout = options.timeout ?? null;
        this.inlineLimit = options.inlineLimit ?? BODY_INLINE_LIMIT;
        this.tmpDir = options.tmpDir ?? SANDBOX_TMP_DIR;
        this.gatewayLogPath = options.gatewayLogPath ?? null;
        this.authToken = options.authToken ?? null;
        this.instanceNonce = options.instanceNonce ?? null;
    }

    async health(): Promise<boolean> {
        try {
            const [status, body] = await this.execRequest('GET', '/health', {
                includeAuth: false,
            });
            if (status !== 200) return false;
            if (this.instanceNonce === null) return true;
            const payload = JSON.parse(body.toString('utf8')) as unknown;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
            const nonce = (payload as { instance_nonce?: unknown }).instance_nonce;
            return typeof nonce === 'string' && secureEqualAscii(nonce, this.instanceNonce);
        } catch {
            return false;
        }
    }

    async listMcps(agentId = '', sessionId = ''): Promise<GatewayMCPClient[]> {
        const [status, body] = await this.execRequest('GET', '/mcps', {
            params: { agent_id: agentId, session_id: sessionId },
        });
        if (status >= 400)
            throw new Error(`Gateway failed to list MCPs: ${safeDetail(status, body)}`);
        const specs = JSON.parse(body.toString('utf8')) as MCPClientWire[];
        return specs.map(spec => this.makeClient(spec, { agentId, sessionId, connected: true }));
    }

    makeClient(
        spec: MCPClient | MCPClientWire,
        options: { agentId?: string; sessionId?: string; connected?: boolean } = {}
    ): GatewayMCPClient {
        const source = spec instanceof MCPClient ? spec : deserializeMcpClient(spec);
        const client = new GatewayMCPClient(mcpOptions(source));
        client.attach(this, options);
        return client;
    }

    async close(): Promise<void> {}

    async execRequest(
        method: string,
        requestPath: string,
        options: GatewayRequestOptions = {}
    ): Promise<[number, Buffer]> {
        const query = new URLSearchParams(options.params ?? {}).toString();
        const pathWithQuery = query ? `${requestPath}?${query}` : requestPath;
        let bodyFile = '';
        if (options.body !== undefined) {
            bodyFile = `${this.tmpDir}/${_generateId()}.json`;
            await this.backend.writeFile(bodyFile, Buffer.from(JSON.stringify(options.body)));
        }
        try {
            const result = await this.backend.execShell(
                [
                    'python3',
                    '-c',
                    GATEWAY_SHIM_SCRIPT,
                    method,
                    `http://127.0.0.1:${this.gatewayPort}${pathWithQuery}`,
                    bodyFile,
                    String(this.inlineLimit),
                    this.tmpDir,
                    options.includeAuth === false ? '' : (this.authToken ?? ''),
                ],
                { timeout: this.timeout ?? undefined }
            );
            if (!result.ok()) {
                throw new Error(
                    `Gateway shim exited with ${result.exitCode}: ${result.stderr.toString('utf8').slice(0, 500)}`
                );
            }
            let envelope: { status: number; body?: string; body_file?: string; error?: string };
            try {
                envelope = JSON.parse(result.stdout.toString('utf8'));
            } catch {
                throw new Error(
                    `Gateway shim produced non-JSON stdout: ${result.stdout.toString('utf8').slice(0, 200)}`
                );
            }
            if (envelope.status === -1) {
                throw new Error(`Gateway request failed: ${envelope.error ?? 'unknown error'}`);
            }
            if (envelope.body_file) {
                const body = await this.backend.readFile(envelope.body_file);
                await this.backend.deletePath(envelope.body_file).catch(() => undefined);
                return [Number(envelope.status), body];
            }
            return [Number(envelope.status), Buffer.from(envelope.body ?? '', 'base64')];
        } catch (error) {
            if (requestPath !== '/health') await this.diagnoseFailure(method, pathWithQuery, error);
            throw error;
        } finally {
            if (bodyFile) await this.backend.deletePath(bodyFile).catch(() => undefined);
        }
    }

    private async diagnoseFailure(
        method: string,
        requestPath: string,
        error: unknown
    ): Promise<void> {
        if (await this.health()) return;
        logger.error('Gateway unreachable during %s %s: %s.', method, requestPath, String(error));
        if (!this.gatewayLogPath) return;
        try {
            const log = await this.backend.readFile(this.gatewayLogPath);
            logger.error('Gateway log tail:\n%s', log.subarray(-4000).toString('utf8'));
        } catch (readError) {
            logger.error('Failed to read gateway log: %s', String(readError));
        }
    }
}

function mcpOptions(client: MCPClient): MCPClientOptions {
    return {
        name: client.name,
        isStateful: client.isStateful,
        mcpConfig: client.mcpConfig,
        enableTools: client.enableTools,
        disableTools: client.disableTools,
        executionTimeout: client.executionTimeout,
    };
}

function safeDetail(status: number, body: Uint8Array): string {
    const text = Buffer.from(body).toString('utf8');
    try {
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value) && 'detail' in value) {
            return `HTTP ${status}: ${String((value as { detail: unknown }).detail)}`;
        }
        return `HTTP ${status}: ${String(value).slice(0, 200)}`;
    } catch {
        return `HTTP ${status}: ${text.slice(0, 200)}`;
    }
}

function secureEqualAscii(actual: string, expected: string): boolean {
    if (!/^[\x00-\x7f]*$/.test(actual) || !/^[\x00-\x7f]*$/.test(expected)) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}
