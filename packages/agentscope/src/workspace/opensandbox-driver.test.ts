/* eslint-disable jsdoc/require-jsdoc */

import {
    createOpenSandboxClientFromSdk,
    type OpenSandboxConnectionOptions,
} from './opensandbox-driver';

describe('official OpenSandbox SDK driver', () => {
    beforeEach(() => {
        FakeConnectionConfig.instances.length = 0;
        FakeManager.instances.length = 0;
        FakeSandboxApi.createCalls.length = 0;
        FakeSandboxApi.connectCalls.length = 0;
        FakeSandboxApi.resumeCalls.length = 0;
        FakeSandboxApi.created = new FakeRawSandbox('created');
    });

    test('creates a scoped manager, maps list results, and always closes it', async () => {
        const client = makeClient({
            protocol: 'https',
            domain: 'sandbox.example',
            apiKey: 'key',
            requestTimeoutSeconds: 600,
        });
        const manager = new FakeManager();
        manager.items = [
            {
                id: 'sandbox',
                status: { state: 'Paused' },
                createdAt: '2026-01-02T00:00:00Z',
            },
        ];
        FakeManager.next = manager;

        await expect(
            client.list({ states: ['Running', 'Paused'], metadata: { workspace: 'id' } })
        ).resolves.toEqual([
            { id: 'sandbox', state: 'Paused', createdAt: new Date('2026-01-02T00:00:00Z') },
        ]);
        expect(FakeConnectionConfig.instances[0]?.options).toEqual({
            protocol: 'https',
            domain: 'sandbox.example',
            apiKey: 'key',
            requestTimeoutSeconds: 600,
        });
        expect(manager.listCalls).toEqual([
            { states: ['Running', 'Paused'], metadata: { workspace: 'id' } },
        ]);
        expect(manager.closeCalls).toBe(1);

        const closeFailure = new FakeManager();
        closeFailure.closeError = new Error('close failed');
        FakeManager.next = closeFailure;
        await expect(client.list({ states: [], metadata: {} })).resolves.toEqual([]);
        expect(closeFailure.closeCalls).toBe(1);

        const failure = new FakeManager();
        failure.error = new Error('list failed');
        FakeManager.next = failure;
        await expect(client.list({ states: [], metadata: {} })).rejects.toThrow('list failed');
        expect(failure.closeCalls).toBe(1);
    });

    test('maps create, connect, and resume options to the current SDK', async () => {
        const client = makeClient({ protocol: 'http' });
        await client.create({
            image: 'python:3.11-slim',
            metadata: { workspace: 'id' },
            timeoutSeconds: 300,
            readyTimeoutSeconds: 300,
            env: { A: 'B' },
            resource: { cpu: '1' },
            entrypoint: ['sleep', 'infinity'],
            networkPolicy: { defaultAction: 'deny' },
        });
        await client.connect('running', 42);
        await client.resume('paused', 43);

        expect(FakeSandboxApi.createCalls).toEqual([
            {
                connectionConfig: expect.any(FakeConnectionConfig),
                image: 'python:3.11-slim',
                metadata: { workspace: 'id' },
                timeoutSeconds: 300,
                readyTimeoutSeconds: 300,
                env: { A: 'B' },
                resource: { cpu: '1' },
                entrypoint: ['sleep', 'infinity'],
                networkPolicy: { defaultAction: 'deny' },
            },
        ]);
        expect(FakeSandboxApi.connectCalls).toEqual([
            {
                sandboxId: 'running',
                connectionConfig: expect.any(FakeConnectionConfig),
                readyTimeoutSeconds: 42,
            },
        ]);
        expect(FakeSandboxApi.resumeCalls).toEqual([
            {
                sandboxId: 'paused',
                connectionConfig: expect.any(FakeConnectionConfig),
                readyTimeoutSeconds: 43,
            },
        ]);
    });

    test('adapts command, filesystem, health, and lifecycle APIs', async () => {
        const client = makeClient({ protocol: 'http' });
        const sandbox = await client.create({
            image: 'image',
            metadata: {},
            timeoutSeconds: 1,
            readyTimeoutSeconds: 2,
        });
        const raw = FakeSandboxApi.created;
        raw.execution = {
            exitCode: 4,
            logs: {
                stdout: [{ text: 'one' }, { text: 'two' }],
                stderr: [{ text: 'bad' }],
            },
        };
        const controller = new AbortController();

        await expect(
            sandbox.run('echo hello', {
                workingDirectory: '/workspace',
                timeoutSeconds: 2.5,
                signal: controller.signal,
            })
        ).resolves.toEqual({
            exitCode: 4,
            stdoutLogs: [{ text: 'one' }, { text: 'two' }],
            stderrLogs: [{ text: 'bad' }],
        });
        expect(raw.runCalls).toEqual([
            {
                commandLine: 'echo hello',
                options: { workingDirectory: '/workspace', timeoutSeconds: 2.5 },
                signal: controller.signal,
            },
        ]);

        raw.fileStore.set('/file', Buffer.from([0, 1, 255]));
        await expect(sandbox.readBytes('/file')).resolves.toEqual(Buffer.from([0, 1, 255]));
        await sandbox.writeFiles([{ path: '/new', data: Buffer.from([2]), mode: 0o644 }]);
        await expect(sandbox.isHealthy?.()).resolves.toBe(true);
        await sandbox.pause();
        await sandbox.close();
        expect(raw.writeCalls).toEqual([[{ path: '/new', data: Buffer.from([2]), mode: 0o644 }]]);
        expect({ pause: raw.pauseCalls, close: raw.closeCalls }).toEqual({
            pause: 1,
            close: 1,
        });
    });
});

