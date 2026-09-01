import * as fs from 'node:fs/promises';

import { ExecResult } from '../tool';
import {
    APPLE_CONTAINER_GATEWAY_HOME,
    AppleContainerBackend,
    AppleContainerWorkspace,
    type AppleContainerWorkspaceOptions,
} from './apple-container';
import type { ProcessRunner, ProcessRunOptions, ProcessRunResult } from './process-runner';

/* eslint-disable jsdoc/require-jsdoc */

describe('AppleContainerBackend Python parity', () => {
    test('constructs container exec argv without a separator and honors cwd', async () => {
        const runner = new FakeRunner();
        runner.results.push(result(4, 'out', 'err'));
        const backend = new AppleContainerBackend({
            containerId: 'test-container',
            workdir: '/workspace',
            runner,
        });

        await expect(backend.getCwd()).resolves.toBe('/workspace');
        await expect(
            backend.execShell(['sh', '-c', 'echo one && echo two'], { cwd: '/tmp' })
        ).resolves.toEqual(
            new ExecResult({
                exitCode: 4,
                stdout: Buffer.from('out'),
                stderr: Buffer.from('err'),
            })
        );
        expect(runner.calls).toEqual([
            {
                command: [
                    'container',
                    'exec',
                    '--workdir',
                    '/tmp',
                    'test-container',
                    'sh',
                    '-c',
                    'echo one && echo two',
                ],
                options: { timeout: undefined, signal: undefined },
            },
        ]);
        expect(runner.calls[0].command).not.toContain('--');
    });

    test('maps a missing CLI and generic runner failures to ExecResult sentinels', async () => {
        const runner = new FakeRunner();
        runner.errors.push(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
            new Error('bad')
        );
        const backend = new AppleContainerBackend({
            containerId: 'container',
            workdir: '/workspace',
            runner,
        });

        const missing = await backend.execShell(['true']);
        expect(missing.exitCode).toBe(127);
        expect(missing.stderr.toString('utf8')).toContain('container CLI not found');
        await expect(backend.execShell(['true'])).resolves.toEqual(
            expect.objectContaining({ exitCode: -1 })
        );
    });

    test('reads with cat and rejects a nonzero result as missing', async () => {
        const runner = new FakeRunner();
        runner.results.push(result(0, 'hello'), result(1, '', 'No such file'));
        const backend = new AppleContainerBackend({
            containerId: 'container',
            workdir: '/workspace',
            runner,
        });

        await expect(backend.readFile('/workspace/file')).resolves.toEqual(Buffer.from('hello'));
        await expect(backend.readFile('/workspace/missing')).rejects.toThrow(
            'not found in container'
        );
    });

    test('copies exact bytes through a temporary host file and always cleans it', async () => {
        const runner = new FakeRunner();
        let copiedPath = '';
        let copiedData = Buffer.alloc(0);
        runner.handler = async command => {
            if (command[1] === 'cp') {
                copiedPath = command[2];
                copiedData = await fs.readFile(copiedPath);
            }
            return result(0);
        };
        const backend = new AppleContainerBackend({
            containerId: 'container',
            workdir: '/workspace',
            runner,
        });
        const payload = Buffer.from([0, 1, 2, 255]);

        await backend.writeFile('/workspace/a/file.bin', payload);

        expect(copiedData).toEqual(payload);
        expect(runner.calls.map(call => call.command)).toEqual([
            [
                'container',
                'exec',
                '--workdir',
                '/workspace',
                'container',
                'mkdir',
                '-p',
                '/workspace/a',
            ],
            ['container', 'cp', copiedPath, 'container:/workspace/a/file.bin'],
        ]);
        await expect(fs.stat(copiedPath)).rejects.toThrow();
    });

    test('surfaces copy failures and removes the temporary file', async () => {
        const runner = new FakeRunner();
        let copiedPath = '';
        runner.handler = async command => {
            if (command[1] === 'cp') {
                copiedPath = command[2];
                return result(1, '', 'cp failed');
            }
            return result(0);
        };
        const backend = new AppleContainerBackend({
            containerId: 'container',
            workdir: '/workspace',
            runner,
        });

        await expect(backend.writeFile('/workspace/file', Buffer.from('x'))).rejects.toThrow(
            'container cp failed (exit 1): cp failed'
        );
        await expect(fs.stat(copiedPath)).rejects.toThrow();
    });
});

