import { ExecResult } from '../tool';
import {
    DAYTONA_GATEWAY_HOME_NAME,
    DAYTONA_WORKSPACE_ID_METADATA_KEY,
    DaytonaBackend,
    DaytonaWorkspace,
    type DaytonaWorkspaceOptions,
} from './daytona';
import type {
    DaytonaClientDriver,
    DaytonaCreateOptions,
    DaytonaListOptions,
    DaytonaSandboxDriver,
    DaytonaSandboxState,
} from './daytona-driver';

/* eslint-disable jsdoc/require-jsdoc */

describe('DaytonaBackend Python parity', () => {
    test('POSIX-quotes argv, merges stderr, and rounds timeouts up', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.outputs.push({ exitCode: 4, result: 'out and err' });
        const backend = new DaytonaBackend({ sandbox, workdir: '/workspace' });

        await expect(
            backend.execShell(['echo', 'a b $(x) | ;', "it's"], {
                cwd: '/tmp',
                timeout: 1.01,
            })
        ).resolves.toEqual(new ExecResult({ exitCode: 4, stdout: Buffer.from('out and err') }));
        expect(sandbox.executeCalls).toEqual([
            {
                commandLine: `echo 'a b $(x) | ;' 'it'"'"'s' 2>&1`,
                cwd: '/tmp',
                timeoutSeconds: 2,
            },
        ]);
        await expect(backend.getCwd()).resolves.toBe('/workspace');
    });

    test('maps transport failures and pre-aborted commands to sentinels', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.executeError = new Error('transport failed');
        const backend = new DaytonaBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.execShell(['true'])).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('Error: transport failed') })
        );
        const controller = new AbortController();
        controller.abort();
        await expect(backend.execShell(['true'], { signal: controller.signal })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') })
        );
        expect(sandbox.executeCalls).toHaveLength(1);
    });

    test('round-trips bytes and creates only meaningful parent directories', async () => {
        const sandbox = new FakeSandbox('sandbox');
        sandbox.files.set('/workspace/file', Buffer.from([0, 1, 255]));
        const backend = new DaytonaBackend({ sandbox, workdir: '/workspace' });

        await expect(backend.readFile('/workspace/file')).resolves.toEqual(
            Buffer.from([0, 1, 255])
        );
        await backend.writeFile('/workspace/a/file', Buffer.from([2, 3]));
        await backend.writeFile('file', Buffer.from([4]));

        expect(sandbox.executeCalls).toEqual([
            {
                commandLine: 'mkdir -p /workspace/a 2>&1',
                cwd: '/workspace',
                timeoutSeconds: undefined,
            },
        ]);
        expect(sandbox.files.get('/workspace/a/file')).toEqual(Buffer.from([2, 3]));
        expect(sandbox.files.get('file')).toEqual(Buffer.from([4]));
    });

    test('translates Daytona and native not-found errors only', async () => {
        const sandbox = new FakeSandbox('sandbox');
        const backend = new DaytonaBackend({ sandbox, workdir: '/workspace' });
        sandbox.downloadError = Object.assign(new Error('missing'), {
            name: 'DaytonaNotFoundError',
        });
        await expect(backend.readFile('/missing')).rejects.toThrow(
            'not found in sandbox: /missing'
        );
        sandbox.downloadError = new Error('denied');
        await expect(backend.readFile('/private')).rejects.toThrow('denied');
    });
});

