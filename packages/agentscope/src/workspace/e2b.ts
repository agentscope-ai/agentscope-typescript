/* eslint-disable jsdoc/require-jsdoc */

import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import {
    createE2BClient,
    type E2BApiOptions,
    type E2BClientDriver,
    type E2BSandboxDriver,
    type E2BSandboxInfo,
} from './e2b-driver';
import { SandboxedWorkspaceBase } from './sandboxed';
import { DEFAULT_WORKSPACE_INSTRUCTIONS, formatWorkspaceInstructions } from './utils';

export const DEFAULT_E2B_TEMPLATE = 'base';
export const DEFAULT_E2B_TIMEOUT = 300;
export const DEFAULT_E2B_GATEWAY_PORT = 5600;
export const E2B_SANDBOX_USER_HOME = '/home/user';
export const E2B_SANDBOX_WORKDIR = `${E2B_SANDBOX_USER_HOME}/workspace`;
export const E2B_GATEWAY_HOME = `${E2B_SANDBOX_USER_HOME}/.agentscope`;
export const E2B_WORKSPACE_ID_METADATA_KEY = 'agentscope.workspace.id';

export interface E2BBackendOptions {
    sandbox: E2BSandboxDriver;
    workdir: string;
}

/** Backend that delegates commands and file operations to an E2B sandbox. */
export class E2BBackend extends BackendBase {
    readonly sandbox: E2BSandboxDriver;
    readonly workdir: string;

    constructor(options: E2BBackendOptions) {
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
        const commandLine = command.map(quotePosixShellArgument).join(' ');
        try {
            const result = await this.sandbox.run(commandLine, {
                cwd: options.cwd ?? this.workdir,
                timeoutSeconds: options.timeout,
                signal: options.signal,
            });
            return new ExecResult({
                exitCode: result.exitCode ?? 0,
                stdout: Buffer.from(result.stdout ?? '', 'utf8'),
                stderr: Buffer.from(result.stderr ?? '', 'utf8'),
            });
        } catch (error) {
            const commandError = commandExit(error);
            if (commandError) {
                return new ExecResult({
                    exitCode: commandError.exitCode || 1,
                    stdout: Buffer.from(commandError.stdout ?? '', 'utf8'),
                    stderr: Buffer.from(commandError.stderr ?? '', 'utf8'),
                });
            }
            return new ExecResult({ exitCode: -1, stderr: Buffer.from(String(error), 'utf8') });
        }
    }

    async readFile(filePath: string): Promise<Buffer> {
        try {
            return Buffer.from(await this.sandbox.readFile(filePath));
        } catch (error) {
            if (isFileNotFound(error)) {
                throw new Error(`not found in sandbox: ${filePath}`, { cause: error });
            }
            throw error;
        }
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.posix.dirname(filePath);
        if (parent !== '.') await this.execShell(['mkdir', '-p', parent]);
        await this.sandbox.writeFile(filePath, data);
    }
}

export interface E2BWorkspaceOptions extends WorkspaceBaseOptions {
    template?: string;
    apiKey?: string;
    domain?: string;
    timeoutSeconds?: number;
    gatewayPort?: number;
    env?: Record<string, string>;
    sandboxMetadata?: Record<string, string>;
    extraPip?: string[];
    instructions?: string;
    client?: E2BClientDriver;
}

