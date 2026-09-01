/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import { LocalProcessRunner, type ProcessRunner, type ProcessRunResult } from './process-runner';
import { SandboxedWorkspaceBase } from './sandboxed';

export const DEFAULT_APPLE_CONTAINER_BASE_IMAGE = 'python:3.11-slim';
export const DEFAULT_APPLE_CONTAINER_GATEWAY_PORT = 5600;
export const DEFAULT_APPLE_CONTAINER_CPUS = 2;
export const DEFAULT_APPLE_CONTAINER_MEMORY = '2G';
export const APPLE_CONTAINER_WORKDIR = '/workspace';
export const APPLE_CONTAINER_GATEWAY_HOME = '/root/.agentscope';

const DEFAULT_APPLE_CONTAINER_INSTRUCTIONS = `<workspace>
You have an Apple-Container-based workspace. All tool calls execute
**inside the container** at \`\`{workdir}\`\`.

Layout:

\`\`\`
{workdir}
├── data/        # offloaded multimodal files
├── skills/      # reusable skills
└── sessions/    # session context and tool results
\`\`\`
</workspace>`;

export interface AppleContainerBackendOptions {
    containerId: string;
    workdir: string;
    runner?: ProcessRunner;
}

/** Backend that delegates directly to Apple's `container` CLI. */
export class AppleContainerBackend extends BackendBase {
    readonly containerId: string;
    readonly workdir: string;
    readonly runner: ProcessRunner;

    constructor(options: AppleContainerBackendOptions) {
        super();
        this.containerId = options.containerId;
        this.workdir = options.workdir;
        this.runner = options.runner ?? new LocalProcessRunner();
    }

    override async getCwd(): Promise<string> {
        return this.workdir;
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        const argv = [
            'container',
            'exec',
            '--workdir',
            options.cwd ?? this.workdir,
            this.containerId,
            ...command,
        ];
        try {
            return toExecResult(
                await this.runner.run(argv, {
                    timeout: options.timeout,
                    signal: options.signal,
                })
            );
        } catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return new ExecResult({
                    exitCode: 127,
                    stderr: Buffer.from('container CLI not found - is Apple Container installed?'),
                });
            }
            return new ExecResult({ exitCode: -1, stderr: Buffer.from(String(error)) });
        }
    }

    async readFile(filePath: string): Promise<Buffer> {
        const result = await this.execShell(['cat', filePath]);
        if (!result.ok()) {
            throw new Error(
                `not found in container: ${filePath}\nstderr: ${result.stderr.toString('utf8')}`
            );
        }
        return result.stdout;
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'as_ws_'));
        const temporaryFile = path.join(temporaryDirectory, 'payload.bin');
        try {
            await fs.writeFile(temporaryFile, data);
            const parent = path.posix.dirname(filePath);
            if (parent && parent !== '/') await this.execShell(['mkdir', '-p', parent]);
            const result = await this.runner.run([
                'container',
                'cp',
                temporaryFile,
                `${this.containerId}:${filePath}`,
            ]);
            if (result.exitCode !== 0) {
                throw new Error(
                    `container cp failed (exit ${result.exitCode}): ` +
                        result.stderr.toString('utf8')
                );
            }
        } finally {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
}

export interface AppleContainerWorkspaceOptions extends WorkspaceBaseOptions {
    baseImage?: string;
    gatewayPort?: number;
    cpus?: number;
    memory?: string;
    env?: Record<string, string>;
    extraPip?: string[];
    instructions?: string;
    runner?: ProcessRunner;
}

