/* eslint-disable jsdoc/require-jsdoc */

import type { LocalWorkspace, WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import type { StorageBase } from '../src/storage';
import {
    LocalWorkspaceManager,
    PrewarmedWorkspaceManager,
    WorkspaceManagerBase,
} from '../src/workspace-manager';

class AssignmentManager extends WorkspaceManagerBase {
    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('unused');
    }

    async close(): Promise<void> {}

    async closeAll(): Promise<void> {}
}

interface FakeWorkspace {
    workspaceId: string;
    closed: boolean;
    initialize(): Promise<void>;
    close(): Promise<void>;
}

function fakeWorkspace(workspaceId: string): FakeWorkspace {
    return {
        workspaceId,
        closed: false,
        async initialize() {},
        async close() {
            this.closed = true;
        },
    };
}

class PrewarmManager extends PrewarmedWorkspaceManager<WorkspaceBase> {
    readonly builtWorkspaces: FakeWorkspace[] = [];
    readonly adopted: string[] = [];
    providerActiveCreates = 0;
    providerPeakCreates = 0;
    failBuilds = 0;
    buildDelayMs = 0;
    private sequence = 0;

    start(): void {
        this.startPrewarm();
    }

    stop(): Promise<void> {
        return this.stopPrewarm();
    }

    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('unused');
    }

    async close(): Promise<void> {}

    async closeAll(): Promise<void> {}

    protected async createPrewarmed(): Promise<WorkspaceBase> {
        this.providerActiveCreates += 1;
        this.providerPeakCreates = Math.max(this.providerPeakCreates, this.providerActiveCreates);
        try {
            await new Promise(resolve => setTimeout(resolve, this.buildDelayMs));
            if (this.failBuilds > 0) {
                this.failBuilds -= 1;
                throw new Error('provider down');
            }
            const workspace = fakeWorkspace(`workspace-${this.sequence}`);
            this.sequence += 1;
            this.builtWorkspaces.push(workspace);
            return workspace as unknown as WorkspaceBase;
        } finally {
            this.providerActiveCreates -= 1;
        }
    }

    protected async adoptPrewarmed(workspace: WorkspaceBase): Promise<void> {
        this.adopted.push(workspace.workspaceId);
    }
}

