import { ExecResult } from '../tool';
import {
    E2BBackend,
    E2BWorkspace,
    type E2BWorkspaceOptions,
    E2B_GATEWAY_HOME,
    E2B_SANDBOX_WORKDIR,
    E2B_WORKSPACE_ID_METADATA_KEY,
} from './e2b';
import type {
    E2BClientDriver,
    E2BCommandOutput,
    E2BConnectOptions,
    E2BCreateOptions,
    E2BListOptions,
    E2BListResult,
    E2BRunOptions,
    E2BSandboxDriver,
    E2BSandboxInfo,
} from './e2b-driver';

/* eslint-disable jsdoc/require-jsdoc */

describe('E2BBackend Python parity', () => {
    test('quotes argv for a POSIX shell and forwards cwd, timeout, and signal', async () => {
        const sandbox = new FakeSandbox('sandbox');
        const backend = new E2BBackend({ sandbox, workdir: '/home/user/workspace' });
        const controller = new AbortController();

        await expect(backend.getCwd()).resolves.toBe('/home/user/workspace');
        await expect(
            backend.execShell(['echo', 'a b | ;', "it's", ''], {
                cwd: '/tmp',
                timeout: 2.5,
                signal: controller.signal,
            })
        ).resolves.toEqual(new ExecResult({ exitCode: 0 }));
        expect(sandbox.runCalls).toEqual([
            {
                commandLine: `echo 'a b | ;' 'it'"'"'s' ''`,
                options: {
                    cwd: '/tmp',
                    timeoutSeconds: 2.5,
                    signal: controller.signal,
                },
            },
        ]);
    });

    test('preserves normal command output and nonzero command exceptions', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.outputs.push({ exitCode: 4, stdout: 'out', stderr: 'err' });
        const backend = new E2BBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.execShell(['one'])).resolves.toEqual(
            new ExecResult({
                exitCode: 4,
                stdout: Buffer.from('out'),
                stderr: Buffer.from('err'),
            })
        );
        sandbox.errors.push(
            Object.assign(new Error('exit'), { exitCode: 7, stdout: 'partial', stderr: 'bad' })
        );
        await expect(backend.execShell(['two'])).resolves.toEqual(
            new ExecResult({
                exitCode: 7,
                stdout: Buffer.from('partial'),
                stderr: Buffer.from('bad'),
            })
        );
    });

    test('maps transport failures to the -1 sentinel', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.errors.push(new Error('network down'));
        const backend = new E2BBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.execShell(['true'])).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('Error: network down') })
        );
    });

    test('round-trips bytes and creates parent directories before writing', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.files.set('/workspace/file.bin', Buffer.from([0, 1, 2, 255]));
        const backend = new E2BBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.readFile('/workspace/file.bin')).resolves.toEqual(
            Buffer.from([0, 1, 2, 255])
        );
        await backend.writeFile('/workspace/a/file.bin', Buffer.from([3, 4]));
        await backend.writeFile('file.bin', Buffer.from([5]));

        expect(sandbox.runCalls[0]).toEqual({
            commandLine: 'mkdir -p /workspace/a',
            options: {
                cwd: '/workspace',
                timeoutSeconds: undefined,
                signal: undefined,
            },
        });
        expect(sandbox.files.get('/workspace/a/file.bin')).toEqual(Buffer.from([3, 4]));
        expect(sandbox.files.get('file.bin')).toEqual(Buffer.from([5]));
        expect(sandbox.runCalls).toHaveLength(1);
    });

    test('translates only E2B not-found failures', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.readError = Object.assign(new Error('missing'), { name: 'FileNotFoundError' });
        const backend = new E2BBackend({ sandbox, workdir: '/workspace' });
        await expect(backend.readFile('/workspace/missing')).rejects.toThrow(
            'not found in sandbox: /workspace/missing'
        );

        sandbox.readError = new Error('permission denied');
        await expect(backend.readFile('/workspace/private')).rejects.toThrow('permission denied');
    });
});