describe('AppleContainerWorkspace Python parity', () => {
    test('exposes defaults, custom configuration, and rendered instructions', async () => {
        const workspace = new TestAppleWorkspace({
            workspaceId: 'my-ws',
            baseImage: 'ubuntu:latest',
            gatewayPort: 9999,
            cpus: 4,
            memory: '8G',
            env: { FOO: 'bar' },
            extraPip: ['requests'],
            instructions: 'at {workdir}',
            runner: new FakeRunner(),
        });

        expect({
            workdir: workspace.workdir,
            image: workspace.baseImage,
            gatewayPort: workspace.gatewayPort,
            cpus: workspace.cpus,
            memory: workspace.memory,
            env: workspace.env,
            pip: workspace.extraPip,
            name: workspace.containerName,
            alive: workspace.isAlive,
        }).toEqual({
            workdir: '/workspace',
            image: 'ubuntu:latest',
            gatewayPort: 9999,
            cpus: 4,
            memory: '8G',
            env: { FOO: 'bar' },
            pip: ['requests'],
            name: 'as_ws_my-ws',
            alive: false,
        });
        expect(await workspace.getInstructions()).toBe('at /workspace');
    });

    test('normalizes default registry and namespace only', () => {
        expect(AppleContainerWorkspace.normalizeImageReference('python:3.11-slim')).toBe(
            'python:3.11-slim'
        );
        expect(
            AppleContainerWorkspace.normalizeImageReference('docker.io/library/python:3.11-slim')
        ).toBe('python:3.11-slim');
        expect(AppleContainerWorkspace.normalizeImageReference('docker.io/bitnami/redis:7')).toBe(
            'bitnami/redis:7'
        );
        expect(
            AppleContainerWorkspace.normalizeImageReference('quay.io/project/image:latest')
        ).toBe('quay.io/project/image:latest');
    });

    test('creates a new container when a normalized image is already local', async () => {
        const runner = new FakeRunner();
        runner.results.push(
            result(0, '{"version":"1"}'),
            result(0, '[{"name":"docker.io/library/python:3.11-slim"}]'),
            result(0, '[]'),
            result(0, 'container-id')
        );
        const workspace = new TestAppleWorkspace({
            workspaceId: 'new',
            env: { KEY: 'value' },
            runner,
        });

        await workspace.initialize();
        await workspace.initialize();

        expect(workspace.isAlive).toBe(true);
        expect(workspace.getBackend()).toBeInstanceOf(AppleContainerBackend);
        expect(runner.calls.map(call => call.command)).toEqual([
            ['container', 'system', 'version', '--format', 'json'],
            ['container', 'image', 'list', '--format', 'json'],
            ['container', 'list', '--all', '--format', 'json'],
            [
                'container',
                'run',
                '-d',
                '--name',
                'as_ws_new',
                '--cpus',
                '2',
                '--memory',
                '2G',
                '--env',
                'KEY=value',
                'python:3.11-slim',
                'sleep',
                'infinity',
            ],
        ]);
    });

    test('pulls absent images then reattaches and starts a stopped container', async () => {
        const runner = new FakeRunner();
        runner.results.push(
            result(0),
            result(0, 'not-json'),
            result(0),
            result(0, '[{"name":"as_ws_existing","id":"id-1"}]'),
            result(0, '[{"status":"stopped"}]'),
            result(0)
        );
        const workspace = new TestAppleWorkspace({ workspaceId: 'existing', runner });

        await workspace.initialize();

        expect(runner.calls.map(call => call.command)).toEqual([
            ['container', 'system', 'version', '--format', 'json'],
            ['container', 'image', 'list', '--format', 'json'],
            ['container', 'image', 'pull', 'python:3.11-slim'],
            ['container', 'list', '--all', '--format', 'json'],
            ['container', 'inspect', 'as_ws_existing'],
            ['container', 'start', 'as_ws_existing'],
        ]);
    });

    test('does not start an existing container already reported as running', async () => {
        const runner = new FakeRunner();
        runner.results.push(
            result(0),
            result(0, '[{"name":"python:3.11-slim"}]'),
            result(0, '[{"name":"as_ws_running","id":"id"}]'),
            result(0, '{"status":"running"}')
        );
        const workspace = new TestAppleWorkspace({ workspaceId: 'running', runner });

        await workspace.initialize();

        expect(runner.calls.some(call => call.command[1] === 'start')).toBe(false);
        expect(runner.calls.some(call => call.command[1] === 'run')).toBe(false);
    });

    test('returns actionable CLI errors and exact bootstrap commands', async () => {
        const missing = new FakeRunner();
        missing.errors.push(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        const missingWorkspace = new TestAppleWorkspace({ runner: missing });
        await expect(missingWorkspace.check()).rejects.toThrow('not installed');

        const stopped = new FakeRunner();
        stopped.results.push(result(1, '', 'service down'));
        const stoppedWorkspace = new TestAppleWorkspace({ runner: stopped });
        await expect(stoppedWorkspace.check()).rejects.toThrow('container system start');

        const commandWorkspace = new TestAppleWorkspace({
            extraPip: ['numpy==2.0.0'],
            runner: new FakeRunner(),
        });
        commandWorkspace.bindForCommands();
        const commands = commandWorkspace.commands();
        expect(commands).toEqual([
            'apt-get update -qq && apt-get install -y --no-install-recommends curl ripgrep && rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${APPLE_CONTAINER_GATEWAY_HOME}/.venv`,
            `uv pip install --python ${APPLE_CONTAINER_GATEWAY_HOME}/.venv/bin/python 'mcp<2.0.0' uvicorn fastapi httpx numpy==2.0.0`,
            `uv pip install --python ${APPLE_CONTAINER_GATEWAY_HOME}/.venv/bin/python --no-deps 'agentscope'`,
        ]);
    });

    test('stops and removes the container during idempotent close', async () => {
        const runner = new FakeRunner();
        runner.results.push(
            result(0),
            result(0, '[{"name":"python:3.11-slim"}]'),
            result(0, '[]'),
            result(0),
            result(0),
            result(0)
        );
        const workspace = new TestAppleWorkspace({ workspaceId: 'close', runner });
        await workspace.initialize();

        await workspace.close();
        await workspace.close();

        expect(runner.calls.slice(-2).map(call => call.command)).toEqual([
            ['container', 'stop', 'as_ws_close'],
            ['container', 'rm', '-f', 'as_ws_close'],
        ]);
        expect(workspace.isAlive).toBe(false);
    });
});

class TestAppleWorkspace extends AppleContainerWorkspace {
    constructor(options: AppleContainerWorkspaceOptions) {
        super(options);
    }

    commands(): string[] {
        return this.bootstrapCommands();
    }

    bindForCommands(): void {
        this.backend = new AppleContainerBackend({
            containerId: this.containerName,
            workdir: this.workdir,
            runner: this.runner,
        });
    }

    async check(): Promise<void> {
        await this.checkCli();
    }

    protected override async restoreMcpSpecs(): Promise<void> {}
    protected override async ensureWorkspaceLayout(): Promise<void> {}
    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeRunner implements ProcessRunner {
    readonly calls: Array<{ command: string[]; options: ProcessRunOptions }> = [];
    readonly results: ProcessRunResult[] = [];
    readonly errors: Error[] = [];
    handler: ((command: string[], options: ProcessRunOptions) => Promise<ProcessRunResult>) | null =
        null;

    async run(command: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
        this.calls.push({ command, options });
        const error = this.errors.shift();
        if (error) throw error;
        if (this.handler) return this.handler(command, options);
        return this.results.shift() ?? result(0);
    }
}

function result(exitCode: number, stdout = '', stderr = ''): ProcessRunResult {
    return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}