/** Ephemeral Apple-Container workspace driven by the system CLI. */
export class AppleContainerWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = APPLE_CONTAINER_WORKDIR;
    readonly baseImage: string;
    readonly gatewayPort: number;
    readonly cpus: number;
    readonly memory: string;
    readonly env: Record<string, string>;
    readonly extraPip: string[];
    readonly instructions: string;
    readonly containerName: string;
    protected readonly gatewayHome = APPLE_CONTAINER_GATEWAY_HOME;
    protected bootstrapCommandTimeout = 600;
    protected readonly runner: ProcessRunner;

    constructor(options: AppleContainerWorkspaceOptions = {}) {
        super(options);
        this.baseImage = options.baseImage ?? DEFAULT_APPLE_CONTAINER_BASE_IMAGE;
        this.gatewayPort = options.gatewayPort ?? DEFAULT_APPLE_CONTAINER_GATEWAY_PORT;
        this.cpus = options.cpus ?? DEFAULT_APPLE_CONTAINER_CPUS;
        this.memory = options.memory ?? DEFAULT_APPLE_CONTAINER_MEMORY;
        this.env = { ...(options.env ?? {}) };
        this.extraPip = [...(options.extraPip ?? [])];
        this.instructions = options.instructions ?? DEFAULT_APPLE_CONTAINER_INSTRUCTIONS;
        this.containerName = `as_ws_${this.workspaceId}`;
        this.runner = options.runner ?? new LocalProcessRunner();
    }

    async getInstructions(): Promise<string> {
        return this.instructions.replaceAll('{workdir}', APPLE_CONTAINER_WORKDIR);
    }

    static normalizeImageReference(reference: string): string {
        const parts = reference.split('/');
        if (parts.length >= 2 && parts[0] === 'docker.io') parts.shift();
        if (parts.length >= 2 && parts[0] === 'library') parts.shift();
        return parts.join('/');
    }

    protected async provisionBackend(): Promise<void> {
        await this.checkCli();
        await this.pullImageIfNeeded();
        const existing = await this.findExistingContainer();
        if (existing) await this.startContainerIfStopped();
        else await this.createAndStartContainer();
        this.backend = new AppleContainerBackend({
            containerId: this.containerName,
            workdir: APPLE_CONTAINER_WORKDIR,
            runner: this.runner,
        });
    }

    protected async teardownBackend(): Promise<void> {
        if (!this.backend) return;
        await this.runner
            .run(['container', 'stop', this.containerName])
            .catch(error =>
                logger.warning('AppleContainerWorkspace: stop failed: %s', String(error))
            );
        await this.runner
            .run(['container', 'rm', '-f', this.containerName])
            .catch(error =>
                logger.warning('AppleContainerWorkspace: rm failed: %s', String(error))
            );
        this.backend = null;
    }

    protected bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quoteShell)
            .join(' ');
        return [
            'apt-get update -qq && apt-get install -y --no-install-recommends curl ripgrep ' +
                '&& rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh | ' +
                'env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${this.gatewayVenv}`,
            `uv pip install --python ${this.gatewayPython} ${packages}`,
            `uv pip install --python ${this.gatewayPython} --no-deps 'agentscope'`,
        ];
    }

    protected async checkCli(): Promise<void> {
        let result: ProcessRunResult;
        try {
            result = await this.runner.run(['container', 'system', 'version', '--format', 'json']);
        } catch (error) {
            if (errorCode(error) === 'ENOENT') {
                throw new Error(
                    'Apple Container CLI is not installed. Install it first: ' +
                        'https://github.com/apple/container'
                );
            }
            throw error;
        }
        if (result.exitCode !== 0) {
            throw new Error(
                'Apple Container CLI is not available. Ensure it is installed and running: ' +
                    `\`container system start\`.\nstderr: ${result.stderr.toString('utf8')}`
            );
        }
    }

    protected async pullImageIfNeeded(): Promise<void> {
        const target = AppleContainerWorkspace.normalizeImageReference(this.baseImage);
        const listed = await this.runner.run(['container', 'image', 'list', '--format', 'json']);
        if (listed.exitCode === 0) {
            const images = parseJsonArray(listed.stdout);
            if (
                images.some(
                    image =>
                        typeof image.name === 'string' &&
                        AppleContainerWorkspace.normalizeImageReference(image.name) === target
                )
            ) {
                return;
            }
        }
        const pulled = await this.runner.run(['container', 'image', 'pull', this.baseImage]);
        if (pulled.exitCode !== 0) {
            throw new Error(
                `Failed to pull image ${JSON.stringify(this.baseImage)}: ` +
                    pulled.stderr.toString('utf8')
            );
        }
    }

    protected async findExistingContainer(): Promise<string | null> {
        const result = await this.runner.run(['container', 'list', '--all', '--format', 'json']);
        if (result.exitCode !== 0) return null;
        const match = parseJsonArray(result.stdout).find(
            value => value.name === this.containerName
        );
        return typeof match?.id === 'string' ? match.id : null;
    }

    protected async startContainerIfStopped(): Promise<void> {
        const inspected = await this.runner.run(['container', 'inspect', this.containerName]);
        if (inspected.exitCode === 0) {
            const raw = parseJson(inspected.stdout);
            const info = Array.isArray(raw) ? raw[0] : raw;
            if (
                info &&
                typeof info === 'object' &&
                (info as Record<string, unknown>).status === 'running'
            ) {
                return;
            }
        }
        const started = await this.runner.run(['container', 'start', this.containerName]);
        if (started.exitCode !== 0) {
            throw new Error(
                `Failed to start container ${JSON.stringify(this.containerName)}: ` +
                    started.stderr.toString('utf8')
            );
        }
    }

    protected async createAndStartContainer(): Promise<void> {
        const command = [
            'container',
            'run',
            '-d',
            '--name',
            this.containerName,
            '--cpus',
            String(this.cpus),
            '--memory',
            this.memory,
        ];
        for (const [key, value] of Object.entries(this.env)) {
            command.push('--env', `${key}=${value}`);
        }
        command.push(this.baseImage, 'sleep', 'infinity');
        const result = await this.runner.run(command);
        if (result.exitCode !== 0) {
            throw new Error(
                `Failed to create container ${JSON.stringify(this.containerName)}: ` +
                    `stderr: ${result.stderr.toString('utf8')}\n` +
                    `stdout: ${result.stdout.toString('utf8')}`
            );
        }
    }
}

function toExecResult(result: ProcessRunResult): ExecResult {
    return new ExecResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
    });
}

function parseJson(buffer: Buffer): unknown {
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch {
        return null;
    }
}

function parseJsonArray(buffer: Buffer): Array<Record<string, unknown>> {
    const value = parseJson(buffer);
    if (!Array.isArray(value)) return [];
    return value.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
    );
}

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
}

function quoteShell(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
