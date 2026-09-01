/* eslint-disable jsdoc/require-jsdoc */

import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

export interface DockerExecOutput {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}

export interface DockerContainerConfig {
    name: string;
    image: string;
    command: string[];
    workingDirectory: string;
    labels: Record<string, string>;
    environment?: string[];
    binds?: string[];
}

export interface DockerBuildMessage {
    stream?: string;
    error?: string;
}

export interface DockerContainerDriver {
    exec(command: string[], cwd: string): Promise<DockerExecOutput>;
    getArchive(filePath: string): Promise<Buffer>;
    putArchive(directory: string, archive: Uint8Array): Promise<void>;
    start(): Promise<void>;
    kill(): Promise<void>;
    remove(options?: { force?: boolean }): Promise<void>;
}

export interface DockerClientDriver {
    inspectImage(tag: string): Promise<void>;
    buildImage(archive: Uint8Array, tag: string): AsyncIterable<DockerBuildMessage>;
    createOrReplaceContainer(config: DockerContainerConfig): Promise<DockerContainerDriver>;
    close(): Promise<void>;
}

interface DockerodeExecLike {
    start(options: Record<string, unknown>): Promise<NodeJS.ReadableStream>;
    inspect(): Promise<{ ExitCode?: number | null }>;
}

interface DockerodeContainerLike {
    exec(options: Record<string, unknown>): Promise<DockerodeExecLike>;
    getArchive(options: { path: string }): Promise<NodeJS.ReadableStream>;
    putArchive(archive: Uint8Array, options: { path: string }): Promise<void>;
    start(): Promise<void>;
    kill(): Promise<void>;
    remove(options?: { force?: boolean }): Promise<void>;
}

interface DockerodeLike {
    modem: {
        demuxStream(
            stream: NodeJS.ReadableStream,
            stdout: NodeJS.WritableStream,
            stderr: NodeJS.WritableStream
        ): void;
    };
    getImage(tag: string): { inspect(): Promise<unknown> };
    getContainer(name: string): DockerodeContainerLike;
    buildImage(
        archive: NodeJS.ReadableStream,
        options: Record<string, unknown>
    ): Promise<NodeJS.ReadableStream>;
    createContainer(options: Record<string, unknown>): Promise<DockerodeContainerLike>;
    close(): Promise<void>;
}

type DockerodeConstructor = new () => DockerodeLike;

export async function createDockerClient(): Promise<DockerClientDriver> {
    const moduleName = 'dockerode';
    let imported: { default?: DockerodeConstructor } & Partial<DockerodeConstructor>;
    try {
        imported = (await import(moduleName)) as {
            default?: DockerodeConstructor;
        } & Partial<DockerodeConstructor>;
    } catch (error) {
        throw new Error(
            `DockerWorkspace requires the optional "dockerode" dependency: ${String(error)}`
        );
    }
    const Constructor = imported.default ?? (imported as unknown as DockerodeConstructor);
    return new DockerodeClient(new Constructor());
}

class DockerodeClient implements DockerClientDriver {
    constructor(private readonly docker: DockerodeLike) {}

    async inspectImage(tag: string): Promise<void> {
        await this.docker.getImage(tag).inspect();
    }

    async *buildImage(archive: Uint8Array, tag: string): AsyncGenerator<DockerBuildMessage> {
        const stream = await this.docker.buildImage(Readable.from(Buffer.from(archive)), {
            t: tag,
            rm: true,
        });
        let pending = '';
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
            pending += Buffer.from(chunk).toString('utf8');
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                yield parseBuildMessage(line);
            }
        }
        if (pending.trim()) yield parseBuildMessage(pending);
    }

    async createOrReplaceContainer(config: DockerContainerConfig): Promise<DockerContainerDriver> {
        const raw = {
            name: config.name,
            Image: config.image,
            Cmd: config.command,
            WorkingDir: config.workingDirectory,
            Labels: config.labels,
            Env: config.environment,
            HostConfig: { Binds: config.binds ?? [] },
        };
        let container: DockerodeContainerLike;
        try {
            container = await this.docker.createContainer(raw);
        } catch (error) {
            if (!isConflict(error)) throw error;
            await this.docker.getContainer(config.name).remove({ force: true });
            container = await this.docker.createContainer(raw);
        }
        return new DockerodeContainer(this.docker, container);
    }

    async close(): Promise<void> {
        await this.docker.close();
    }
}

class DockerodeContainer implements DockerContainerDriver {
    constructor(
        private readonly docker: DockerodeLike,
        private readonly container: DockerodeContainerLike
    ) {}

    async exec(command: string[], cwd: string): Promise<DockerExecOutput> {
        const execution = await this.container.exec({
            Cmd: command,
            WorkingDir: cwd,
            AttachStdout: true,
            AttachStderr: true,
        });
        const stream = await execution.start({ hijack: true, stdin: false });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const stdoutSink = bufferSink(stdout);
        const stderrSink = bufferSink(stderr);
        this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);
        await finished(stream as NodeJS.ReadableStream & NodeJS.EventEmitter);
        const inspected = await execution.inspect();
        return {
            exitCode: inspected.ExitCode ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
        };
    }

    async getArchive(filePath: string): Promise<Buffer> {
        const stream = await this.container.getArchive({ path: filePath });
        return collectReadable(stream);
    }

    async putArchive(directory: string, archive: Uint8Array): Promise<void> {
        await this.container.putArchive(archive, { path: directory });
    }

    async start(): Promise<void> {
        await this.container.start();
    }

    async kill(): Promise<void> {
        await this.container.kill();
    }

    async remove(options: { force?: boolean } = {}): Promise<void> {
        await this.container.remove(options);
    }
}

function bufferSink(chunks: Buffer[]): Writable {
    return new Writable({
        write(chunk: Uint8Array, _encoding, callback): void {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
}

async function collectReadable(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function parseBuildMessage(line: string): DockerBuildMessage {
    try {
        const value = JSON.parse(line) as DockerBuildMessage;
        return value && typeof value === 'object' ? value : { stream: line };
    } catch {
        return { stream: line };
    }
}

function isConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    return record.statusCode === 409 || record.status === 409;
}
