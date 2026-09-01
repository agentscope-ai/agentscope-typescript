/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
    AppleContainerWorkspace,
    AppleContainerWorkspaceOptions,
    BubblewrapWorkspace,
    BubblewrapWorkspaceOptions,
    DaytonaWorkspace,
    DaytonaWorkspaceOptions,
    DockerWorkspace,
    DockerWorkspaceOptions,
    E2BWorkspace,
    E2BWorkspaceOptions,
    K8sWorkspace,
    K8sWorkspaceOptions,
    OpenSandboxWorkspace,
    OpenSandboxWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import {
    AppleContainerWorkspaceManager,
    blake2bHex,
    BubblewrapWorkspaceManager,
    DaytonaWorkspaceManager,
    DockerWorkspaceManager,
    E2BWorkspaceManager,
    K8sWorkspaceManager,
    OpenSandboxWorkspaceManager,
} from '../src/workspace-manager';

class FakeWorkspace<TOptions extends { workspaceId?: string }> {
    private static sequence = 0;
    readonly workspaceId: string;
    readonly options: TOptions;
    initialized = false;
    closed = false;
    destroyed = false;
    failInitialize = false;

    constructor(options: TOptions) {
        this.options = options;
        this.workspaceId = options.workspaceId ?? `generated-${FakeWorkspace.sequence++}`;
    }

    async initialize(): Promise<void> {
        await Promise.resolve();
        if (this.failInitialize) throw new Error('gateway bootstrap failed');
        this.initialized = true;
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
    }
}

function makeFactory<TOptions extends { workspaceId?: string }, TWorkspace>() {
    const created: Array<FakeWorkspace<TOptions>> = [];
    const factory = (options: TOptions): TWorkspace => {
        const workspace = new FakeWorkspace(options);
        created.push(workspace);
        return workspace as unknown as TWorkspace;
    };
    return { created, factory };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for workspace manager state.');
}

describe('remote workspace manager shared cache contract', () => {
    test('coalesces concurrent misses and keys explicit ids globally', async () => {
        const { created, factory } = makeFactory<DaytonaWorkspaceOptions, DaytonaWorkspace>();
        const manager = new DaytonaWorkspaceManager({ workspaceFactory: factory });

        const workspaces = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                manager.getWorkspace('user', 'agent', `session-${index}`, 'shared')
            )
        );

        expect(created).toHaveLength(1);
        expect(workspaces.every(workspace => workspace === workspaces[0])).toBe(true);
        expect(created[0].initialized).toBe(true);
    });

    test('treats an empty id as missing and follows the isolation policy', async () => {
        const { created, factory } = makeFactory<DaytonaWorkspaceOptions, DaytonaWorkspace>();
        const manager = new DaytonaWorkspaceManager({ workspaceFactory: factory });

        await manager.getWorkspace('alice', 'agent', 'session', '');
        await manager.getWorkspace('bob', 'agent', 'session', '');

        expect(created.map(workspace => workspace.workspaceId)).toEqual([
            '0c4d1df9d1a23134',
            'b44d800c5b03085e',
        ]);
    });

    test('close, closeAll, and TTL sweeping evict and close entries', async () => {
        const { created, factory } = makeFactory<DaytonaWorkspaceOptions, DaytonaWorkspace>();
        const manager = new DaytonaWorkspaceManager({ ttlMs: 0, workspaceFactory: factory });
        await manager.getWorkspace('user', 'agent', 'session', 'first');
        await manager.close('first');
        await manager.getWorkspace('user', 'agent', 'session', 'second');
        await new Promise(resolve => setTimeout(resolve, 2));
        await manager.sweepOnce();
        await manager.getWorkspace('user', 'agent', 'session', 'third');
        await manager.closeAll();

        expect(created.map(workspace => workspace.closed)).toEqual([true, true, true]);
    });

    test('close errors do not break manager shutdown', async () => {
        const { factory } = makeFactory<DaytonaWorkspaceOptions, DaytonaWorkspace>();
        const manager = new DaytonaWorkspaceManager({
            workspaceFactory: options => {
                const workspace = factory(
                    options
                ) as unknown as FakeWorkspace<DaytonaWorkspaceOptions>;
                workspace.close = async () => {
                    throw new Error('provider close failed');
                };
                return workspace as unknown as DaytonaWorkspace;
            },
        });
        await manager.getWorkspace('user', 'agent', 'session', 'workspace');

        await expect(manager.closeManager()).resolves.toBeUndefined();
    });
});