function makeClient(connection: OpenSandboxConnectionOptions) {
    return createOpenSandboxClientFromSdk(fakeSdk(), connection);
}

function fakeSdk(): Parameters<typeof createOpenSandboxClientFromSdk>[0] {
    return {
        ConnectionConfig: FakeConnectionConfig,
        SandboxManager: { create: () => FakeManager.take() },
        Sandbox: FakeSandboxApi,
    };
}

class FakeConnectionConfig {
    static readonly instances: FakeConnectionConfig[] = [];
    constructor(readonly options: OpenSandboxConnectionOptions) {
        FakeConnectionConfig.instances.push(this);
    }
}

class FakeManager {
    static next: FakeManager | null = null;
    static readonly instances: FakeManager[] = [];
    items: Array<{ id: string; status: { state: string }; createdAt: string | Date }> = [];
    error: Error | null = null;
    closeError: Error | null = null;
    readonly listCalls: unknown[] = [];
    closeCalls = 0;

    constructor() {
        FakeManager.instances.push(this);
    }

    static take(): FakeManager {
        const manager = this.next ?? new FakeManager();
        this.next = null;
        return manager;
    }

    async listSandboxInfos(options: unknown) {
        this.listCalls.push(options);
        if (this.error) throw this.error;
        return { items: this.items };
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.closeError) throw this.closeError;
    }
}

class FakeSandboxApi {
    static readonly createCalls: Record<string, unknown>[] = [];
    static readonly connectCalls: Record<string, unknown>[] = [];
    static readonly resumeCalls: Record<string, unknown>[] = [];
    static created: FakeRawSandbox;

    static async create(options: Record<string, unknown>): Promise<FakeRawSandbox> {
        this.createCalls.push(options);
        return this.created;
    }

    static async connect(options: Record<string, unknown>): Promise<FakeRawSandbox> {
        this.connectCalls.push(options);
        return new FakeRawSandbox(String(options.sandboxId));
    }

    static async resume(options: Record<string, unknown>): Promise<FakeRawSandbox> {
        this.resumeCalls.push(options);
        return new FakeRawSandbox(String(options.sandboxId));
    }
}

class FakeRawSandbox {
    execution: Record<string, unknown> = { exitCode: 0, logs: { stdout: [], stderr: [] } };
    readonly runCalls: Array<Record<string, unknown>> = [];
    readonly fileStore = new Map<string, Buffer>();
    readonly writeCalls: unknown[] = [];
    pauseCalls = 0;
    closeCalls = 0;
    readonly commands = {
        run: async (
            commandLine: string,
            options: Record<string, unknown>,
            _handlers: undefined,
            signal: AbortSignal | undefined
        ) => {
            this.runCalls.push({ commandLine, options, signal });
            return this.execution;
        },
    };

    constructor(readonly id: string) {}

    readonly files = {
        readBytes: async (filePath: string) => this.fileStore.get(filePath) ?? Buffer.alloc(0),
        writeFiles: async (entries: unknown[]) => {
            this.writeCalls.push(entries);
        },
    };

    async isHealthy(): Promise<boolean> {
        return true;
    }

    async pause(): Promise<void> {
        this.pauseCalls += 1;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
    }
}
