import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ExecResult } from '../tool';
import { DockerBackend, DockerWorkspace, type DockerWorkspaceOptions } from './docker';
import {
    DEFAULT_DOCKER_BASE_IMAGE,
    DOCKER_CONTAINER_WORKDIR,
    DOCKER_GATEWAY_HOME,
    computeDockerImageTag,
    prepareDockerBuildContext,
    renderDockerfile,
} from './docker-build';
import type {
    DockerBuildMessage,
    DockerClientDriver,
    DockerContainerConfig,
    DockerContainerDriver,
    DockerExecOutput,
} from './docker-driver';
import { readFirstFileFromTar } from './tar-buffer';

/* eslint-disable jsdoc/require-jsdoc */

describe('Docker build context Python parity', () => {
    test('renders optional Node stage and all gateway runtime layers', () => {
        const plain = renderDockerfile({ installAgentscopeBlock: 'RUN install-agentscope' });
        const node = renderDockerfile({
            baseImage: 'python:3.12-slim',
            nodeVersion: '20',
            installAgentscopeBlock: 'RUN install-agentscope',
        });

        expect(plain).toContain(`FROM ${DEFAULT_DOCKER_BASE_IMAGE}`);
        expect(plain).not.toContain('AS node_stage');
        expect(node).toContain('FROM node:20-slim AS node_stage');
        expect(node).toContain('FROM python:3.12-slim');
        expect(node).toContain('COPY --from=node_stage /usr/local/bin/node');
        expect(node).toContain(`UV_PROJECT_ENVIRONMENT=${DOCKER_GATEWAY_HOME}/.venv`);
        expect(node).toContain('COPY _mcp_gateway_app.py');
        expect(node).toContain('COPY _glob_helper.py');
        expect(node.trimEnd().endsWith(`WORKDIR ${DOCKER_CONTAINER_WORKDIR}`)).toBe(true);
    });

    test('hashes Dockerfile and sorted COPY payloads into a deterministic tag', () => {
        const first = computeDockerImageTag('FROM scratch\n', {
            'b.txt': Buffer.from('b'),
            'a.txt': Buffer.from('a'),
        });
        const reordered = computeDockerImageTag('FROM scratch\n', {
            'a.txt': Buffer.from('a'),
            'b.txt': Buffer.from('b'),
        });
        const changed = computeDockerImageTag('FROM scratch\n', {
            'a.txt': Buffer.from('changed'),
            'b.txt': Buffer.from('b'),
        });

        expect(first).toMatch(/^agentscope-workspace:[a-f0-9]{12}$/);
        expect(reordered).toBe(first);
        expect(changed).not.toBe(first);
    });

    test('materializes every hashed file and includes extra gateway requirements', async () => {
        const context = await prepareDockerBuildContext({
            nodeVersion: '22',
            extraPip: ['numpy==2.0.0'],
        });
        try {
            expect(Object.keys(context.copyFiles).sort()).toEqual([
                '_glob_helper.py',
                '_mcp_gateway_app.py',
                'requirements.txt',
            ]);
            expect(context.copyFiles['requirements.txt'].toString('utf8')).toBe(
                'mcp<2.0.0\nuvicorn\nfastapi\nhttpx\nnumpy==2.0.0\n'
            );
            for (const [name, content] of Object.entries(context.copyFiles)) {
                expect(await fs.readFile(path.join(context.directory, name))).toEqual(content);
            }
            expect(await fs.readFile(path.join(context.directory, 'Dockerfile'), 'utf8')).toContain(
                'RUN uv pip install "agentscope"'
            );
        } finally {
            await fs.rm(context.directory, { recursive: true, force: true });
        }
    });
});