describe('DaytonaWorkspace Python parity', () => {
    test('exposes defaults, copies config, and uses unknown pre-init paths', async () => {
        const env = { FOO: 'bar' };
        const metadata = { team: 'agents' };
        const pip = ['requests'];
        const workspace = new TestDaytonaWorkspace({
            workspaceId: 'workspace',
            env,
            sandboxMetadata: metadata,
            extraPip: pip,
            instructions: '{backend} at {workdir}',
            client: new FakeClient(),
        });
        env.FOO = 'changed';
        metadata.team = 'changed';
        pip.push('numpy');

        expect({
            workdir: workspace.workdir,
            timeout: workspace.timeoutSeconds,
            port: workspace.gatewayPort,
            env: workspace.env,
            metadata: workspace.sandboxMetadata,
            pip: workspace.extraPip,
            sandboxId: workspace.sandboxId,
        }).toEqual({
            workdir: '',
            timeout: 300,
            port: 5600,
            env: { FOO: 'bar' },
            metadata: { team: 'agents' },
            pip: ['requests'],
            sandboxId: null,
        });
        await expect(workspace.getInstructions()).resolves.toBe('Daytona-based at <unknown>');
    });

    test('creates with secure minimal params and derives all paths from the SDK', async () => {
        const client = new FakeClient();
        client.created.workdir = '/workspace/project';
        client.created.userHome = '/users/daytona';
        const workspace = new TestDaytonaWorkspace({
            workspaceId: 'workspace',
            timeoutSeconds: 42,
            env: { A: 'B' },
            sandboxMetadata: {
                [DAYTONA_WORKSPACE_ID_METADATA_KEY]: 'metadata-wins',
                team: 'agents',
            },
            osUser: 'daytona',
            client,
        });

        await workspace.initialize();
        await workspace.initialize();

        expect(client.listCalls).toEqual([
            {
                labels: { [DAYTONA_WORKSPACE_ID_METADATA_KEY]: 'workspace' },
                states: [
                    'started',
                    'stopped',
                    'starting',
                    'stopping',
                    'error',
                    'pausing',
                    'paused',
                    'resuming',
                ],
            },
        ]);
        expect(client.createCalls).toEqual([
            {
                labels: {
                    [DAYTONA_WORKSPACE_ID_METADATA_KEY]: 'metadata-wins',
                    team: 'agents',
                },
                public: false,
                env: { A: 'B' },
                osUser: 'daytona',
                timeoutSeconds: 42,
            },
        ]);
        expect(workspace.paths()).toEqual({
            workdir: '/workspace/project',
            userHome: '/users/daytona',
            gatewayHome: `/users/daytona/${DAYTONA_GATEWAY_HOME_NAME}`,
            gatewayVenv: '/users/daytona/.agentscope/.venv',
            gatewayPython: '/users/daytona/.agentscope/.venv/bin/python',
            uvBin: '/users/daytona/.local/bin/uv',
        });
        expect(workspace.sandboxId).toBe('created');
        expect(workspace.getBackend()).toBeInstanceOf(DaytonaBackend);
        await expect(workspace.getInstructions()).resolves.toContain(
            'Daytona-based workspace at /workspace/project'
        );
    });

    test.each([
        ['stopped', 'start'],
        ['paused', 'start'],
        ['error', 'recover'],
        ['starting', 'waitUntilStarted'],
        ['resuming', 'waitUntilStarted'],
        ['stopping', 'waitUntilStoppedThenStart'],
        ['pausing', 'waitUntilStoppedThenStart'],
        ['started', 'refreshOnly'],
    ] as const)('normalizes an existing %s sandbox via %s', async (state, behavior) => {
        const client = new FakeClient();
        const candidate = new FakeSandbox('existing', state);
        candidate.recoverable = true;
        client.listed = [candidate];
        const workspace = new TestDaytonaWorkspace({ timeoutSeconds: 77, client });

        await workspace.initialize();

        expect(candidate.startCalls).toBe(
            behavior === 'start' || behavior === 'waitUntilStoppedThenStart' ? 1 : 0
        );
        expect(candidate.recoverCalls).toBe(behavior === 'recover' ? 1 : 0);
        expect(candidate.waitStartCalls).toBe(behavior === 'waitUntilStarted' ? 1 : 0);
        expect(candidate.waitStopCalls).toBe(behavior === 'waitUntilStoppedThenStart' ? 1 : 0);
        expect(candidate.refreshCalls).toBe(1);
        expect(client.createCalls).toEqual([]);
    });

    test('filters unusable errors and chooses the newest usable duplicate', async () => {
        const client = new FakeClient();
        const unusable = new FakeSandbox('bad', 'error');
        unusable.recoverable = false;
        unusable.lastActivityAt = '2026-03-01';
        const older = new FakeSandbox('old', 'started');
        older.lastActivityAt = '2026-01-01';
        const newer = new FakeSandbox('new', 'started');
        newer.lastActivityAt = '2026-02-01';
        client.listed = [unusable, older, newer];
        const workspace = new TestDaytonaWorkspace({ client });

        await workspace.initialize();

        expect(workspace.sandboxId).toBe('new');
        expect(newer.refreshCalls).toBe(1);
        expect(client.createCalls).toEqual([]);
    });

    test('creates when listing fails or only an unrecoverable error exists', async () => {
        const failing = new FakeClient();
        failing.listError = new Error('list failed');
        const first = new TestDaytonaWorkspace({ client: failing });
        await first.initialize();
        expect(failing.createCalls).toHaveLength(1);

        const filtered = new FakeClient();
        const bad = new FakeSandbox('bad', 'error');
        bad.recoverable = false;
        filtered.listed = [bad];
        const second = new TestDaytonaWorkspace({ client: filtered });
        await second.initialize();
        expect(filtered.createCalls).toHaveLength(1);
    });

    test('stops gracefully, closes the client, and swallows teardown failures', async () => {
        const client = new FakeClient();
        const workspace = new TestDaytonaWorkspace({ timeoutSeconds: 91, client });
        await workspace.initialize();
        client.created.stopError = new Error('stop failed');
        client.closeError = new Error('close failed');

        await expect(workspace.close()).resolves.toBeUndefined();

        expect(client.created.stopCalls).toEqual([{ timeoutSeconds: 91, force: false }]);
        expect(client.closeCalls).toBe(1);
        expect(workspace.sandboxId).toBeNull();
        expect(workspace.isAlive).toBe(false);
    });

    test('renders the five bootstrap commands with quoted SDK paths and packages', () => {
        const workspace = new TestDaytonaWorkspace({
            extraPip: ['safe', 'bad; echo injected'],
            client: new FakeClient(),
        });
        workspace.bindPaths('/home/day tona');

        expect(workspace.readBootstrapCommands()).toEqual([
            'sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends ripgrep ' +
                '&& sudo rm -rf /var/lib/apt/lists/*',
            "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR='/home/day tona/.local/bin' INSTALLER_NO_MODIFY_PATH=1 sh",
            "'/home/day tona/.local/bin/uv' venv '/home/day tona/.agentscope/.venv'",
            "'/home/day tona/.local/bin/uv' pip install --python " +
                "'/home/day tona/.agentscope/.venv/bin/python' 'mcp<2.0.0' uvicorn fastapi httpx safe 'bad; echo injected'",
            "'/home/day tona/.local/bin/uv' pip install --python " +
                "'/home/day tona/.agentscope/.venv/bin/python' --no-deps 'agentscope'",
        ]);
    });
});