describe('E2BWorkspace Python parity', () => {
    test('exposes defaults, copies configuration, and renders instructions', async () => {
        const env = { API_KEY: 'value' };
        const metadata = { project: 'demo' };
        const pip = ['requests'];
        const workspace = new TestE2BWorkspace({
            workspaceId: 'workspace',
            env,
            sandboxMetadata: metadata,
            extraPip: pip,
            instructions: '{backend} at {workdir}',
            client: new FakeClient(),
        });
        env.API_KEY = 'changed';
        metadata.project = 'changed';
        pip.push('numpy');

        expect({
            workdir: workspace.workdir,
            template: workspace.template,
            timeout: workspace.timeoutSeconds,
            port: workspace.gatewayPort,
            env: workspace.env,
            metadata: workspace.sandboxMetadata,
            pip: workspace.extraPip,
            sandboxId: workspace.sandboxId,
            persistent: workspace.isPersistent,
        }).toEqual({
            workdir: '/home/user/workspace',
            template: 'base',
            timeout: 300,
            port: 5600,
            env: { API_KEY: 'value' },
            metadata: { project: 'demo' },
            pip: ['requests'],
            sandboxId: null,
            persistent: true,
        });
        await expect(workspace.getInstructions()).resolves.toBe(
            'E2B-based at /home/user/workspace'
        );
    });

    test('creates a sandbox with exact API options and user-overridable metadata', async () => {
        const client = new FakeClient();
        const workspace = new TestE2BWorkspace({
            workspaceId: 'workspace',
            template: 'custom',
            apiKey: 'key',
            domain: 'example.test',
            timeoutSeconds: 42,
            env: { FOO: 'bar' },
            sandboxMetadata: {
                [E2B_WORKSPACE_ID_METADATA_KEY]: 'metadata-wins',
                project: 'demo',
            },
            client,
        });

        await workspace.initialize();
        await workspace.initialize();

        expect(client.listCalls).toEqual([
            {
                metadata: { [E2B_WORKSPACE_ID_METADATA_KEY]: 'workspace' },
                state: ['paused', 'running'],
                apiKey: 'key',
                domain: 'example.test',
            },
        ]);
        expect(client.createCalls).toEqual([
            {
                template: 'custom',
                timeoutSeconds: 42,
                metadata: {
                    [E2B_WORKSPACE_ID_METADATA_KEY]: 'metadata-wins',
                    project: 'demo',
                },
                env: { FOO: 'bar' },
                apiKey: 'key',
                domain: 'example.test',
            },
        ]);
        expect(workspace.sandboxId).toBe('created');
        expect(workspace.getBackend()).toBeInstanceOf(E2BBackend);
    });

    test('reattaches to the newest matching paused or running sandbox', async () => {
        const client = new FakeClient();
        client.listed = [
            { sandboxId: 'old', startedAt: new Date('2026-01-01') },
            { sandboxId: 'new', startedAt: new Date('2026-02-01') },
        ];
        client.listResultError = new Error('second page failed');
        const workspace = new TestE2BWorkspace({
            workspaceId: 'workspace',
            timeoutSeconds: 90,
            client,
        });

        await workspace.initialize();

        expect(client.connectCalls).toEqual([
            { sandboxId: 'new', options: { timeoutSeconds: 90 } },
        ]);
        expect(client.createCalls).toEqual([]);
        expect(workspace.sandboxId).toBe('new');
    });

    test('creates a sandbox when listing fails and omits empty optional API fields', async () => {
        const client = new FakeClient();
        client.listError = new Error('list failed');
        const workspace = new TestE2BWorkspace({ workspaceId: 'workspace', client });

        await workspace.initialize();

        expect(client.createCalls).toEqual([
            {
                template: 'base',
                timeoutSeconds: 300,
                metadata: { [E2B_WORKSPACE_ID_METADATA_KEY]: 'workspace' },
            },
        ]);
    });

    test('retries false and transient readiness probes', async () => {
        const client = new FakeClient();
        client.created.runningResults.push(new Error('not routable'), false, true);
        const workspace = new TestE2BWorkspace({ client });

        await workspace.initialize();

        expect(client.created.runningCalls).toBe(3);
    });

    test('raises after the configured readiness deadline', async () => {
        const client = new FakeClient();
        client.created.defaultRunning = false;
        const workspace = new TestE2BWorkspace({ workspaceId: 'slow', client });
        workspace.setReadinessTimeout(0.001);

        await expect(workspace.initialize()).rejects.toThrow(
            'E2B sandbox did not become ready within 0.001s (workspace_id="slow")'
        );
    });

    test('pauses instead of killing and swallows pause failures', async () => {
        const client = new FakeClient();
        const workspace = new TestE2BWorkspace({ client });
        await workspace.initialize();
        client.created.pauseError = new Error('pause failed');

        await expect(workspace.close()).resolves.toBeUndefined();

        expect(client.created.pauseCalls).toBe(1);
        expect(workspace.sandboxId).toBeNull();
        expect(workspace.isAlive).toBe(false);
    });

    test('matches the five E2B bootstrap commands and quotes extra packages', () => {
        const workspace = new TestE2BWorkspace({
            extraPip: ['normal', 'unsafe; echo injected'],
            client: new FakeClient(),
        });

        expect(workspace.readBootstrapCommands()).toEqual([
            'sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends ripgrep ' +
                '&& sudo rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh | sudo env ' +
                'UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${E2B_GATEWAY_HOME}/.venv`,
            `uv pip install --python ${E2B_GATEWAY_HOME}/.venv/bin/python ` +
                `'mcp<2.0.0' uvicorn fastapi httpx normal 'unsafe; echo injected'`,
            `uv pip install --python ${E2B_GATEWAY_HOME}/.venv/bin/python ` +
                `--no-deps 'agentscope'`,
        ]);
    });
});