describe('DockerBackend Python parity', () => {
    test('executes argv directly with cwd and preserves output channels', async () => {
        const container = new FakeContainer();
        container.execResults.push({
            exitCode: 4,
            stdout: Buffer.from('out'),
            stderr: Buffer.from('err'),
        });
        const backend = new DockerBackend({ container, workdir: '/workspace' });

        await expect(backend.getCwd()).resolves.toBe('/workspace');
        await expect(backend.execShell(['echo', 'a b | ;'], { cwd: '/tmp' })).resolves.toEqual(
            new ExecResult({
                exitCode: 4,
                stdout: Buffer.from('out'),
                stderr: Buffer.from('err'),
            })
        );
        expect(container.execCalls).toEqual([[['echo', 'a b | ;'], '/tmp']]);
    });

    test('returns timeout and AbortSignal sentinels', async () => {
        const container = new FakeContainer();
        container.execDelay = 30;
        const backend = new DockerBackend({ container, workdir: '/workspace' });
        const controller = new AbortController();
        controller.abort();

        await expect(backend.execShell(['sleep'], { timeout: 0.001 })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') })
        );
        await expect(backend.execShell(['sleep'], { signal: controller.signal })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') })
        );
    });

    test('writes a tar member after creating parents and reads archive bytes back', async () => {
        const container = new FakeContainer();
        const backend = new DockerBackend({ container, workdir: '/workspace' });
        const payload = Buffer.from([0, 1, 2, 255]);

        await backend.writeFile('/workspace/a/b/file.bin', payload);
        container.archive = container.putCalls[0].archive;

        expect(container.execCalls).toEqual([[['mkdir', '-p', '/workspace/a/b'], '/workspace']]);
        expect(container.putCalls[0].directory).toBe('/workspace/a/b');
        expect(await readFirstFileFromTar(container.putCalls[0].archive)).toEqual(payload);
        await expect(backend.readFile('/workspace/a/b/file.bin')).resolves.toEqual(payload);
    });

    test('translates Docker 404 and empty archives into not-found errors', async () => {
        const container = new FakeContainer();
        const backend = new DockerBackend({ container, workdir: '/workspace' });
        container.getError = Object.assign(new Error('missing'), { statusCode: 404 });
        await expect(backend.readFile('/workspace/missing')).rejects.toThrow(
            'not found in container'
        );

        container.getError = null;
        container.archive = Buffer.alloc(1024);
        await expect(backend.readFile('/workspace/empty')).rejects.toThrow(
            'not found in container'
        );
    });
});

describe('DockerWorkspace Python parity', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-docker-test-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test('builds, starts, binds, labels, and tears down one persistent container', async () => {
        const client = new FakeDockerClient();
        const workspace = new TestDockerWorkspace({
            workspaceId: 'docker-1',
            hostWorkdir: path.join(root, 'workspace'),
            nodeVersion: '20',
            env: { API_KEY: 'value' },
            client,
        });

        await workspace.initialize();
        await workspace.initialize();

        expect(workspace.isAlive).toBe(true);
        expect(workspace.isPersistent).toBe(true);
        expect(workspace.getBackend()).toBeInstanceOf(DockerBackend);
        expect(client.inspectTags).toHaveLength(1);
        expect(client.buildTags).toEqual(client.inspectTags);
        expect(client.configs).toEqual([
            {
                name: 'as_ws_docker-1',
                image: expect.stringMatching(/^agentscope-workspace:[a-f0-9]{12}$/),
                command: ['sleep', 'infinity'],
                workingDirectory: '/workspace',
                labels: {
                    'agentscope.workspace': 'true',
                    'agentscope.workspace.id': 'docker-1',
                },
                environment: ['API_KEY=value'],
                binds: [`${path.join(root, 'workspace')}:/workspace:rw`],
            },
        ]);
        expect(client.container.starts).toBe(1);
        expect(await workspace.getInstructions()).toContain('Docker-based workspace at /workspace');

        await workspace.close();
        expect(workspace.isAlive).toBe(false);
        expect(client.container.kills).toBe(1);
        expect(client.container.removes).toEqual([{ force: true }]);
        expect(client.closes).toBe(1);
    });

    test('reuses an inspected image without sending a build context', async () => {
        const client = new FakeDockerClient();
        client.imageExists = true;
        const workspace = new TestDockerWorkspace({ client });

        await workspace.initialize();

        expect(workspace.isPersistent).toBe(false);
        expect(client.inspectTags).toHaveLength(1);
        expect(client.buildTags).toEqual([]);
        expect(client.configs[0].binds).toBeUndefined();
        await workspace.close();
    });

    test('reports build errors with recent daemon output and removes build context', async () => {
        const client = new FakeDockerClient();
        client.buildMessages = [{ stream: 'step detail\n' }, { error: 'command failed' }];
        const before = await buildContextDirectories();
        const workspace = new TestDockerWorkspace({ client });

        await expect(workspace.initialize()).rejects.toThrow(
            'docker build failed: command failed\n--- last 1 build log lines ---\nstep detail'
        );
        expect(await buildContextDirectories()).toEqual(before);
        await workspace.close();
    });

    test('supports the deprecated workdir alias without changing container paths', async () => {
        const client = new FakeDockerClient();
        const workspace = new TestDockerWorkspace({ workdir: root, client });

        expect(workspace.hostWorkdir).toBe(path.resolve(root));
        expect(workspace.workdir).toBe('/workspace');
        expect(workspace.gatewayPort).toBe(5600);
    });
});