/** Persistent cloud workspace backed by a paused and resumed E2B sandbox. */
export class E2BWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = E2B_SANDBOX_WORKDIR;
    readonly template: string;
    readonly apiKey: string;
    readonly domain: string;
    readonly timeoutSeconds: number;
    readonly gatewayPort: number;
    readonly env: Record<string, string>;
    readonly sandboxMetadata: Record<string, string>;
    readonly extraPip: string[];
    readonly instructions: string;
    protected readonly gatewayHome = E2B_GATEWAY_HOME;
    protected bootstrapCommandTimeout = 600;
    protected readinessTimeoutSeconds = 30;
    protected client: E2BClientDriver | null;
    protected sandbox: E2BSandboxDriver | null = null;

    constructor(options: E2BWorkspaceOptions = {}) {
        super(options);
        this.template = options.template ?? DEFAULT_E2B_TEMPLATE;
        this.apiKey = options.apiKey ?? '';
        this.domain = options.domain ?? '';
        this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_E2B_TIMEOUT;
        this.gatewayPort = options.gatewayPort ?? DEFAULT_E2B_GATEWAY_PORT;
        this.env = { ...(options.env ?? {}) };
        this.sandboxMetadata = { ...(options.sandboxMetadata ?? {}) };
        this.extraPip = [...(options.extraPip ?? [])];
        this.instructions = formatWorkspaceInstructions(
            options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS,
            { backend: 'E2B-based', workdir: E2B_SANDBOX_WORKDIR }
        );
        this.client = options.client ?? null;
    }

    get sandboxId(): string | null {
        return this.sandbox?.sandboxId ?? null;
    }

    async getInstructions(): Promise<string> {
        return this.instructions.replaceAll('{workdir}', E2B_SANDBOX_WORKDIR);
    }

    protected async provisionBackend(): Promise<void> {
        const client = this.client ?? (await createE2BClient());
        this.client = client;
        const existing = await this.findExistingSandbox(client);
        const apiOptions = this.apiOptions();
        if (existing) {
            this.sandbox = await client.connect(existing.sandboxId, {
                timeoutSeconds: this.timeoutSeconds,
                ...apiOptions,
            });
        } else {
            this.sandbox = await client.create({
                template: this.template,
                timeoutSeconds: this.timeoutSeconds,
                metadata: {
                    [E2B_WORKSPACE_ID_METADATA_KEY]: this.workspaceId,
                    ...this.sandboxMetadata,
                },
                ...(Object.keys(this.env).length ? { env: this.env } : {}),
                ...apiOptions,
            });
        }
        await this.waitUntilRunning();
        this.backend = new E2BBackend({
            sandbox: this.sandbox,
            workdir: E2B_SANDBOX_WORKDIR,
        });
    }

    protected async teardownBackend(): Promise<void> {
        if (this.sandbox) {
            await this.sandbox
                .pause()
                .catch(error => logger.warning('E2BWorkspace: pause failed: %s', String(error)));
        }
        this.sandbox = null;
        this.backend = null;
    }

    protected bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quotePosixShellArgument)
            .join(' ');
        return [
            'sudo apt-get update -qq ' +
                '&& sudo apt-get install -y --no-install-recommends ripgrep ' +
                '&& sudo rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                '| sudo env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${this.gatewayVenv}`,
            `uv pip install --python ${this.gatewayPython} ${packages}`,
            `uv pip install --python ${this.gatewayPython} --no-deps 'agentscope'`,
        ];
    }

    protected async findExistingSandbox(client: E2BClientDriver): Promise<E2BSandboxInfo | null> {
        let candidates: E2BSandboxInfo[];
        try {
            const result = await client.list({
                metadata: { [E2B_WORKSPACE_ID_METADATA_KEY]: this.workspaceId },
                state: ['paused', 'running'],
                ...this.apiOptions(),
            });
            candidates = result.sandboxes;
            if (result.error) {
                logger.warning('E2BWorkspace: list sandboxes failed: %s', String(result.error));
            }
        } catch (error) {
            logger.warning('E2BWorkspace: list sandboxes failed: %s', String(error));
            return null;
        }
        if (!candidates.length) return null;
        if (candidates.length > 1) {
            logger.warning(
                'E2BWorkspace: %d sandboxes match workspace_id=%s; attaching to most recent',
                candidates.length,
                JSON.stringify(this.workspaceId)
            );
        }
        return candidates.sort(
            (left, right) => right.startedAt.getTime() - left.startedAt.getTime()
        )[0];
    }

    protected async waitUntilRunning(): Promise<void> {
        if (!this.sandbox) throw new Error('E2B sandbox was not provisioned.');
        const timeout = this.readinessTimeoutSeconds;
        const deadline = performance.now() + timeout * 1000;
        let delay = 100;
        while (performance.now() < deadline) {
            try {
                if (await this.sandbox.isRunning()) return;
            } catch (error) {
                logger.debug(
                    'E2BWorkspace: is_running probe error (will retry): %s',
                    String(error)
                );
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 1.5, 1000);
        }
        throw new Error(
            `E2B sandbox did not become ready within ${timeout}s ` +
                `(workspace_id=${JSON.stringify(this.workspaceId)})`
        );
    }

    private apiOptions(): E2BApiOptions {
        return {
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            ...(this.domain ? { domain: this.domain } : {}),
        };
    }
}

function quotePosixShellArgument(value: string): string {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandExit(
    error: unknown
): { exitCode: number; stdout?: string; stderr?: string } | null {
    if (!error || typeof error !== 'object') return null;
    const record = error as Record<string, unknown>;
    if (typeof record.exitCode !== 'number') return null;
    return {
        exitCode: record.exitCode,
        stdout: typeof record.stdout === 'string' ? record.stdout : undefined,
        stderr: typeof record.stderr === 'string' ? record.stderr : undefined,
    };
}

function isFileNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    return (
        record.name === 'FileNotFoundError' ||
        record.name === 'FileNotFoundException' ||
        record.status === 404 ||
        record.statusCode === 404
    );
}
