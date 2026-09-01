/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as tar from 'tar';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import {
    DEFAULT_DOCKER_BASE_IMAGE,
    DEFAULT_DOCKER_GATEWAY_PORT,
    DOCKER_CONTAINER_WORKDIR,
    DOCKER_GATEWAY_HOME,
    prepareDockerBuildContext,
} from './docker-build';
import {
    createDockerClient,
    type DockerClientDriver,
    type DockerContainerDriver,
} from './docker-driver';
import { SandboxedWorkspaceBase } from './sandboxed';
import { createSingleFileTar, readFirstFileFromTar } from './tar-buffer';
import { DEFAULT_WORKSPACE_INSTRUCTIONS, formatWorkspaceInstructions } from './utils';

export interface DockerBackendOptions {
    container: DockerContainerDriver;
    workdir: string;
}

/** Backend that delegates argv execution and archive I/O to a Docker container. */
export class DockerBackend extends BackendBase {
    readonly container: DockerContainerDriver;
    readonly workdir: string;

    constructor(options: DockerBackendOptions) {
        super();
        this.container = options.container;
        this.workdir = options.workdir;
    }

    override async getCwd(): Promise<string> {
        return this.workdir;
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        const operation = this.container.exec(command, options.cwd ?? this.workdir).then(
            result =>
                new ExecResult({
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
        );
        return raceExecution(operation, options.timeout, options.signal);
    }

    async readFile(filePath: string): Promise<Buffer> {
        let archive: Buffer;
        try {
            archive = await this.container.getArchive(filePath);
        } catch (error) {
            if (dockerStatus(error) === 404) {
                throw new Error(`not found in container: ${filePath}`);
            }
            throw error;
        }
        const content = await readFirstFileFromTar(archive);
        if (content === null) throw new Error(`not found in container: ${filePath}`);
        return content;
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.posix.dirname(filePath) || '/';
        const name = path.posix.basename(filePath);
        await this.execShell(['mkdir', '-p', parent]);
        await this.container.putArchive(parent, createSingleFileTar(name, data));
    }
}

export interface DockerWorkspaceOptions extends WorkspaceBaseOptions {
    baseImage?: string;
    hostWorkdir?: string | null;
    /** Deprecated alias for hostWorkdir. */
    workdir?: string | null;
    nodeVersion?: string | null;
    extraPip?: string[];
    gatewayPort?: number;
    env?: Record<string, string>;
    instructions?: string;
    client?: DockerClientDriver;
    clientFactory?: () => Promise<DockerClientDriver>;
}

/** Docker-backed workspace with content-addressed image reuse. */
export class DockerWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = DOCKER_CONTAINER_WORKDIR;
    readonly baseImage: string;
    readonly hostWorkdir: string | null;
    readonly nodeVersion: string | null;
    readonly extraPip: string[];
    readonly gatewayPort: number;
    readonly env: Record<string, string>;
    readonly instructions: string;
    protected readonly gatewayHome = DOCKER_GATEWAY_HOME;
    protected client: DockerClientDriver | null = null;
    protected container: DockerContainerDriver | null = null;
    protected imageTag = '';
    private readonly suppliedClient: DockerClientDriver | null;
    private readonly clientFactory: () => Promise<DockerClientDriver>;

    constructor(options: DockerWorkspaceOptions = {}) {
        super(options);
        if (options.workdir !== undefined) {
            logger.warning(
                "DockerWorkspace parameter 'workdir' is deprecated, use 'hostWorkdir' instead."
            );
        }
        const selectedWorkdir = options.hostWorkdir ?? options.workdir ?? null;
        if (selectedWorkdir !== null && !selectedWorkdir.trim()) {
            throw new Error('hostWorkdir must not be empty.');
        }
        this.baseImage = options.baseImage ?? DEFAULT_DOCKER_BASE_IMAGE;
        this.hostWorkdir = selectedWorkdir ? path.resolve(selectedWorkdir) : null;
        this.nodeVersion = options.nodeVersion ?? null;
        this.extraPip = [...(options.extraPip ?? [])];
        this.gatewayPort = options.gatewayPort ?? DEFAULT_DOCKER_GATEWAY_PORT;
        this.env = { ...(options.env ?? {}) };
        this.instructions = formatWorkspaceInstructions(
            options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS,
            { backend: 'Docker-based', workdir: this.workdir }
        );
        this.suppliedClient = options.client ?? null;
        this.clientFactory = options.clientFactory ?? createDockerClient;
    }

    override get isPersistent(): boolean {
        return this.hostWorkdir !== null;
    }

    async getInstructions(): Promise<string> {
        return this.instructions;
    }

    protected async provisionBackend(): Promise<void> {
        this.client = this.suppliedClient ?? (await this.clientFactory());
        await this.buildOrReuseImage();
        await this.createAndStartContainer();
    }

    protected async teardownBackend(): Promise<void> {
        const container = this.container;
        if (container) {
            if (
                this.hostWorkdir &&
                process.platform === 'linux' &&
                this.backend &&
                typeof process.getuid === 'function' &&
                typeof process.getgid === 'function'
            ) {
                await this.backend
                    .execShell(
                        [
                            'chown',
                            '-R',
                            `${process.getuid()}:${process.getgid()}`,
                            DOCKER_CONTAINER_WORKDIR,
                        ],
                        { timeout: 10 }
                    )
                    .catch(() => undefined);
            }
            await container.kill().catch(() => undefined);
            await container.remove({ force: true }).catch(() => undefined);
            this.container = null;
        }
        this.backend = null;
        if (this.client) await this.client.close().catch(() => undefined);
        this.client = null;
    }

    protected async buildOrReuseImage(): Promise<void> {
        if (!this.client) throw new Error('Docker client is not initialized.');
        const context = await prepareDockerBuildContext({
            baseImage: this.baseImage,
            gatewayHome: DOCKER_GATEWAY_HOME,
            containerWorkdir: DOCKER_CONTAINER_WORKDIR,
            nodeVersion: this.nodeVersion,
            extraPip: this.extraPip,
        });
        this.imageTag = context.tag;
        try {
            try {
                await this.client.inspectImage(context.tag);
                logger.info('DockerWorkspace: image cache hit %s', context.tag);
                return;
            } catch {}
            const archive = await createContextArchive(context.directory);
            const tail: string[] = [];
            for await (const message of this.client.buildImage(archive, context.tag)) {
                if (message.stream?.trim()) {
                    tail.push(message.stream.trimEnd());
                    if (tail.length > 200) tail.splice(0, tail.length - 200);
                }
                if (message.error) {
                    throw new Error(
                        `docker build failed: ${message.error}\n` +
                            `--- last ${tail.length} build log lines ---\n${tail.join('\n')}`
                    );
                }
            }
        } finally {
            await fs.rm(context.directory, { recursive: true, force: true });
        }
    }

    protected async createAndStartContainer(): Promise<void> {
        if (!this.client) throw new Error('Docker client is not initialized.');
        const binds: string[] = [];
        if (this.hostWorkdir) {
            await fs.mkdir(this.hostWorkdir, { recursive: true });
            binds.push(`${this.hostWorkdir}:${DOCKER_CONTAINER_WORKDIR}:rw`);
        }
        const config = {
            name: `as_ws_${this.workspaceId}`,
            image: this.imageTag,
            command: ['sleep', 'infinity'],
            workingDirectory: DOCKER_CONTAINER_WORKDIR,
            labels: {
                'agentscope.workspace': 'true',
                'agentscope.workspace.id': this.workspaceId,
            },
        };
        const environment = Object.entries(this.env).map(([key, value]) => `${key}=${value}`);
        this.container = await this.client.createOrReplaceContainer({
            ...config,
            ...(environment.length ? { environment } : {}),
            ...(binds.length ? { binds } : {}),
        });
        await this.container.start();
        this.backend = new DockerBackend({
            container: this.container,
            workdir: DOCKER_CONTAINER_WORKDIR,
        });
    }
}

async function raceExecution(
    operation: Promise<ExecResult>,
    timeoutSeconds?: number,
    signal?: AbortSignal
): Promise<ExecResult> {
    if (signal?.aborted) {
        return new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') });
    }
    const sentinels: Promise<ExecResult>[] = [operation];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    if (timeoutSeconds !== undefined) {
        sentinels.push(
            new Promise(resolve => {
                timeout = setTimeout(
                    () =>
                        resolve(
                            new ExecResult({
                                exitCode: -1,
                                stderr: Buffer.from('timed out'),
                            })
                        ),
                    timeoutSeconds * 1000
                );
            })
        );
    }
    if (signal) {
        sentinels.push(
            new Promise(resolve => {
                abort = () =>
                    resolve(new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') }));
                signal.addEventListener('abort', abort, { once: true });
            })
        );
    }
    try {
        return await Promise.race(sentinels);
    } finally {
        if (timeout) clearTimeout(timeout);
        if (abort) signal?.removeEventListener('abort', abort);
    }
}

async function createContextArchive(directory: string): Promise<Buffer> {
    const stream = tar.c({ cwd: directory, portable: true }, ['.']);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function dockerStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const value = error as Record<string, unknown>;
    const status = value.statusCode ?? value.status;
    return typeof status === 'number' ? status : null;
}