describe('WorkspaceManagerBase isolation', () => {
    test('matches Python BLAKE2b ids for per-user isolation', async () => {
        const manager = new AssignmentManager({ isolation: 'per_user' });
        expect(
            await manager.assignWorkspaceId({ userId: 'alice', agentId: 'a1', sessionId: 's1' })
        ).toBe('982aa9b33217069a');
        expect(
            await manager.assignWorkspaceId({ userId: 'bob', agentId: 'a2', sessionId: 's2' })
        ).toBe('883053c3e4594c5b');
    });

    test('uses deterministic per-agent ids without storage', async () => {
        const manager = new AssignmentManager({ isolation: 'per_agent' });
        const first = await manager.assignWorkspaceId({
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        const second = await manager.assignWorkspaceId({
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-2',
        });
        expect(second).toBe(first);
    });

    test('reuses storage bindings and reserves concurrent first assignments', async () => {
        const manager = new AssignmentManager({ isolation: 'per_agent' });
        let storedBinding = '';
        manager.bindStorage({
            async listSessions() {
                return storedBinding
                    ? ([{ config: { workspace_id: storedBinding } }] as never)
                    : [];
            },
        } as unknown as StorageBase);

        const assigned = await Promise.all([
            manager.assignWorkspaceId({
                userId: 'user-1',
                agentId: 'agent-1',
                sessionId: 'session-1',
            }),
            manager.assignWorkspaceId({
                userId: 'user-1',
                agentId: 'agent-1',
                sessionId: 'session-2',
            }),
        ]);
        expect(assigned[1]).toBe(assigned[0]);
        storedBinding = 'persisted-workspace';
        expect(
            await manager.assignWorkspaceId({
                userId: 'user-1',
                agentId: 'agent-1',
                sessionId: 'session-3',
            })
        ).toBe('persisted-workspace');
    });
});

describe('PrewarmedWorkspaceManager', () => {
    test('fills, hands out, and refills its buffer', async () => {
        const manager = new PrewarmManager({ isolation: 'per_session', prewarm: { size: 2 } });
        manager.start();
        await new Promise(resolve => setTimeout(resolve, 20));
        const id = await manager.assignWorkspaceId({
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(id).toBe('workspace-0');
        expect(manager.adopted).toEqual(['workspace-0']);
        expect(manager.builtWorkspaces.map(workspace => workspace.workspaceId)).toEqual([
            'workspace-0',
            'workspace-1',
            'workspace-2',
        ]);
        await manager.stop();
        expect(manager.builtWorkspaces.slice(1).every(workspace => workspace.closed)).toBe(true);
    });

    test('bounds concurrent burst provisioning', async () => {
        const manager = new PrewarmManager({
            isolation: 'per_session',
            prewarm: { size: 2, maxCreating: 3 },
        });
        manager.buildDelayMs = 10;
        manager.start();
        const ids = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                manager.assignWorkspaceId({
                    userId: 'user-1',
                    agentId: 'agent-1',
                    sessionId: `session-${index}`,
                })
            )
        );
        expect(new Set(ids).size).toBe(8);
        expect(manager.providerPeakCreates).toBeLessThanOrEqual(3);
        await manager.stop();
    });

    test('falls back after provider build failure', async () => {
        const manager = new PrewarmManager({
            isolation: 'per_session',
            prewarm: { size: 1 },
        });
        manager.failBuilds = 2;
        manager.start();
        const id = await manager.assignWorkspaceId({
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        expect(id).toMatch(/^[a-f0-9]{32}$/);
        expect(manager.adopted).toEqual([]);
        await manager.stop();
    });

    test('propagates cancellation and disposes the eventual build', async () => {
        const manager = new PrewarmManager({
            isolation: 'per_session',
            prewarm: { size: 1 },
        });
        manager.buildDelayMs = 30;
        manager.start();
        const controller = new AbortController();
        const assignment = manager.assignWorkspaceId({
            userId: 'user-1',
            agentId: 'agent-1',
            sessionId: 'session-1',
            signal: controller.signal,
        });
        controller.abort();
        await expect(assignment).rejects.toMatchObject({ name: 'AbortError' });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(manager.builtWorkspaces[0].closed).toBe(true);
        await manager.stop();
    });
});

describe('LocalWorkspaceManager', () => {
    test('derives empty bindings from the real user and reuses cache entries', async () => {
        const created: FakeWorkspace[] = [];
        const manager = new LocalWorkspaceManager({
            baseDirectory: '/tmp/agentscope-local-manager',
            isolation: 'per_user',
            workspaceFactory: options => {
                const workspace = fakeWorkspace(options.workspaceId!);
                created.push(workspace);
                return workspace as unknown as LocalWorkspace;
            },
        });
        const alice = await manager.getWorkspace('alice', 'agent-1', 'session-1', '');
        const aliceAgain = await manager.getWorkspace('alice', 'agent-1', 'session-2', '');
        const bob = await manager.getWorkspace('bob', 'agent-2', 'session-3', '');
        expect(alice).toBe(aliceAgain);
        expect(alice.workspaceId).toBe('982aa9b33217069a');
        expect(bob.workspaceId).toBe('883053c3e4594c5b');
        expect(created).toHaveLength(2);
        await manager.closeAll();
        expect(created.every(workspace => workspace.closed)).toBe(true);
    });

    test('coalesces cache misses and evicts expired workspaces', async () => {
        const created: FakeWorkspace[] = [];
        const manager = new LocalWorkspaceManager({
            baseDirectory: '/tmp/agentscope-local-manager',
            ttlMs: 1,
            workspaceFactory: options => {
                const workspace = fakeWorkspace(options.workspaceId!);
                created.push(workspace);
                return workspace as unknown as LocalWorkspace;
            },
        });
        const concurrent = await Promise.all([
            manager.getWorkspace('user-1', 'agent-1', 'session-1', 'workspace-1'),
            manager.getWorkspace('user-1', 'agent-1', 'session-2', 'workspace-1'),
        ]);
        expect(concurrent[0]).toBe(concurrent[1]);
        expect(created).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 5));
        const replacement = await manager.getWorkspace(
            'user-1',
            'agent-1',
            'session-3',
            'workspace-1'
        );
        expect(replacement).not.toBe(concurrent[0]);
        expect(created[0].closed).toBe(true);
        await manager.close('workspace-1');
        expect(created[1].closed).toBe(true);
    });

    test('replaces skill seeds and invalidates cached workspaces', async () => {
        const created: FakeWorkspace[] = [];
        const receivedSkillPaths: string[][] = [];
        const manager = new LocalWorkspaceManager({
            baseDirectory: '/tmp/agentscope-local-manager',
            skillPaths: ['initial-skill'],
            workspaceFactory: options => {
                const workspace = fakeWorkspace(options.workspaceId!);
                created.push(workspace);
                receivedSkillPaths.push(options.skillPaths ?? []);
                return workspace as unknown as LocalWorkspace;
            },
        });
        await manager.getWorkspace('user-1', 'agent-1', 'session-1', 'workspace-1');
        await manager.setSkillPaths(['replacement-skill']);
        await manager.getWorkspace('user-1', 'agent-1', 'session-1', 'workspace-1');

        expect(created).toHaveLength(2);
        expect(created[0].closed).toBe(true);
        expect(receivedSkillPaths).toEqual([
            [expect.stringMatching(/initial-skill$/)],
            [expect.stringMatching(/replacement-skill$/)],
        ]);
        await manager.closeAll();
    });
});
