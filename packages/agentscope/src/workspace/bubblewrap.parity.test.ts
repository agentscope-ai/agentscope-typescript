import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ExecResult } from '../tool';
import {
    BUBBLEWRAP_CACHE_DIR,
    BUBBLEWRAP_TMPDIR,
    BUBBLEWRAP_WORKDIR,
    BubblewrapBackend,
    BubblewrapWorkspace,
    type BubblewrapWorkspaceOptions,
} from './bubblewrap';

/* eslint-disable jsdoc/require-jsdoc */

describe('BubblewrapBackend Python parity', () => {
    let root: string;
    let workdir: string;
    let tmpdir: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-bwrap-test-'));
        workdir = path.join(root, 'work');
        tmpdir = path.join(root, 'tmp');
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test('builds isolated argv with controlled mounts, environment, cwd, and argv', () => {
        const cache = path.join(root, 'cache');
        const backend = new BubblewrapBackend({
            hostWorkdir: workdir,
            hostTmpdir: tmpdir,
            hostCacheDir: cache,
            env: {
                HOME: '/unsafe-home',
                PATH: '/unsafe-path',
                API_KEY: 'allowed',
            },
        });
        const argv = backend.buildArgv(['echo', 'a b $(touch nope)'], '/tmp');

        expect(argv).toEqual(
            expect.arrayContaining([
                '--die-with-parent',
                '--new-session',
                '--unshare-all',
                '--share-net',
                '--clearenv',
                '--bind',
                BUBBLEWRAP_WORKDIR,
                BUBBLEWRAP_TMPDIR,
                BUBBLEWRAP_CACHE_DIR,
            ])
        );
        expect(argv.slice(-3)).toEqual(['--', 'echo', 'a b $(touch nope)']);
        expect(argv.includes('/opt')).toBe(false);
        expect(environmentFrom(argv)).toEqual(
            expect.objectContaining({
                HOME: BUBBLEWRAP_WORKDIR,
                TMPDIR: BUBBLEWRAP_TMPDIR,
                UV_CACHE_DIR: `${BUBBLEWRAP_CACHE_DIR}/uv`,
                PWD: '/tmp',
                API_KEY: 'allowed',
            })
        );
        expect(environmentFrom(argv).PATH).toContain('/workspace/.agentscope/.venv/bin');
    });

    test('can leave networking unshared at the backend layer', () => {
        const backend = new BubblewrapBackend({
            hostWorkdir: workdir,
            hostTmpdir: tmpdir,
            shareNet: false,
        });

        expect(backend.buildArgv(['true'])).toContain('--unshare-all');
        expect(backend.buildArgv(['true'])).not.toContain('--share-net');
    });

    test('rejects empty and overlapping mount sources', () => {
        expect(() => new BubblewrapBackend({ hostWorkdir: '', hostTmpdir: tmpdir })).toThrow(
            'hostWorkdir must not be empty'
        );
        expect(() => new BubblewrapBackend({ hostWorkdir: workdir, hostTmpdir: ' ' })).toThrow(
            'hostTmpdir must not be empty'
        );
        expect(
            () =>
                new BubblewrapBackend({
                    hostWorkdir: workdir,
                    hostTmpdir: path.join(workdir, 'tmp'),
                })
        ).toThrow('must not overlap');
        expect(
            () =>
                new BubblewrapBackend({
                    hostWorkdir: workdir,
                    hostTmpdir: tmpdir,
                    hostCacheDir: path.join(workdir, 'cache'),
                })
        ).toThrow('must not overlap');
    });

    test('creates new mount sources with private permissions', async () => {
        const cache = path.join(root, 'cache');
        new BubblewrapBackend({
            hostWorkdir: workdir,
            hostTmpdir: tmpdir,
            hostCacheDir: cache,
        });

        if (process.platform !== 'win32') {
            for (const directory of [workdir, tmpdir, cache]) {
                expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
            }
        }
    });

    test('detects replacement of a validated bind source before execution', async () => {
        const backend = new BubblewrapBackend({ hostWorkdir: workdir, hostTmpdir: tmpdir });
        const moved = path.join(root, 'moved');
        await fs.rename(workdir, moved);
        await fs.mkdir(workdir);

        expect(() => backend.buildArgv(['true'])).toThrow('replaced before execution');
    });

    test('maps native file operations only into writable sandbox mounts', async () => {
        const backend = new BubblewrapBackend({ hostWorkdir: workdir, hostTmpdir: tmpdir });
        const payload = Buffer.from([0, 1, 2, 255]);

        await backend.writeFile('/workspace/a/b/file.bin', payload);
        await backend.writeFile('/tmp/temporary.txt', Buffer.from('tmp'));

        expect(await backend.readFile('/workspace/a/b/file.bin')).toEqual(payload);
        expect(await backend.fileExists('/tmp/temporary.txt')).toBe(true);
        expect(await backend.isDirectory('/workspace/a')).toBe(true);
        expect(await backend.listDirectory('/workspace/a/b')).toEqual(['file.bin']);
        expect(await backend.listDirectory('/workspace', true)).toEqual([
            '/workspace/a/b/file.bin',
        ]);
        expect(await backend.stat('/workspace/a/b/file.bin')).toEqual(
            expect.objectContaining({ name: 'file.bin', isDir: false, sizeBytes: 4 })
        );
        await backend.deletePath('/workspace/a');
        expect(await backend.fileExists('/workspace/a')).toBe(false);
        await expect(backend.writeFile('relative.txt', payload)).rejects.toThrow('absolute');
        await expect(backend.writeFile('/etc/hosts', payload)).rejects.toThrow(
            'limited to /workspace and /tmp'
        );
        await expect(backend.deletePath('/workspace')).rejects.toThrow('mount root');
    });

    test('maps the nested sandbox cache mount to its distinct host source', async () => {
        const cache = path.join(root, 'cache');
        const backend = new BubblewrapBackend({
            hostWorkdir: workdir,
            hostTmpdir: tmpdir,
            hostCacheDir: cache,
        });

        await backend.writeFile(`${BUBBLEWRAP_CACHE_DIR}/uv/archive`, Buffer.from('cached'));

        expect(await fs.readFile(path.join(cache, 'uv', 'archive'), 'utf8')).toBe('cached');
        await expect(fs.stat(path.join(tmpdir, '.agentscope-cache'))).rejects.toThrow();
    });

    test('rejects symlink writes and mount escapes while allowing safe reads', async () => {
        const backend = new BubblewrapBackend({ hostWorkdir: workdir, hostTmpdir: tmpdir });
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(workdir, 'real.txt'), 'inside');
        await fs.symlink('real.txt', path.join(workdir, 'safe-link'));
        await fs.symlink(outside, path.join(workdir, 'escape'));
        await fs.symlink(path.join(outside, 'created.txt'), path.join(workdir, 'dangling'));

        expect(await backend.readFile('/workspace/safe-link')).toEqual(Buffer.from('inside'));
        await expect(backend.writeFile('/workspace/safe-link', Buffer.from('x'))).rejects.toThrow(
            'symbolic-link write'
        );
        await expect(
            backend.writeFile('/workspace/escape/created.txt', Buffer.from('x'))
        ).rejects.toThrow('escapes writable');
        await expect(backend.writeFile('/workspace/dangling', Buffer.from('x'))).rejects.toThrow(
            'symbolic-link write'
        );
        await expect(fs.stat(path.join(outside, 'created.txt'))).rejects.toThrow();
    });
});

