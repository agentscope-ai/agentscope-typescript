/* eslint-disable jsdoc/require-jsdoc */

import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import {
    createOpenSandboxClient,
    type OpenSandboxClientDriver,
    type OpenSandboxConnectionOptions,
    type OpenSandboxExecution,
    type OpenSandboxInfo,
    type OpenSandboxProtocol,
    type OpenSandboxSandboxDriver,
} from './opensandbox-driver';
import { SandboxedWorkspaceBase } from './sandboxed';
import { DEFAULT_WORKSPACE_INSTRUCTIONS, formatWorkspaceInstructions } from './utils';

export const DEFAULT_OPENSANDBOX_IMAGE = 'python:3.11-slim';
export const DEFAULT_OPENSANDBOX_TIMEOUT = 300;
export const OPENSANDBOX_BOOTSTRAP_COMMAND_TIMEOUT = 600;
export const DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT = 600;
export const DEFAULT_OPENSANDBOX_GATEWAY_PORT = 5600;
export const OPENSANDBOX_WORKDIR = '/workspace';
export const OPENSANDBOX_GATEWAY_HOME = '/root/.agentscope';
export const OPENSANDBOX_WORKSPACE_ID_METADATA_KEY = 'agentscope.workspace.id';

export interface OpenSandboxBackendOptions {
    sandbox: OpenSandboxSandboxDriver;
    workdir: string;
}

/** Backend that delegates commands and binary file operations to OpenSandbox. */
export class OpenSandboxBackend extends BackendBase {
    readonly sandbox: OpenSandboxSandboxDriver;
    readonly workdir: string;

    constructor(options: OpenSandboxBackendOptions) {
        super();
        this.sandbox = options.sandbox;
        this.workdir = options.workdir;
    }

