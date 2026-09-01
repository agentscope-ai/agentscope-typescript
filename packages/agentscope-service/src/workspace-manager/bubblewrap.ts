/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
    BubblewrapWorkspace,
    type BubblewrapWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import { blake2bHex } from './base';
import { CachedWorkspaceManager, type CachedWorkspaceManagerOptions } from './cached';

export interface BubblewrapWorkspaceManagerOptions
    extends
        CachedWorkspaceManagerOptions,
        Omit<BubblewrapWorkspaceOptions, 'workspaceId' | 'hostWorkdir'> {
    baseDirectory: string;
    workspaceFactory?: (options: BubblewrapWorkspaceOptions) => BubblewrapWorkspace;
}

/** TTL-cached Bubblewrap workspace manager with safe hashed host paths. */
export class BubblewrapWorkspaceManager extends CachedWorkspaceManager<BubblewrapWorkspace> {
    readonly baseDirectory: string;
    private readonly workspaceOptions: Omit<
        BubblewrapWorkspaceOptions,
        'workspaceId' | 'hostWorkdir'
    >;
    private readonly workspaceFactory: (options: BubblewrapWorkspaceOptions) => BubblewrapWorkspace;

    constructor(options: BubblewrapWorkspaceManagerOptions) {
        if (!options.baseDirectory.trim()) throw new Error('baseDirectory must not be empty.');
        super(options);
        const {
            isolation: _,
            ttlMs: _ttl,
            sweepIntervalMs: _sweep,
            baseDirectory,
            workspaceFactory,
            ...rest
        } = options;
        this.baseDirectory = path.resolve(baseDirectory);
        this.workspaceOptions = {
            ...rest,
            gatewayPort: rest.gatewayPort === undefined ? 5600 : rest.gatewayPort,
            shareNet: rest.shareNet ?? true,
            env: { ...(rest.env ?? {}) },
            extraPip: [...(rest.extraPip ?? [])],
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.workspaceFactory = workspaceFactory ?? (input => new BubblewrapWorkspace(input));
    }

    workdirFor(userId: string, workspaceId: string): string {
        return path.join(this.baseDirectory, blake2bHex(userId, 16), blake2bHex(workspaceId, 16));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<BubblewrapWorkspace> {
        const hostWorkdir = this.workdirFor(options.userId, options.workspaceId);
        await fs.mkdir(hostWorkdir, { recursive: true, mode: 0o700 });
        await fs.chmod(hostWorkdir, 0o700);
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId: options.workspaceId,
            hostWorkdir,
        });
        await workspace.initialize();
        return workspace;
    }
}
