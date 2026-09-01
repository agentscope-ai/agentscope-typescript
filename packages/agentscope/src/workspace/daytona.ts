/* eslint-disable jsdoc/require-jsdoc */

import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import {
    createDaytonaClient,
    type DaytonaClientDriver,
    type DaytonaClientOptions,
    type DaytonaSandboxDriver,
    type DaytonaSandboxState,
} from './daytona-driver';
import { SandboxedWorkspaceBase } from './sandboxed';
import { DEFAULT_WORKSPACE_INSTRUCTIONS, formatWorkspaceInstructions } from './utils';

export const DEFAULT_DAYTONA_TIMEOUT = 300;
export const DEFAULT_DAYTONA_GATEWAY_PORT = 5600;
export const DEFAULT_DAYTONA_SWEEP_INTERVAL = 300;
export const DAYTONA_WORKSPACE_ID_METADATA_KEY = 'agentscope.workspace.id';
export const DAYTONA_GATEWAY_HOME_NAME = '.agentscope';

const DAYTONA_CANDIDATE_STATES: DaytonaSandboxState[] = [
    'started',
    'stopped',
    'starting',
    'stopping',
    'error',
    'pausing',
    'paused',
    'resuming',
];

export interface DaytonaBackendOptions {
    sandbox: DaytonaSandboxDriver;
    workdir: string;
}

/** Backend that delegates commands and file operations to Daytona. */
export class DaytonaBackend extends BackendBase {
    readonly sandbox: DaytonaSandboxDriver;
    readonly workdir: string;

    constructor(options: DaytonaBackendOptions) {
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
        const commandLine = `${command.map(quotePosixShellArgument).join(' ')} 2>&1`;
        try {
            const response = await this.sandbox.executeCommand(
                commandLine,
                options.cwd ?? this.workdir,
                options.timeout === undefined ? undefined : Math.ceil(options.timeout)
            );
            return new ExecResult({
                exitCode: response.exitCode,
                stdout: Buffer.from(response.result, 'utf8'),
            });
        } catch (error) {
            return new ExecResult({ exitCode: -1, stderr: Buffer.from(String(error), 'utf8') });
        }
    }

    async readFile(filePath: string): Promise<Buffer> {
        try {
            return Buffer.from(await this.sandbox.downloadFile(filePath));
        } catch (error) {
            if (isNotFound(error)) {
                throw new Error(`not found in sandbox: ${filePath}`, { cause: error });
            }
            throw error;
        }
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.posix.dirname(filePath);
        if (parent !== '.') await this.execShell(['mkdir', '-p', parent]);
        await this.sandbox.uploadFile(data, filePath);
    }
}

export interface DaytonaWorkspaceOptions extends WorkspaceBaseOptions {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
    timeoutSeconds?: number;
    gatewayPort?: number;
    env?: Record<string, string>;
    sandboxMetadata?: Record<string, string>;
    extraPip?: string[];
    instructions?: string;
    osUser?: string | null;
    client?: DaytonaClientDriver;
}

/** Persistent sandbox workspace backed by Daytona. */
export class DaytonaWorkspace extends SandboxedWorkspaceBase {
    workdir = '';
    readonly apiKey: string;
    readonly apiUrl: string;
    readonly target: string;
    readonly timeoutSeconds: number;
    readonly gatewayPort: number;
    readonly env: Record<string, string>;
    readonly sandboxMetadata: Record<string, string>;
    readonly extraPip: string[];
    readonly instructions: string;
    readonly osUser: string | null;
    protected gatewayHome = '';
    protected userHome = '';
    protected uvBin = '';
    protected client: DaytonaClientDriver | null;
    protected sandbox: DaytonaSandboxDriver | null = null;

    constructor(options: DaytonaWorkspaceOptions = {}) {
        super(options);
        this.apiKey = options.apiKey ?? '';
        this.apiUrl = options.apiUrl ?? '';
        this.target = options.target ?? '';
        this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_DAYTONA_TIMEOUT;
        this.gatewayPort = options.gatewayPort ?? DEFAULT_DAYTONA_GATEWAY_PORT;
        this.env = { ...(options.env ?? {}) };
        this.sandboxMetadata = { ...(options.sandboxMetadata ?? {}) };
        this.extraPip = [...(options.extraPip ?? [])];
        this.instructions = options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS;
        this.osUser = options.osUser ?? null;
        this.client = options.client ?? null;
    }

    get sandboxId(): string | null {
        return this.sandbox?.id ?? null;
    }

    async getInstructions(): Promise<string> {
        return formatWorkspaceInstructions(this.instructions, {
            backend: 'Daytona-based',
            workdir: this.workdir || '<unknown>',
        });
    }

    protected async provisionBackend(): Promise<void> {
        const client = this.client ?? (await createDaytonaClient(this.clientOptions()));
        this.client = client;
        const existing = await this.findExistingSandbox(client);
        if (existing) {
            this.sandbox = existing;
            await this.ensureExistingSandboxReady(existing);
        } else {
            this.sandbox = await client.create({
                labels: {
                    [DAYTONA_WORKSPACE_ID_METADATA_KEY]: this.workspaceId,
                    ...this.sandboxMetadata,
                },
                public: false,
                ...(Object.keys(this.env).length ? { env: this.env } : {}),
                ...(this.osUser === null ? {} : { osUser: this.osUser }),
                timeoutSeconds: this.timeoutSeconds,
            });
        }
        await this.deriveSdkPaths(this.sandbox);
        this.backend = new DaytonaBackend({ sandbox: this.sandbox, workdir: this.workdir });
    }