class TestDockerWorkspace extends DockerWorkspace {
    constructor(options: DockerWorkspaceOptions) {
        super(options);
    }

    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeContainer implements DockerContainerDriver {
    readonly execCalls: Array<[[string, ...string[]], string]> = [];
    readonly execResults: DockerExecOutput[] = [];
    readonly putCalls: Array<{ directory: string; archive: Buffer }> = [];
    readonly removes: Array<{ force?: boolean }> = [];
    archive: Buffer | null = null;
    getError: Error | null = null;
    execDelay = 0;
    starts = 0;
    kills = 0;

    async exec(command: string[], cwd: string): Promise<DockerExecOutput> {
        this.execCalls.push([command as [string, ...string[]], cwd]);
        if (this.execDelay) await new Promise(resolve => setTimeout(resolve, this.execDelay));
        if (command[0] === 'test') {
            return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return (
            this.execResults.shift() ?? {
                exitCode: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
            }
        );
    }

    async getArchive(): Promise<Buffer> {
        if (this.getError) throw this.getError;
        if (!this.archive) {
            throw Object.assign(new Error('missing'), { statusCode: 404 });
        }
        return this.archive;
    }

    async putArchive(directory: string, archive: Uint8Array): Promise<void> {
        this.putCalls.push({ directory, archive: Buffer.from(archive) });
    }

    async start(): Promise<void> {
        this.starts += 1;
    }

    async kill(): Promise<void> {
        this.kills += 1;
    }

    async remove(options: { force?: boolean } = {}): Promise<void> {
        this.removes.push(options);
    }
}

class FakeDockerClient implements DockerClientDriver {
    readonly container = new FakeContainer();
    readonly inspectTags: string[] = [];
    readonly buildTags: string[] = [];
    readonly configs: DockerContainerConfig[] = [];
    buildMessages: DockerBuildMessage[] = [{ stream: 'built\n' }];
    imageExists = false;
    closes = 0;

    async inspectImage(tag: string): Promise<void> {
        this.inspectTags.push(tag);
        if (!this.imageExists) throw new Error('missing image');
    }

    async *buildImage(_archive: Uint8Array, tag: string): AsyncGenerator<DockerBuildMessage> {
        this.buildTags.push(tag);
        for (const message of this.buildMessages) yield message;
    }

    async createOrReplaceContainer(config: DockerContainerConfig): Promise<DockerContainerDriver> {
        this.configs.push(config);
        return this.container;
    }

    async close(): Promise<void> {
        this.closes += 1;
    }
}

async function buildContextDirectories(): Promise<string[]> {
    return (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('as-ws-build-')).sort();
}