class TestDaytonaWorkspace extends DaytonaWorkspace {
    constructor(options: DaytonaWorkspaceOptions) {
        super(options);
    }

    paths() {
        return {
            workdir: this.workdir,
            userHome: this.userHome,
            gatewayHome: this.gatewayHome,
            gatewayVenv: this.gatewayVenv,
            gatewayPython: this.gatewayPython,
            uvBin: this.uvBin,
        };
    }

    bindPaths(userHome: string): void {
        this.workdir = userHome;
        this.userHome = userHome;
        this.gatewayHome = `${userHome}/.agentscope`;
        this.uvBin = `${userHome}/.local/bin/uv`;
        this.backend = new DaytonaBackend({
            sandbox: new FakeSandbox('bootstrap'),
            workdir: userHome,
        });
    }

    readBootstrapCommands(): string[] {
        return this.bootstrapCommands();
    }

    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeClient implements DaytonaClientDriver {
    readonly created = new FakeSandbox('created');
    listed: DaytonaSandboxDriver[] = [];
    listError: Error | null = null;
    closeError: Error | null = null;
    closeCalls = 0;
    readonly listCalls: DaytonaListOptions[] = [];
    readonly createCalls: DaytonaCreateOptions[] = [];

    async list(options: DaytonaListOptions): Promise<DaytonaSandboxDriver[]> {
        this.listCalls.push(options);
        if (this.listError) throw this.listError;
        return [...this.listed];
    }

    async create(options: DaytonaCreateOptions): Promise<DaytonaSandboxDriver> {
        this.createCalls.push(options);
        return this.created;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.closeError) throw this.closeError;
    }
}

class FakeSandbox implements DaytonaSandboxDriver {
    recoverable: boolean | null = null;
    createdAt: string | null = '2026-01-01';
    updatedAt: string | null = null;
    lastActivityAt: string | null = null;
    workdir = '/home/daytona';
    userHome = '/home/daytona';
    readonly files = new Map<string, Buffer>();
    readonly outputs: Array<{ exitCode: number; result: string }> = [];
    readonly executeCalls: Array<{
        commandLine: string;
        cwd: string;
        timeoutSeconds?: number;
    }> = [];
    executeError: Error | null = null;
    downloadError: Error | null = null;
    stopError: Error | null = null;
    startCalls = 0;
    recoverCalls = 0;
    waitStartCalls = 0;
    waitStopCalls = 0;
    refreshCalls = 0;
    readonly stopCalls: Array<{ timeoutSeconds: number; force: boolean }> = [];

    constructor(
        readonly id: string,
        public state: DaytonaSandboxState | null = 'started'
    ) {}

    async executeCommand(
        commandLine: string,
        cwd: string,
        timeoutSeconds?: number
    ): Promise<{ exitCode: number; result: string }> {
        this.executeCalls.push({ commandLine, cwd, timeoutSeconds });
        if (this.executeError) throw this.executeError;
        return this.outputs.shift() ?? { exitCode: 0, result: '' };
    }

    async downloadFile(filePath: string): Promise<Uint8Array> {
        if (this.downloadError) throw this.downloadError;
        const data = this.files.get(filePath);
        if (!data) throw Object.assign(new Error('missing'), { name: 'DaytonaNotFoundError' });
        return data;
    }

    async uploadFile(data: Uint8Array, filePath: string): Promise<void> {
        this.files.set(filePath, Buffer.from(data));
    }

    async getWorkDir(): Promise<string> {
        return this.workdir;
    }

    async getUserHomeDir(): Promise<string> {
        return this.userHome;
    }

    async start(_timeoutSeconds: number): Promise<void> {
        this.startCalls += 1;
        this.state = 'started';
    }

    async recover(_timeoutSeconds: number): Promise<void> {
        this.recoverCalls += 1;
        this.state = 'started';
    }

    async stop(timeoutSeconds: number, force: boolean): Promise<void> {
        this.stopCalls.push({ timeoutSeconds, force });
        if (this.stopError) throw this.stopError;
        this.state = 'stopped';
    }

    async waitUntilStarted(_timeoutSeconds: number): Promise<void> {
        this.waitStartCalls += 1;
        this.state = 'started';
    }

    async waitUntilStopped(_timeoutSeconds: number): Promise<void> {
        this.waitStopCalls += 1;
        this.state = 'stopped';
    }

    async refreshData(): Promise<void> {
        this.refreshCalls += 1;
    }
}