describe('provider option forwarding', () => {
    test('Apple Container forwards Python defaults and custom resources', async () => {
        const { created, factory } = makeFactory<
            AppleContainerWorkspaceOptions,
            AppleContainerWorkspace
        >();
        const manager = new AppleContainerWorkspaceManager({
            baseImage: 'ubuntu:latest',
            cpus: 4,
            memory: '8G',
            gatewayPort: 9999,
            workspaceFactory: factory,
        });
        await manager.getWorkspace('user', 'agent', 'session', 'workspace');

        expect(created[0].options).toMatchObject({
            workspaceId: 'workspace',
            baseImage: 'ubuntu:latest',
            cpus: 4,
            memory: '8G',
            gatewayPort: 9999,
            env: {},
            extraPip: [],
            defaultMcps: [],
            skillPaths: [],
        });
    });

    test('Daytona forwards config and owner metadata with custom overrides', async () => {
        const { created, factory } = makeFactory<DaytonaWorkspaceOptions, DaytonaWorkspace>();
        const manager = new DaytonaWorkspaceManager({
            apiKey: 'key',
            apiUrl: 'https://daytona.example/api',
            target: 'us',
            env: { A: 'B' },
            sandboxMetadata: { team: 'agents', 'agentscope.agent.id': 'override' },
            extraPip: ['x'],
            osUser: 'daytona',
            workspaceFactory: factory,
        });
        await manager.getWorkspace('u1', 'a1', 's1', 'wid');

        expect(created[0].options).toEqual({
            workspaceId: 'wid',
            apiKey: 'key',
            apiUrl: 'https://daytona.example/api',
            target: 'us',
            timeoutSeconds: 300,
            gatewayPort: 5600,
            env: { A: 'B' },
            sandboxMetadata: {
                'agentscope.user.id': 'u1',
                'agentscope.agent.id': 'override',
                team: 'agents',
            },
            extraPip: ['x'],
            defaultMcps: [],
            skillPaths: [],
            osUser: 'daytona',
        });
    });

    test('Kubernetes and OpenSandbox forward their complete provider surfaces', async () => {
        const k8s = makeFactory<K8sWorkspaceOptions, K8sWorkspace>();
        const k8sManager = new K8sWorkspaceManager({
            namespace: 'workspaces',
            imagePullSecrets: ['registry'],
            resources: { limits: { cpu: '2' } },
            deletePvcOnClose: true,
            workspaceFactory: k8s.factory,
        });
        await k8sManager.getWorkspace('user', 'agent', 'session', 'k8s-id');
        expect(k8s.created[0].options).toMatchObject({
            workspaceId: 'k8s-id',
            namespace: 'workspaces',
            image: 'python:3.11-slim',
            imagePullPolicy: 'IfNotPresent',
            imagePullSecrets: ['registry'],
            resources: { limits: { cpu: '2' } },
            storageSize: '1Gi',
            deletePvcOnClose: true,
        });

        const open = makeFactory<OpenSandboxWorkspaceOptions, OpenSandboxWorkspace>();
        const openManager = new OpenSandboxWorkspaceManager({
            protocol: 'https',
            resource: { cpu: '2' },
            entrypoint: ['sleep', 'infinity'],
            networkPolicy: { egress: 'deny' },
            sandboxMetadata: { team: 'runtime' },
            workspaceFactory: open.factory,
        });
        await openManager.getWorkspace('user', 'agent', 'session', 'open-id');
        expect(open.created[0].options).toMatchObject({
            workspaceId: 'open-id',
            protocol: 'https',
            requestTimeoutSeconds: 600,
            resource: { cpu: '2' },
            entrypoint: ['sleep', 'infinity'],
            networkPolicy: { egress: 'deny' },
            sandboxMetadata: {
                'agentscope.user.id': 'user',
                'agentscope.agent.id': 'agent',
                team: 'runtime',
            },
        });
    });
});

