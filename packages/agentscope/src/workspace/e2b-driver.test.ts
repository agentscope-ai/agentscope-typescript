/* eslint-disable jsdoc/require-jsdoc */

describe('E2B SDK driver', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    afterEach(() => {
        jest.dontMock('e2b');
    });

    test('paginates listings and translates public seconds to SDK milliseconds', async () => {
        const first = rawSandbox('connected');
        const second = rawSandbox('created');
        const pages = [
            [{ sandboxId: 'one', startedAt: new Date('2026-01-01') }],
            [{ sandboxId: 'two', startedAt: new Date('2026-02-01') }],
        ];
        let nextPage = 0;
        const raw = {
            list: jest.fn(() => ({
                get hasNext(): boolean {
                    return nextPage < pages.length;
                },
                nextItems: jest.fn(async () => pages[nextPage++]),
            })),
            connect: jest.fn(async () => first),
            create: jest.fn(async () => second),
        };
        jest.doMock('e2b', () => ({ Sandbox: raw }));
        const { createE2BClient } = await import('./e2b-driver');
        const client = await createE2BClient();

        await expect(
            client.list({
                metadata: { 'agentscope.workspace.id': 'workspace' },
                state: ['paused', 'running'],
                apiKey: 'key',
                domain: 'domain',
            })
        ).resolves.toEqual({ sandboxes: pages.flat() });
        expect(raw.list).toHaveBeenCalledWith({
            query: {
                metadata: { 'agentscope.workspace.id': 'workspace' },
                state: ['paused', 'running'],
            },
            apiKey: 'key',
            domain: 'domain',
        });

        const connected = await client.connect('connected', {
            timeoutSeconds: 2.5,
            apiKey: 'key',
        });
        expect(raw.connect).toHaveBeenCalledWith('connected', {
            timeoutMs: 2500,
            apiKey: 'key',
        });
        expect(connected.sandboxId).toBe('connected');

        const created = await client.create({
            template: 'template',
            timeoutSeconds: 42,
            metadata: { project: 'demo' },
            env: { FOO: 'bar' },
            domain: 'domain',
        });
        expect(raw.create).toHaveBeenCalledWith('template', {
            timeoutMs: 42000,
            metadata: { project: 'demo' },
            envs: { FOO: 'bar' },
            domain: 'domain',
        });
        expect(created.sandboxId).toBe('created');
    });

    test('adapts command, filesystem, readiness, and pause operations', async () => {
        const raw = rawSandbox('sandbox');
        const sdk = {
            list: jest.fn(() => ({ hasNext: false, nextItems: jest.fn() })),
            connect: jest.fn(async () => raw),
            create: jest.fn(async () => raw),
        };
        jest.doMock('e2b', () => ({ Sandbox: sdk }));
        const { createE2BClient } = await import('./e2b-driver');
        const client = await createE2BClient();
        const sandbox = await client.connect('sandbox', { timeoutSeconds: 300 });
        const controller = new AbortController();

        await expect(
            sandbox.run('echo hello', {
                cwd: '/workspace',
                timeoutSeconds: 1.5,
                signal: controller.signal,
            })
        ).resolves.toEqual({ exitCode: 0, stdout: 'out', stderr: '' });
        expect(raw.commands.run).toHaveBeenCalledWith('echo hello', {
            cwd: '/workspace',
            timeoutMs: 1500,
            signal: controller.signal,
        });
        await expect(sandbox.readFile('/file')).resolves.toEqual(Uint8Array.from([1, 2, 3]));
        await sandbox.writeFile('/file', Uint8Array.from([0, 255]));
        expect(raw.files.write).toHaveBeenCalledTimes(1);
        const writeCalls = raw.files.write.mock.calls as unknown as Array<[string, ArrayBuffer]>;
        expect(new Uint8Array(writeCalls[0][1])).toEqual(Uint8Array.from([0, 255]));
        await expect(sandbox.isRunning()).resolves.toBe(true);
        await expect(sandbox.pause()).resolves.toBe(true);
    });

    test('retains completed pages when a later listing page fails', async () => {
        const firstPage = [{ sandboxId: 'one', startedAt: new Date('2026-01-01') }];
        let call = 0;
        const sdk = {
            list: jest.fn(() => ({
                get hasNext(): boolean {
                    return call < 2;
                },
                nextItems: jest.fn(async () => {
                    call += 1;
                    if (call === 2) throw new Error('page failed');
                    return firstPage;
                }),
            })),
            connect: jest.fn(),
            create: jest.fn(),
        };
        jest.doMock('e2b', () => ({ Sandbox: sdk }));
        const { createE2BClient } = await import('./e2b-driver');
        const client = await createE2BClient();

        const result = await client.list({ metadata: {}, state: ['paused', 'running'] });

        expect(result.sandboxes).toEqual(firstPage);
        expect(result.error).toEqual(new Error('page failed'));
    });
});

function rawSandbox(sandboxId: string) {
    return {
        sandboxId,
        commands: {
            run: jest.fn(async () => ({ exitCode: 0, stdout: 'out', stderr: '' })),
        },
        files: {
            read: jest.fn(async () => Uint8Array.from([1, 2, 3])),
            write: jest.fn(async () => ({ path: '/file' })),
        },
        isRunning: jest.fn(async () => true),
        pause: jest.fn(async () => true),
    };
}
