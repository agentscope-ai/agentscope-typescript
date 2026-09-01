/* eslint-disable jsdoc/require-jsdoc */

export {};

describe('Daytona SDK driver', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    afterEach(() => {
        jest.dontMock('@daytona/sdk');
    });

    test('maps client config, list states, and create parameters', async () => {
        const listed = rawSandbox('listed');
        const created = rawSandbox('created');
        const instances: RawClient[] = [];
        class MockDaytona extends RawClient {
            constructor(options?: Record<string, string>) {
                super(options, [listed], created);
                instances.push(this);
            }
        }
        jest.doMock('@daytona/sdk', () => ({
            Daytona: MockDaytona,
            SandboxState: { STARTED: 'provider-started', STOPPED: 'provider-stopped' },
        }));
        const { createDaytonaClient } = await import('./daytona-driver');
        const client = await createDaytonaClient({
            apiKey: 'key',
            apiUrl: 'https://example.test',
            target: 'us',
        });

        const sandboxes = await client.list({
            labels: { workspace: 'one' },
            states: ['started', 'stopped'],
        });
        expect(instances[0].options).toEqual({
            apiKey: 'key',
            apiUrl: 'https://example.test',
            target: 'us',
        });
        expect(instances[0].listCalls).toEqual([
            {
                labels: { workspace: 'one' },
                states: ['provider-started', 'provider-stopped'],
            },
        ]);
        expect(sandboxes.map(sandbox => sandbox.id)).toEqual(['listed']);

        const sandbox = await client.create({
            labels: { workspace: 'one' },
            public: false,
            env: { FOO: 'bar' },
            osUser: 'daytona',
            timeoutSeconds: 42,
        });
        expect(instances[0].createCalls).toEqual([
            {
                params: {
                    labels: { workspace: 'one' },
                    public: false,
                    envVars: { FOO: 'bar' },
                    user: 'daytona',
                },
                operation: { timeout: 42 },
            },
        ]);
        expect(sandbox.id).toBe('created');
    });

    test('adapts sandbox operations and disposes the SDK client', async () => {
        const raw = rawSandbox('sandbox');
        const instances: RawClient[] = [];
        class MockDaytona extends RawClient {
            constructor() {
                super(undefined, [], raw);
                instances.push(this);
            }
        }
        jest.doMock('@daytona/sdk', () => ({ Daytona: MockDaytona }));
        const { createDaytonaClient } = await import('./daytona-driver');
        const client = await createDaytonaClient();
        const sandbox = await client.create({
            labels: {},
            public: false,
            timeoutSeconds: 300,
        });

        await expect(sandbox.executeCommand('echo hi 2>&1', '/workspace', 2)).resolves.toEqual({
            exitCode: 0,
            result: 'out',
        });
        expect(raw.process.executeCommand).toHaveBeenCalledWith(
            'echo hi 2>&1',
            '/workspace',
            undefined,
            2
        );
        await expect(sandbox.downloadFile('/file')).resolves.toEqual(Buffer.from([1, 2]));
        await sandbox.uploadFile(Uint8Array.from([0, 255]), '/file');
        expect(raw.fs.uploadFile).toHaveBeenCalledWith(Buffer.from([0, 255]), '/file');
        await expect(sandbox.getWorkDir()).resolves.toBe('/workspace');
        await expect(sandbox.getUserHomeDir()).resolves.toBe('/home/daytona');
        await sandbox.start(1);
        await sandbox.recover(2);
        await sandbox.stop(3, false);
        await sandbox.waitUntilStarted(4);
        await sandbox.waitUntilStopped(5);
        await sandbox.refreshData();
        expect(raw.start).toHaveBeenCalledWith(1);
        expect(raw.recover).toHaveBeenCalledWith(2);
        expect(raw.stop).toHaveBeenCalledWith(3, false);
        expect(raw.waitUntilStarted).toHaveBeenCalledWith(4);
        expect(raw.waitUntilStopped).toHaveBeenCalledWith(5);
        expect(raw.refreshData).toHaveBeenCalledTimes(1);
        await client.close();
        expect(instances[0].options).toBeUndefined();
        expect(instances[0].disposed).toBe(true);
    });

    test('rejects missing SDK-derived paths', async () => {
        const raw = rawSandbox('sandbox');
        raw.getWorkDir.mockResolvedValue(undefined);
        class MockDaytona extends RawClient {
            constructor() {
                super(undefined, [], raw);
            }
        }
        jest.doMock('@daytona/sdk', () => ({ Daytona: MockDaytona }));
        const { createDaytonaClient } = await import('./daytona-driver');
        const client = await createDaytonaClient();
        const sandbox = await client.create({ labels: {}, public: false, timeoutSeconds: 1 });

        await expect(sandbox.getWorkDir()).rejects.toThrow(
            'Daytona SDK did not return a working directory.'
        );
    });
});

class RawClient {
    readonly listCalls: unknown[] = [];
    readonly createCalls: unknown[] = [];
    disposed = false;

    constructor(
        readonly options?: Record<string, string>,
        private readonly listed: ReturnType<typeof rawSandbox>[] = [],
        private readonly created = rawSandbox('created')
    ) {}

    async *list(options: unknown) {
        this.listCalls.push(options);
        yield* this.listed;
    }

    async create(params: unknown, operation: unknown) {
        this.createCalls.push({ params, operation });
        return this.created;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        this.disposed = true;
    }
}

function rawSandbox(id: string) {
    return {
        id,
        state: 'started',
        recoverable: true,
        createdAt: '2026-01-01',
        updatedAt: undefined as string | undefined,
        lastActivityAt: undefined as string | undefined,
        process: {
            executeCommand: jest.fn(async () => ({ exitCode: 0, result: 'out' })),
        },
        fs: {
            downloadFile: jest.fn(async () => Buffer.from([1, 2])),
            uploadFile: jest.fn(async () => undefined),
        },
        getWorkDir: jest.fn(async (): Promise<string | undefined> => '/workspace'),
        getUserHomeDir: jest.fn(async (): Promise<string | undefined> => '/home/daytona'),
        start: jest.fn(async () => undefined),
        recover: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
        waitUntilStarted: jest.fn(async () => undefined),
        waitUntilStopped: jest.fn(async () => undefined),
        refreshData: jest.fn(async () => undefined),
    };
}