    override async getCwd(): Promise<string> {
        return this.workdir;
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        if (options.signal?.aborted) {
            return new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') });
        }
        try {
            const result = await this.sandbox.run(command.map(quotePosixShellArgument).join(' '), {
                workingDirectory: options.cwd ?? this.workdir,
                ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            return new ExecResult({
                exitCode: result.exitCode || 0,
                stdout: executionStreamBytes(result, 'stdout'),
                stderr: executionStreamBytes(result, 'stderr'),
            });
        } catch (error) {
            return new ExecResult({ exitCode: -1, stderr: Buffer.from(errorMessage(error)) });
        }
    }

    async readFile(filePath: string): Promise<Buffer> {
        try {
            return Buffer.from(await this.sandbox.readBytes(filePath));
        } catch (error) {
            if (isOpenSandboxNotFound(error)) {
                throw new Error(`not found in OpenSandbox sandbox: ${filePath}`, { cause: error });
            }
            throw error;
        }
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.posix.dirname(filePath);
        if (parent !== '.') await this.execShell(['mkdir', '-p', parent]);
        await this.sandbox.writeFiles([{ path: filePath, data, mode: 0o644 }]);
    }

    override async writeStream(filePath: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
        const parent = path.posix.dirname(filePath);
        if (parent !== '.') await this.execShell(['mkdir', '-p', parent]);
        await this.sandbox.writeFiles([{ path: filePath, data: stream, mode: 0o644 }]);
    }
}

export interface OpenSandboxWorkspaceOptions extends WorkspaceBaseOptions {
    image?: string;
    apiKey?: string;
    domain?: string;
    protocol?: OpenSandboxProtocol;
    requestTimeoutSeconds?: number | null;
    timeoutSeconds?: number;
    gatewayPort?: number;
    env?: Record<string, string>;
    sandboxMetadata?: Record<string, string>;
    resource?: Record<string, string>;
    entrypoint?: string[];
    networkPolicy?: Record<string, unknown> | null;
    extraPip?: string[];
    instructions?: string;
    client?: OpenSandboxClientDriver;
    clientFactory?: (options: OpenSandboxConnectionOptions) => Promise<OpenSandboxClientDriver>;
}

/** Persistent remote workspace backed by OpenSandbox. */
export class OpenSandboxWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = OPENSANDBOX_WORKDIR;
    readonly image: string;
    readonly apiKey: string;
    readonly domain: string;
    readonly protocol: OpenSandboxProtocol;
    readonly requestTimeoutSeconds: number | null;
    readonly timeoutSeconds: number;
    readonly gatewayPort: number;
    readonly env: Record<string, string>;
    readonly sandboxMetadata: Record<string, string>;
    readonly resource: Record<string, string>;
    readonly entrypoint: string[];
    readonly networkPolicy: Record<string, unknown> | null;
    readonly extraPip: string[];
    readonly instructions: string;
    protected readonly gatewayHome = OPENSANDBOX_GATEWAY_HOME;
    protected client: OpenSandboxClientDriver | null;
    protected sandbox: OpenSandboxSandboxDriver | null = null;
    protected readinessTimeoutSeconds = 30;
    private readonly clientFactory: (
        options: OpenSandboxConnectionOptions
    ) => Promise<OpenSandboxClientDriver>;

    constructor(options: OpenSandboxWorkspaceOptions = {}) {
        super(options);
        this.image = options.image ?? DEFAULT_OPENSANDBOX_IMAGE;
        this.apiKey = options.apiKey ?? '';
        this.domain = options.domain ?? '';
        this.protocol = options.protocol ?? 'http';
        this.requestTimeoutSeconds =
            options.requestTimeoutSeconds === undefined
                ? DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT
                : options.requestTimeoutSeconds;
        this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_OPENSANDBOX_TIMEOUT;
        this.gatewayPort = options.gatewayPort ?? DEFAULT_OPENSANDBOX_GATEWAY_PORT;
        this.env = { ...(options.env ?? {}) };
        this.sandboxMetadata = { ...(options.sandboxMetadata ?? {}) };
        this.resource = { ...(options.resource ?? {}) };
        this.entrypoint = [...(options.entrypoint ?? [])];
        this.networkPolicy = options.networkPolicy ? structuredClone(options.networkPolicy) : null;
        this.extraPip = [...(options.extraPip ?? [])];
        this.instructions = options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS;
        this.client = options.client ?? null;
        this.clientFactory = options.clientFactory ?? createOpenSandboxClient;
        this.bootstrapCommandTimeout = OPENSANDBOX_BOOTSTRAP_COMMAND_TIMEOUT;
    }

    get sandboxId(): string | null {
        return this.sandbox?.id ?? null;
    }

    async getInstructions(): Promise<string> {
        return formatWorkspaceInstructions(this.instructions, {
            backend: 'OpenSandbox',
            workdir: this.workdir,
        });
    }

    protected async provisionBackend(): Promise<void> {
        this.client ??= await this.clientFactory(this.connectionOptions());
        const existing = await this.findExistingSandbox();
        this.sandbox = existing
            ? await this.attachExistingSandbox(existing)
            : await this.createSandbox();
        await this.waitUntilRunning();
        this.backend = new OpenSandboxBackend({
            sandbox: this.sandbox,
            workdir: this.workdir,
        });
    }

    protected async teardownBackend(): Promise<void> {
        const sandbox = this.sandbox;
        if (sandbox) {
            await sandbox
                .pause()
                .catch(error =>
                    logger.warning('OpenSandboxWorkspace: pause failed: %s', String(error))
                );
            await sandbox
                .close()
                .catch(error =>
                    logger.warning('OpenSandboxWorkspace: local close failed: %s', String(error))
                );
        }
        this.sandbox = null;
        this.backend = null;
    }

    protected async findExistingSandbox(): Promise<OpenSandboxInfo | null> {
        const candidates = await this.requireClient().list({
            states: ['Running', 'Paused'],
            metadata: { [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: this.workspaceId },
        });
        if (!candidates.length) return null;
        if (candidates.length > 1) {
            logger.warning(
                'OpenSandboxWorkspace: %d sandboxes match workspace_id=%s; attaching to most recent',
                candidates.length,
                JSON.stringify(this.workspaceId)
            );
        }
        return [...candidates].sort(
            (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        )[0];
    }

    protected async createSandbox(): Promise<OpenSandboxSandboxDriver> {
        return this.requireClient().create({
            image: this.image,
            metadata: {
                ...this.sandboxMetadata,
                [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: this.workspaceId,
            },
            timeoutSeconds: this.timeoutSeconds,
            readyTimeoutSeconds: this.timeoutSeconds,
            ...(Object.keys(this.env).length ? { env: this.env } : {}),
            ...(Object.keys(this.resource).length ? { resource: this.resource } : {}),
            ...(this.entrypoint.length ? { entrypoint: this.entrypoint } : {}),
            ...(this.networkPolicy ? { networkPolicy: this.networkPolicy } : {}),
        });
    }

    protected async attachExistingSandbox(
        info: OpenSandboxInfo
    ): Promise<OpenSandboxSandboxDriver> {
        const state = info.state.toLowerCase();
        if (state === 'paused') return this.requireClient().resume(info.id, this.timeoutSeconds);
        if (state === 'running') return this.requireClient().connect(info.id, this.timeoutSeconds);
        throw new Error(
            `OpenSandbox sandbox ${JSON.stringify(info.id)} is not attachable ` +
                `(state=${JSON.stringify(state)})`
        );
    }

    protected async waitUntilRunning(timeoutSeconds = this.readinessTimeoutSeconds): Promise<void> {
        const probe = this.sandbox?.isHealthy;
        if (!probe) return;
        const deadline = this.now() + timeoutSeconds * 1000;
        let delay = 100;
        while (this.now() < deadline) {
            try {
                if (await probe.call(this.sandbox)) return;
            } catch (error) {
                logger.debug(
                    'OpenSandboxWorkspace: isHealthy probe error (will retry): %s',
                    String(error)
                );
            }
            await this.sleep(delay);
            delay = Math.min(delay * 1.5, 1000);
        }
        throw new Error(
            `OpenSandbox sandbox did not become ready within ${timeoutSeconds}s ` +
                `(workspace_id=${JSON.stringify(this.workspaceId)})`
        );
    }

    protected bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quotePosixShellArgument)
            .join(' ');
        return [
            'apt-get update -qq && apt-get install -y --no-install-recommends ' +
                'curl ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                '| env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${this.gatewayVenv}`,
            `uv pip install --python ${this.gatewayPython} ${packages}`,
            `uv pip install --python ${this.gatewayPython} --no-deps 'agentscope'`,
        ];
    }

    protected now(): number {
        return performance.now();
    }

    protected async sleep(milliseconds: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    private connectionOptions(): OpenSandboxConnectionOptions {
        return {
            protocol: this.protocol,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            ...(this.domain ? { domain: this.domain } : {}),
            ...(this.requestTimeoutSeconds === null
                ? {}
                : { requestTimeoutSeconds: this.requestTimeoutSeconds }),
        };
    }

    private requireClient(): OpenSandboxClientDriver {
        if (!this.client) throw new Error('OpenSandbox client is not initialized.');
        return this.client;
    }
}

function executionStreamBytes(result: OpenSandboxExecution, stream: 'stdout' | 'stderr'): Buffer {
    const direct = result[stream];
    if (direct !== undefined) {
        return direct instanceof Uint8Array ? Buffer.from(direct) : Buffer.from(String(direct));
    }
    const entries = stream === 'stdout' ? (result.stdoutLogs ?? []) : (result.stderrLogs ?? []);
    let text = '';
    for (const entry of entries) {
        const part = typeof entry === 'string' ? entry : String(entry.text ?? '');
        if (text && part && !/[\n\r\s]$/.test(text) && !/^[\n\r\s]/.test(part)) text += '\n';
        text += part;
    }
    return Buffer.from(text);
}

function isOpenSandboxNotFound(error: unknown, seen = new Set<unknown>()): boolean {
    if (!error || typeof error !== 'object') return false;
    if (seen.has(error)) return false;
    seen.add(error);
    const record = error as Record<string, unknown>;
    if (record.name === 'FileNotFoundError' || record.code === 'ENOENT') return true;
    const response = record.response as Record<string, unknown> | undefined;
    const status = response?.status ?? response?.statusCode ?? record.status ?? record.statusCode;
    if (Number(status) === 404) return true;
    if (isOpenSandboxNotFound(record.cause, seen)) return true;
    return errorMessage(error).toLowerCase().includes('not found');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function quotePosixShellArgument(value: string): string {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