describe('BubblewrapWorkspace Python parity', () => {
    test('renders instructions and preserves configured persistence semantics', async () => {
        const ephemeral = new InspectableBubblewrapWorkspace({
            workspaceId: 'ephemeral',
            instructions: 'Workdir: {workdir}',
        });
        const persistent = new InspectableBubblewrapWorkspace({
            workspaceId: 'persistent',
            hostWorkdir: path.join(os.tmpdir(), 'not-created-by-constructor'),
        });

        expect(await ephemeral.getInstructions()).toBe('Workdir: /workspace');
        expect(ephemeral.isPersistent).toBe(false);
        expect(ephemeral.gatewayPort).toBeNull();
        expect(persistent.isPersistent).toBe(true);
        expect(await persistent.getInstructions()).toEqual(
            expect.stringContaining('Bubblewrap-based Linux workspace')
        );
    });

    test('validates workspace network, paths, and fixed gateway ports', () => {
        expect(() => new BubblewrapWorkspace({ shareNet: false })).toThrow('shareNet=true');
        expect(() => new BubblewrapWorkspace({ hostWorkdir: '' })).toThrow(
            'hostWorkdir must not be empty'
        );
        expect(() => new BubblewrapWorkspace({ hostCacheDir: ' ' })).toThrow(
            'hostCacheDir must not be empty'
        );
        for (const gatewayPort of [0, -1, 65536, 1.5]) {
            expect(() => new BubblewrapWorkspace({ gatewayPort })).toThrow(
                'integer from 1 to 65535'
            );
        }
        expect(new BubblewrapWorkspace({ gatewayPort: 5600 }).gatewayPort).toBe(5600);
    });

    test('allocates loopback ports and rotates per-launch credentials', async () => {
        const first = await BubblewrapWorkspace.allocateGatewayPort();
        const second = await BubblewrapWorkspace.allocateGatewayPort();
        const workspace = new InspectableBubblewrapWorkspace();
        const before = workspace.credentials();
        workspace.rotateGatewayCredentials();
        const after = workspace.credentials();

        expect(first).toBeGreaterThan(0);
        expect(second).toBeGreaterThan(0);
        expect(before.token).toHaveLength(43);
        expect(before.nonce).toHaveLength(43);
        expect(after).not.toEqual(before);
    });

    test('uses repairable uv and official checksum-pinned ripgrep bootstrap', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-bootstrap-test-'));
        try {
            const workspace = new InspectableBubblewrapWorkspace({
                extraPip: ['numpy==2.0.0'],
            });
            workspace.bind(
                new BubblewrapBackend({
                    hostWorkdir: path.join(root, 'work'),
                    hostTmpdir: path.join(root, 'tmp'),
                })
            );
            const commands = workspace.commands();

            expect(commands).toHaveLength(7);
            expect(commands.join('\n')).toContain('https://astral.sh/uv/install.sh');
            expect(commands.join('\n')).toContain(
                'https://github.com/BurntSushi/ripgrep/releases/download/14.1.0'
            );
            expect(commands.join('\n')).toContain('sha256sum -c');
            expect(commands.join('\n')).toContain("'mcp<2.0.0'");
            expect(commands.join('\n')).toContain("'numpy==2.0.0'");
            expect(commands.at(-1)).toContain("--no-deps 'agentscope'");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test('checks every persisted bootstrap artifact before reusing it', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-ready-test-'));
        try {
            const backend = new RecordingBubblewrapBackend({
                hostWorkdir: path.join(root, 'work'),
                hostTmpdir: path.join(root, 'tmp'),
            });
            const workspace = new InspectableBubblewrapWorkspace();
            workspace.bind(backend);

            await expect(workspace.ready()).resolves.toBe(true);
            expect(backend.commands).toEqual([
                expect.arrayContaining([
                    '/workspace/.agentscope/_mcp_gateway_app.py',
                    '/workspace/.agentscope/.venv/bin/python',
                    '/workspace/.agentscope/bin/uv',
                    '/workspace/.agentscope/bin/rg',
                ]),
            ]);
            expect(backend.options).toEqual([{ timeout: 30 }]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

class InspectableBubblewrapWorkspace extends BubblewrapWorkspace {
    constructor(options: BubblewrapWorkspaceOptions = {}) {
        super(options);
    }

    commands(): string[] {
        return this.bootstrapCommands();
    }

    credentials(): { token: string | null; nonce: string | null } {
        return { token: this.gatewayAuthToken, nonce: this.gatewayInstanceNonce };
    }

    bind(backend: BubblewrapBackend): void {
        this.backend = backend;
    }

    async ready(): Promise<boolean> {
        return this.bootstrapIsReady();
    }
}

class RecordingBubblewrapBackend extends BubblewrapBackend {
    readonly commands: string[][] = [];
    readonly options: Array<{ cwd?: string; timeout?: number; signal?: AbortSignal }> = [];

    override async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        this.commands.push(command);
        this.options.push(options);
        return new ExecResult({ exitCode: 0 });
    }
}

function environmentFrom(argv: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    argv.forEach((item, index) => {
        if (item === '--setenv') result[argv[index + 1]] = argv[index + 2];
    });
    return result;
}