class TestE2BWorkspace extends E2BWorkspace {
    constructor(options: E2BWorkspaceOptions) {
        super(options);
    }

    setReadinessTimeout(seconds: number): void {
        this.readinessTimeoutSeconds = seconds;
    }

    readBootstrapCommands(): string[] {
        this.backend ??= new E2BBackend({
            sandbox: new FakeSandbox('bootstrap'),
            workdir: E2B_SANDBOX_WORKDIR,
        });
        return this.bootstrapCommands();
    }

    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeClient implements E2BClientDriver {
    readonly created = new FakeSandbox('created');
    listed: E2BSandboxInfo[] = [];
    listError: Error | null = null;
    listResultError: Error | null = null;
    readonly listCalls: E2BListOptions[] = [];
    readonly connectCalls: Array<{ sandboxId: string; options: E2BConnectOptions }> = [];
    readonly createCalls: E2BCreateOptions[] = [];

    async list(options: E2BListOptions): Promise<E2BListResult> {
        this.listCalls.push(options);
        if (this.listError) throw this.listError;
        return {
            sandboxes: [...this.listed],
            ...(this.listResultError ? { error: this.listResultError } : {}),
        };
    }

    async connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxDriver> {
        this.connectCalls.push({ sandboxId, options });
        return new FakeSandbox(sandboxId);
    }

    async create(options: E2BCreateOptions): Promise<E2BSandboxDriver> {
        this.createCalls.push(options);
        return this.created;
    }
}

class FakeSandbox implements E2BSandboxDriver {
    readonly runCalls: Array<{ commandLine: string; options: E2BRunOptions }> = [];
    readonly outputs: E2BCommandOutput[] = [];
    readonly errors: Error[] = [];
    readonly files = new Map<string, Buffer>();
    readonly runningResults: Array<boolean | Error> = [];
    defaultRunning = true;
    runningCalls = 0;
    pauseCalls = 0;
    pauseError: Error | null = null;
    readError: Error | null = null;

    constructor(readonly sandboxId: string) {}

    async run(commandLine: string, options: E2BRunOptions): Promise<E2BCommandOutput> {
        this.runCalls.push({ commandLine, options });
        const error = this.errors.shift();
        if (error) throw error;
        return this.outputs.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    }

    async readFile(filePath: string): Promise<Uint8Array> {
        if (this.readError) throw this.readError;
        const data = this.files.get(filePath);
        if (!data) throw Object.assign(new Error('missing'), { name: 'FileNotFoundError' });
        return data;
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        this.files.set(filePath, Buffer.from(data));
    }

    async isRunning(): Promise<boolean> {
        this.runningCalls += 1;
        const result = this.runningResults.shift();
        if (result instanceof Error) throw result;
        return result ?? this.defaultRunning;
    }

    async pause(): Promise<boolean> {
        this.pauseCalls += 1;
        if (this.pauseError) throw this.pauseError;
        return true;
    }
}
