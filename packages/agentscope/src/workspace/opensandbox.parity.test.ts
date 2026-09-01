/* eslint-disable jsdoc/require-jsdoc */

import { ExecResult } from '../tool';
import {
    DEFAULT_OPENSANDBOX_GATEWAY_PORT,
    DEFAULT_OPENSANDBOX_IMAGE,
    DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT,
    DEFAULT_OPENSANDBOX_TIMEOUT,
    OPENSANDBOX_BOOTSTRAP_COMMAND_TIMEOUT,
    OPENSANDBOX_GATEWAY_HOME,
    OPENSANDBOX_WORKDIR,
    OPENSANDBOX_WORKSPACE_ID_METADATA_KEY,
    OpenSandboxBackend,
    OpenSandboxWorkspace,
    type OpenSandboxWorkspaceOptions,
} from './opensandbox';
import type {
    OpenSandboxClientDriver,
    OpenSandboxConnectionOptions,
    OpenSandboxCreateOptions,
    OpenSandboxExecution,
    OpenSandboxInfo,
    OpenSandboxListOptions,
    OpenSandboxRunOptions,
    OpenSandboxSandboxDriver,
    OpenSandboxWriteEntry,
} from './opensandbox-driver';

describe('OpenSandboxBackend Python parity', () => {
    test('POSIX-quotes argv and forwards cwd, timeout, and signal', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.executions.push({
            exitCode: 4,
            stdout: Buffer.from([0, 1, 255]),
            stderr: 'bad',
        });
        const backend = new OpenSandboxBackend({ sandbox, workdir: OPENSANDBOX_WORKDIR });
        const controller = new AbortController();

        await expect(
            backend.execShell(['echo', 'a b | ;', "it's", ''], {
                cwd: '/tmp',
                timeout: 2.5,
                signal: controller.signal,
            })
        ).resolves.toEqual(
            new ExecResult({
                exitCode: 4,
                stdout: Buffer.from([0, 1, 255]),
                stderr: Buffer.from('bad'),
            })
        );
        await expect(backend.getCwd()).resolves.toBe(OPENSANDBOX_WORKDIR);
        expect(sandbox.runCalls).toEqual([
            {
                commandLine: `echo 'a b | ;' 'it'"'"'s' ''`,
                options: {
                    workingDirectory: '/tmp',
                    timeoutSeconds: 2.5,
                    signal: controller.signal,
                },
            },
        ]);
    });

    test('normalizes SDK log entries with Python-equivalent separators', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.executions.push({
            exitCode: null,
            stdoutLogs: [
                { text: 'one' },
                { text: 'two' },
                { text: ' three' },
                { text: 'four\n' },
                { text: 'five' },
            ],
            stderrLogs: [{ text: 'bad' }, { text: 'worse' }],
        });
        const backend = new OpenSandboxBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.execShell(['true'])).resolves.toEqual(
            new ExecResult({
                exitCode: 0,
                stdout: Buffer.from('one\ntwo three\nfour\nfive'),
                stderr: Buffer.from('bad\nworse'),
            })
        );
    });

    test('maps transport failures and pre-aborted commands to sentinels', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.runError = new Error('transport failed');
        const backend = new OpenSandboxBackend({ sandbox, workdir: '/workspace' });
        await expect(backend.execShell(['true'])).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('transport failed') })
        );
        const controller = new AbortController();
        controller.abort();
        await expect(backend.execShell(['true'], { signal: controller.signal })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') })
        );
        expect(sandbox.runCalls).toHaveLength(1);
    });

    test('round-trips bytes and translates nested 404/not-found failures only', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.files.set('/file', Buffer.from([0, 1, 255]));
        const backend = new OpenSandboxBackend({ sandbox, workdir: '/workspace' });
        await expect(backend.readFile('/file')).resolves.toEqual(Buffer.from([0, 1, 255]));

        sandbox.readError = Object.assign(new Error('request failed'), {
            cause: { response: { status: 404 } },
        });
        await expect(backend.readFile('/missing')).rejects.toThrow(
            'not found in OpenSandbox sandbox: /missing'
        );
        sandbox.readError = Object.assign(new Error('missing'), { name: 'FileNotFoundError' });
        await expect(backend.readFile('/native')).rejects.toThrow(
            'not found in OpenSandbox sandbox: /native'
        );
        sandbox.readError = new Error('permission denied');
        await expect(backend.readFile('/private')).rejects.toThrow('permission denied');
    });

    test('creates meaningful parents and uses binary-safe buffered and streaming entries', async () => {
        const sandbox = new FakeSandbox('sandbox');
        const backend = new OpenSandboxBackend({ sandbox, workdir: '/workspace' });
        await backend.writeFile('/workspace/a/file', Buffer.from([1, 2]));
        await backend.writeFile('file', Buffer.from([3]));
        async function* chunks(): AsyncGenerator<Buffer> {
            yield Buffer.from([4, 5]);
            yield Buffer.from([6]);
        }
        await backend.writeStream('/workspace/stream', chunks());

        expect(sandbox.runCalls.map(call => call.commandLine)).toEqual([
            'mkdir -p /workspace/a',
            'mkdir -p /workspace',
        ]);
        expect(sandbox.writeCalls.slice(0, 2)).toEqual([
            [{ path: '/workspace/a/file', data: Buffer.from([1, 2]), mode: 0o644 }],
            [{ path: 'file', data: Buffer.from([3]), mode: 0o644 }],
        ]);
        const streamed = sandbox.writeCalls[2]?.[0];
        expect(streamed).toMatchObject({ path: '/workspace/stream', mode: 0o644 });
        expect(await collect(streamed!.data)).toEqual(Buffer.from([4, 5, 6]));
    });
});

