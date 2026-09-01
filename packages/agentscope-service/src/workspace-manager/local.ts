/* eslint-disable jsdoc/require-jsdoc */

import * as path from 'node:path';

import type { MCPClient } from '@agentscope-ai/agentscope/mcp';
import { LocalWorkspace, LocalWorkspaceOptions } from '@agentscope-ai/agentscope/workspace';

import { WorkspaceManagerBase } from './base';
import type { IsolationPolicy } from './base';

interface CacheEntry {
    workspace: LocalWorkspace;
    lastAccess: number;
}

class AsyncMutex {
    private tail = Promise.resolve();

    async run<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release = (): void => {};
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }
}

export interface LocalWorkspaceManagerOptions {
    baseDirectory: string;
    isolation?: IsolationPolicy;
    defaultMcps?: MCPClient[];
    skillPaths?: string[];
    ttlMs?: number;
    workspaceFactory?: (options: LocalWorkspaceOptions) => LocalWorkspace;
}

/** Lazy local-workspace cache with idle TTL eviction. */
export class LocalWorkspaceManager extends WorkspaceManagerBase<LocalWorkspace> {
    readonly baseDirectory: string;
    readonly ttlMs: number;
    private readonly defaultMcps: MCPClient[];
    private readonly skillPaths: string[];
    private readonly workspaceFactory: (options: LocalWorkspaceOptions) => LocalWorkspace;
    private readonly cache = new Map<string, CacheEntry>();
    private readonly mutex = new AsyncMutex();

    constructor(options: LocalWorkspaceManagerOptions) {
        super({ isolation: options.isolation });
        this.baseDirectory = path.resolve(options.baseDirectory);
        this.defaultMcps = [...(options.defaultMcps ?? [])];
        this.skillPaths = [...(options.skillPaths ?? [])];
        this.ttlMs = options.ttlMs ?? 3_600_000;
        this.workspaceFactory = options.workspaceFactory ?? (input => new LocalWorkspace(input));
    }

    async getWorkspace(
        userId: string,
        agentId: string,
        sessionId: string,
        workspaceId?: string | null
    ): Promise<LocalWorkspace> {
        const binding =
            workspaceId || (await this.assignWorkspaceId({ userId, agentId, sessionId }));
        const now = Date.now();
        let hit: LocalWorkspace | null = null;
        const expired = await this.mutex.run(async () => {
            const stale = this.popExpired(now);
            const cached = this.cache.get(binding);
            if (cached) {
                cached.lastAccess = now;
                hit = cached.workspace;
            }
            return stale;
        });
        await Promise.allSettled(expired.map(workspace => this.safeClose(workspace)));
        if (hit) return hit;

        return this.mutex.run(async () => {
            const cached = this.cache.get(binding);
            if (cached) {
                cached.lastAccess = Date.now();
                return cached.workspace;
            }
            const workspace = this.workspaceFactory({
                workspaceId: binding,
                workdir: path.join(this.baseDirectory, agentId),
                defaultMcps: this.defaultMcps,
                skillPaths: this.skillPaths,
            });
            await workspace.initialize();
            this.cache.set(binding, { workspace, lastAccess: Date.now() });
            return workspace;
        });
    }

    async close(workspaceId: string): Promise<void> {
        const workspace = await this.mutex.run(async () => {
            const entry = this.cache.get(workspaceId);
            this.cache.delete(workspaceId);
            return entry?.workspace ?? null;
        });
        if (workspace) await this.safeClose(workspace);
    }

    async closeAll(): Promise<void> {
        const workspaces = await this.mutex.run(async () => {
            const values = [...this.cache.values()].map(entry => entry.workspace);
            this.cache.clear();
            return values;
        });
        await Promise.allSettled(workspaces.map(workspace => this.safeClose(workspace)));
    }

    private popExpired(now: number): LocalWorkspace[] {
        const expired: LocalWorkspace[] = [];
        for (const [id, entry] of this.cache) {
            if (now - entry.lastAccess > this.ttlMs) {
                this.cache.delete(id);
                expired.push(entry.workspace);
            }
        }
        return expired;
    }

    private async safeClose(workspace: LocalWorkspace): Promise<void> {
        try {
            await workspace.close();
        } catch {
            // Workspace cleanup is best-effort during eviction and shutdown.
        }
    }
}