    protected async teardownBackend(): Promise<void> {
        if (this.sandbox) {
            await this.sandbox
                .stop(this.timeoutSeconds, false)
                .catch(error => logger.warning('DaytonaWorkspace: stop failed: %s', String(error)));
        }
        this.sandbox = null;
        if (this.client) {
            await this.client
                .close()
                .catch(error =>
                    logger.warning('DaytonaWorkspace: client close failed: %s', String(error))
                );
        }
        this.client = null;
        this.backend = null;
    }

    protected bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quotePosixShellArgument)
            .join(' ');
        const uvInstallDirectory = path.posix.join(this.userHome, '.local', 'bin');
        return [
            'sudo apt-get update -qq ' +
                '&& sudo apt-get install -y --no-install-recommends ripgrep ' +
                '&& sudo rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                `| env UV_INSTALL_DIR=${quotePosixShellArgument(uvInstallDirectory)} ` +
                'INSTALLER_NO_MODIFY_PATH=1 sh',
            `${quotePosixShellArgument(this.uvBin)} venv ${quotePosixShellArgument(this.gatewayVenv)}`,
            `${quotePosixShellArgument(this.uvBin)} pip install --python ` +
                `${quotePosixShellArgument(this.gatewayPython)} ${packages}`,
            `${quotePosixShellArgument(this.uvBin)} pip install --python ` +
                `${quotePosixShellArgument(this.gatewayPython)} --no-deps 'agentscope'`,
        ];
    }

    protected async findExistingSandbox(
        client: DaytonaClientDriver
    ): Promise<DaytonaSandboxDriver | null> {
        let candidates: DaytonaSandboxDriver[];
        try {
            candidates = await client.list({
                labels: { [DAYTONA_WORKSPACE_ID_METADATA_KEY]: this.workspaceId },
                states: DAYTONA_CANDIDATE_STATES,
            });
        } catch (error) {
            logger.warning('DaytonaWorkspace: list sandboxes failed: %s', String(error));
            return null;
        }
        const usable = candidates.filter(candidate => isCandidateUsable(candidate));
        if (!usable.length) return null;
        if (usable.length > 1) {
            logger.warning(
                'DaytonaWorkspace: %d sandboxes match workspace_id=%s; attaching to most recent',
                usable.length,
                JSON.stringify(this.workspaceId)
            );
        }
        return usable.sort((left, right) =>
            candidateSortKey(right).localeCompare(candidateSortKey(left))
        )[0];
    }

    protected async ensureExistingSandboxReady(sandbox: DaytonaSandboxDriver): Promise<void> {
        const state = normalizeState(sandbox.state);
        if (state === 'error') await sandbox.recover(this.timeoutSeconds);
        else if (state === 'stopped' || state === 'paused') {
            await sandbox.start(this.timeoutSeconds);
        } else if (state === 'stopping' || state === 'pausing') {
            await sandbox.waitUntilStopped(this.timeoutSeconds);
            await sandbox.start(this.timeoutSeconds);
        } else if (state === 'starting' || state === 'resuming') {
            await sandbox.waitUntilStarted(this.timeoutSeconds);
        }
        await sandbox.refreshData();
    }

    protected async deriveSdkPaths(sandbox: DaytonaSandboxDriver): Promise<void> {
        this.workdir = await sandbox.getWorkDir();
        this.userHome = await sandbox.getUserHomeDir();
        this.gatewayHome = path.posix.join(this.userHome, DAYTONA_GATEWAY_HOME_NAME);
        this.uvBin = path.posix.join(this.userHome, '.local', 'bin', 'uv');
    }

    private clientOptions(): DaytonaClientOptions {
        return {
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            ...(this.apiUrl ? { apiUrl: this.apiUrl } : {}),
            ...(this.target ? { target: this.target } : {}),
        };
    }
}

function isCandidateUsable(sandbox: DaytonaSandboxDriver): boolean {
    const state = normalizeState(sandbox.state);
    if (state === 'error') return Boolean(sandbox.recoverable);
    return DAYTONA_CANDIDATE_STATES.includes(state) && state !== 'error';
}

function candidateSortKey(sandbox: DaytonaSandboxDriver): string {
    return sandbox.lastActivityAt ?? sandbox.updatedAt ?? sandbox.createdAt ?? sandbox.id;
}

function normalizeState(state: DaytonaSandboxState | null): string {
    return state === null ? '' : String(state).toLowerCase();
}

function quotePosixShellArgument(value: string): string {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNotFound(error: unknown): boolean {
    if (error instanceof Error && error.name === 'FileNotFoundError') return true;
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    return (
        record.name === 'DaytonaNotFoundError' || record.status === 404 || record.statusCode === 404
    );
}