describe('filesystem-backed remote managers', () => {
    let baseDirectory: string;

    beforeEach(async () => {
        baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-manager-'));
    });

    afterEach(async () => {
        await fs.rm(baseDirectory, { recursive: true, force: true });
    });

    test('Bubblewrap uses Python-compatible hashed components', async () => {
        const { created, factory } = makeFactory<BubblewrapWorkspaceOptions, BubblewrapWorkspace>();
        const manager = new BubblewrapWorkspaceManager({
            baseDirectory,
            workspaceFactory: factory,
        });
        await manager.getWorkspace('u1', 'agent', 'session', 'fixed-id');

        expect(blake2bHex('u1', 16)).toBe('53199585bddea28e67fe7143a42baef7');
        expect(created[0].options.hostWorkdir).toBe(
            path.join(
                baseDirectory,
                '53199585bddea28e67fe7143a42baef7',
                '10708bded228e50abbf6a22df8344d19'
            )
        );
        expect((await fs.stat(created[0].options.hostWorkdir!)).isDirectory()).toBe(true);
    });

    test('Docker rejects escaping ids and preserves the legacy workdir', async () => {
        const { created, factory } = makeFactory<DockerWorkspaceOptions, DockerWorkspace>();
        const legacy = path.join(baseDirectory, 'user', 'agent');
        await fs.mkdir(legacy, { recursive: true });
        const manager = new DockerWorkspaceManager({
            baseDirectory,
            workspaceFactory: factory,
        });

        expect(() => manager.workdirFor('../../etc')).toThrow('escapes baseDirectory');
        expect(() => manager.workdirFor('/etc')).toThrow('escapes baseDirectory');
        await manager.getWorkspace('user', 'agent', 'session', 'fixed-id');
        expect(created[0].options).toMatchObject({
            workspaceId: 'fixed-id',
            hostWorkdir: legacy,
            baseImage: 'python:3.11-slim',
            nodeVersion: '20',
        });
    });

    test('Docker adopts a prewarmed workspace and closes buffer plus cache', async () => {
        const { created, factory } = makeFactory<DockerWorkspaceOptions, DockerWorkspace>();
        const manager = new DockerWorkspaceManager({
            baseDirectory,
            isolation: 'per_session',
            prewarm: { size: 1 },
            workspaceFactory: factory,
        });
        await manager.open();
        await waitFor(() => created.length === 1 && created[0].initialized);
        const prewarmed = created[0];

        const workspaceId = await manager.assignWorkspaceId({
            userId: 'user',
            agentId: 'agent',
            sessionId: 'session',
        });
        const workspace = await manager.getWorkspace('user', 'agent', 'session', workspaceId);
        expect(workspace).toBe(prewarmed as unknown as DockerWorkspace);
        expect(prewarmed.options.hostWorkdir).toBe(path.join(baseDirectory, workspaceId));
        await waitFor(() => created.length === 2);
        await manager.closeManager();
        expect(created.map(item => item.closed)).toEqual([true, true]);
    });
});

describe('E2B prewarm lifecycle', () => {
    test('adopts claimed sandboxes and destroys only the replacement buffer', async () => {
        const { created, factory } = makeFactory<E2BWorkspaceOptions, E2BWorkspace>();
        const manager = new E2BWorkspaceManager({
            isolation: 'per_session',
            prewarm: { size: 1 },
            workspaceFactory: factory,
        });
        await manager.open();
        await waitFor(() => created.length === 1 && created[0].initialized);
        const claimed = created[0];
        const workspaceId = await manager.assignWorkspaceId({
            userId: 'user',
            agentId: 'agent',
            sessionId: 'session',
        });
        expect(await manager.getWorkspace('user', 'agent', 'session', workspaceId)).toBe(
            claimed as unknown as E2BWorkspace
        );
        await waitFor(() => created.length === 2);

        await manager.closeManager();

        expect(claimed.closed).toBe(true);
        expect(claimed.destroyed).toBe(false);
        expect(created[1].destroyed).toBe(true);
    });

    test('destroys a half-built sandbox when initialization fails', async () => {
        const { created, factory } = makeFactory<E2BWorkspaceOptions, E2BWorkspace>();
        const manager = new E2BWorkspaceManager({
            workspaceFactory: options => {
                const workspace = factory(options) as unknown as FakeWorkspace<E2BWorkspaceOptions>;
                workspace.failInitialize = true;
                return workspace as unknown as E2BWorkspace;
            },
        });

        await expect(manager.getWorkspace('user', 'agent', 'session', 'workspace')).rejects.toThrow(
            'gateway bootstrap failed'
        );
        expect(created).toHaveLength(1);
        expect(created[0].destroyed).toBe(true);
    });

    test('falls back to close when permanent cleanup fails', async () => {
        const { created, factory } = makeFactory<E2BWorkspaceOptions, E2BWorkspace>();
        const manager = new E2BWorkspaceManager({
            prewarm: { size: 1 },
            workspaceFactory: options => {
                const workspace = factory(options) as unknown as FakeWorkspace<E2BWorkspaceOptions>;
                workspace.destroy = async () => {
                    throw new Error('kill failed');
                };
                return workspace as unknown as E2BWorkspace;
            },
        });
        await manager.open();
        await waitFor(() => created.length === 1 && created[0].initialized);

        await manager.closeManager();

        expect(created[0].closed).toBe(true);
    });
});