describe('OpenSandboxWorkspace Python parity', () => {
    test('copies configuration, passes exact connection/create options, and is idempotent', async () => {
        const env = { A: 'B' };
        const metadata = {
            [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: 'user-loses',
            team: 'agents',
        };
        const resource = { cpu: '2' };
        const entrypoint = ['sleep', 'infinity'];
        const networkPolicy = { defaultAction: 'deny', egress: [] };
        const pip = ['requests'];
        const client = new FakeClient();
        const factoryCalls: OpenSandboxConnectionOptions[] = [];
        const workspace = new TestOpenSandboxWorkspace({
            workspaceId: 'workspace',
            image: 'custom/image',
            apiKey: 'key',
            domain: 'sandbox.example',
            protocol: 'https',
            requestTimeoutSeconds: 42,
            timeoutSeconds: 77,
            env,
            sandboxMetadata: metadata,
            resource,
            entrypoint,
            networkPolicy,
            extraPip: pip,
            instructions: '{backend} at {workdir}',
            clientFactory: async options => {
                factoryCalls.push(options);
                return client;
            },
        });
        env.A = 'changed';
        metadata.team = 'changed';
        resource.cpu = 'changed';
        entrypoint.push('changed');
        networkPolicy.defaultAction = 'allow';
        pip.push('numpy');

        await workspace.initialize();
        await workspace.initialize();

        expect(factoryCalls).toEqual([
            {
                protocol: 'https',
                apiKey: 'key',
                domain: 'sandbox.example',
                requestTimeoutSeconds: 42,
            },
        ]);
        expect(client.listCalls).toEqual([
            {
                states: ['Running', 'Paused'],
                metadata: { [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: 'workspace' },
            },
        ]);
        expect(client.createCalls).toEqual([
            {
                image: 'custom/image',
                metadata: {
                    [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: 'workspace',
                    team: 'agents',
                },
                timeoutSeconds: 77,
                readyTimeoutSeconds: 77,
                env: { A: 'B' },
                resource: { cpu: '2' },
                entrypoint: ['sleep', 'infinity'],
                networkPolicy: { defaultAction: 'deny', egress: [] },
            },
        ]);
        expect({
            workdir: workspace.workdir,
            image: workspace.image,
            port: workspace.gatewayPort,
            sandboxId: workspace.sandboxId,
            bootstrapTimeout: workspace.bootstrapTimeout(),
            persistent: workspace.isPersistent,
        }).toEqual({
            workdir: OPENSANDBOX_WORKDIR,
            image: 'custom/image',
            port: DEFAULT_OPENSANDBOX_GATEWAY_PORT,
            sandboxId: 'created',
            bootstrapTimeout: OPENSANDBOX_BOOTSTRAP_COMMAND_TIMEOUT,
            persistent: true,
        });
        await expect(workspace.getInstructions()).resolves.toBe('OpenSandbox at /workspace');
    });

    test('matches default values and omits empty SDK options including null request timeout', async () => {
        const client = new FakeClient();
        const connections: OpenSandboxConnectionOptions[] = [];
        const workspace = new TestOpenSandboxWorkspace({
            workspaceId: 'defaults',
            requestTimeoutSeconds: null,
            clientFactory: async options => {
                connections.push(options);
                return client;
            },
        });
        await workspace.initialize();

        expect(connections).toEqual([{ protocol: 'http' }]);
        expect(client.createCalls).toEqual([
            {
                image: DEFAULT_OPENSANDBOX_IMAGE,
                metadata: { [OPENSANDBOX_WORKSPACE_ID_METADATA_KEY]: 'defaults' },
                timeoutSeconds: DEFAULT_OPENSANDBOX_TIMEOUT,
                readyTimeoutSeconds: DEFAULT_OPENSANDBOX_TIMEOUT,
            },
        ]);
        const defaultWorkspace = new OpenSandboxWorkspace();
        expect(defaultWorkspace.requestTimeoutSeconds).toBe(DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT);
    });

    test('attaches to the newest running sandbox and resumes a paused sandbox', async () => {
        const runningClient = new FakeClient();
        runningClient.listed = [
            { id: 'old', state: 'Paused', createdAt: new Date('2026-01-01') },
            { id: 'new', state: 'Running', createdAt: new Date('2026-02-01') },
        ];
        const running = new TestOpenSandboxWorkspace({
            timeoutSeconds: 91,
            client: runningClient,
        });
        await running.initialize();
        expect(runningClient.connectCalls).toEqual([{ sandboxId: 'new', timeoutSeconds: 91 }]);
        expect(runningClient.resumeCalls).toEqual([]);
        expect(runningClient.createCalls).toEqual([]);

        const pausedClient = new FakeClient();
        pausedClient.listed = [
            { id: 'paused', state: 'PAUSED', createdAt: new Date('2026-01-01') },
        ];
        const paused = new TestOpenSandboxWorkspace({ client: pausedClient });
        await paused.initialize();
        expect(pausedClient.resumeCalls).toEqual([
            { sandboxId: 'paused', timeoutSeconds: DEFAULT_OPENSANDBOX_TIMEOUT },
        ]);
    });

    test('rejects non-attachable states and propagates listing failures', async () => {
        const client = new FakeClient();
        const workspace = new TestOpenSandboxWorkspace({ client });
        await expect(
            workspace.attachForTest({
                id: 'bad',
                state: 'Deleting',
                createdAt: new Date(),
            })
        ).rejects.toThrow('is not attachable (state="deleting")');

        client.listError = new Error('list failed');
        await expect(workspace.initialize()).rejects.toThrow('list failed');
    });

    test('retries false and transient health probes with exponential backoff', async () => {
        const client = new FakeClient();
        client.created.healthResults.push(new Error('not ready'), false, true);
        const workspace = new TestOpenSandboxWorkspace({ client });
        await workspace.initialize();

        expect(client.created.healthCalls).toBe(3);
        expect(workspace.sleeps).toEqual([100, 150]);
    });

    test('raises after the readiness deadline and skips absent legacy probes', async () => {
        const client = new FakeClient();
        client.created.defaultHealthy = false;
        const workspace = new TestOpenSandboxWorkspace({
            workspaceId: 'slow',
            client,
        });
        workspace.setReadinessTimeout(0.001);
        await expect(workspace.initialize()).rejects.toThrow(
            'did not become ready within 0.001s (workspace_id="slow")'
        );

        const legacy = new TestOpenSandboxWorkspace({ client: new FakeClient() });
        legacy.setSandbox({
            id: 'legacy',
            run: async () => ({ exitCode: 0 }),
            readBytes: async () => Buffer.alloc(0),
            writeFiles: async () => undefined,
            pause: async () => undefined,
            close: async () => undefined,
        });
        await expect(legacy.waitForTest()).resolves.toBeUndefined();
    });

    test('pauses, locally closes, clears state, and swallows teardown failures', async () => {
        const client = new FakeClient();
        const workspace = new TestOpenSandboxWorkspace({ client });
        await workspace.initialize();
        client.created.pauseError = new Error('pause failed');
        client.created.closeError = new Error('close failed');

        await expect(workspace.close()).resolves.toBeUndefined();
        await expect(workspace.close()).resolves.toBeUndefined();

        expect({ pause: client.created.pauseCalls, close: client.created.closeCalls }).toEqual({
            pause: 1,
            close: 1,
        });
        expect(workspace.sandboxId).toBeNull();
        expect(workspace.isAlive).toBe(false);
    });

    test('matches the five bootstrap commands and quotes unsafe packages', () => {
        const client = new FakeClient();
        const workspace = new TestOpenSandboxWorkspace({
            extraPip: ['normal', 'unsafe; echo injected'],
            client,
        });
        workspace.bindBackend();
        expect(workspace.bootstrapForTest()).toEqual([
            'apt-get update -qq && apt-get install -y --no-install-recommends ' +
                'curl ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                '| env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${OPENSANDBOX_GATEWAY_HOME}/.venv`,
            `uv pip install --python ${OPENSANDBOX_GATEWAY_HOME}/.venv/bin/python ` +
                `'mcp<2.0.0' uvicorn fastapi httpx normal 'unsafe; echo injected'`,
            `uv pip install --python ${OPENSANDBOX_GATEWAY_HOME}/.venv/bin/python ` +
                `--no-deps 'agentscope'`,
        ]);
    });
});

class TestOpenSandboxWorkspace extends OpenSandboxWorkspace {
    readonly sleeps: number[] = [];
    private clock = 0;

    constructor(options: OpenSandboxWorkspaceOptions) {
        super(options);
    }

    bootstrapTimeout(): number {
        return this.bootstrapCommandTimeout;
    }

    bindBackend(): void {
        this.backend = new OpenSandboxBackend({
            sandbox: new FakeSandbox('bootstrap'),
            workdir: OPENSANDBOX_WORKDIR,
        });
    }

    bootstrapForTest(): string[] {
        return this.bootstrapCommands();
    }

    async attachForTest(info: OpenSandboxInfo): Promise<OpenSandboxSandboxDriver> {
        return this.attachExistingSandbox(info);
    }

    setReadinessTimeout(seconds: number): void {
        this.readinessTimeoutSeconds = seconds;
    }

    setSandbox(sandbox: OpenSandboxSandboxDriver): void {
        this.sandbox = sandbox;
    }

    async waitForTest(): Promise<void> {
        await this.waitUntilRunning();
    }

    protected override now(): number {
        return this.clock;
    }

    protected override async sleep(milliseconds: number): Promise<void> {
        this.sleeps.push(milliseconds);
        this.clock += milliseconds;
    }

    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeClient implements OpenSandboxClientDriver {
    readonly created = new FakeSandbox('created');
    listed: OpenSandboxInfo[] = [];
    listError: Error | null = null;
    readonly listCalls: OpenSandboxListOptions[] = [];
    readonly createCalls: OpenSandboxCreateOptions[] = [];
    readonly connectCalls: Array<{ sandboxId: string; timeoutSeconds: number }> = [];
    readonly resumeCalls: Array<{ sandboxId: string; timeoutSeconds: number }> = [];

    async list(options: OpenSandboxListOptions): Promise<OpenSandboxInfo[]> {
        this.listCalls.push(options);
        if (this.listError) throw this.listError;
        return [...this.listed];
    }

    async create(options: OpenSandboxCreateOptions): Promise<OpenSandboxSandboxDriver> {
        this.createCalls.push(options);
        return this.created;
    }

    async connect(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver> {
        this.connectCalls.push({ sandboxId, timeoutSeconds });
        return new FakeSandbox(sandboxId);
    }

    async resume(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver> {
        this.resumeCalls.push({ sandboxId, timeoutSeconds });
        return new FakeSandbox(sandboxId);
    }
}

class FakeSandbox implements OpenSandboxSandboxDriver {
    readonly runCalls: Array<{ commandLine: string; options: OpenSandboxRunOptions }> = [];
    readonly executions: OpenSandboxExecution[] = [];
    readonly files = new Map<string, Buffer>();
    readonly writeCalls: OpenSandboxWriteEntry[][] = [];
    readonly healthResults: Array<boolean | Error> = [];
    defaultHealthy = true;
    healthCalls = 0;
    pauseCalls = 0;
    closeCalls = 0;
    runError: Error | null = null;
    readError: Error | null = null;
    pauseError: Error | null = null;
    closeError: Error | null = null;

    constructor(readonly id: string) {}

    async run(commandLine: string, options: OpenSandboxRunOptions): Promise<OpenSandboxExecution> {
        this.runCalls.push({ commandLine, options });
        if (this.runError) throw this.runError;
        return this.executions.shift() ?? { exitCode: 0 };
    }

    async readBytes(filePath: string): Promise<Uint8Array> {
        if (this.readError) throw this.readError;
        const data = this.files.get(filePath);
        if (!data) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return data;
    }

    async writeFiles(entries: OpenSandboxWriteEntry[]): Promise<void> {
        this.writeCalls.push(entries);
        for (const entry of entries) {
            if (entry.data instanceof Uint8Array)
                this.files.set(entry.path, Buffer.from(entry.data));
        }
    }

    async isHealthy(): Promise<boolean> {
        this.healthCalls += 1;
        const result = this.healthResults.shift();
        if (result instanceof Error) throw result;
        return result ?? this.defaultHealthy;
    }

    async pause(): Promise<void> {
        this.pauseCalls += 1;
        if (this.pauseError) throw this.pauseError;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.closeError) throw this.closeError;
    }
}

async function collect(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
    if (data instanceof Uint8Array) return Buffer.from(data);
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
