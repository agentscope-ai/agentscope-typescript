/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
    DEFAULT_DOCKER_BASE_IMAGE,
    DEFAULT_DOCKER_GATEWAY_PORT,
    DockerWorkspace,
    type DockerWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import {
    CachedPrewarmedWorkspaceManager,
    type CachedPrewarmedWorkspaceManagerOptions,
} from './cached';

export interface DockerWorkspaceManagerOptions
    extends
        CachedPrewarmedWorkspaceManagerOptions,
        Omit<DockerWorkspaceOptions, 'workspaceId' | 'hostWorkdir' | 'workdir'> {
    baseDirectory: string;
    workspaceFactory?: (options: DockerWorkspaceOptions) => DockerWorkspace;
}

/** Docker manager with safe persistent workdirs and an optional warm buffer. */
export class DockerWorkspaceManager extends CachedPrewarmedWorkspaceManager<DockerWorkspace> {
    readonly baseDirectory: string;
    private readonly workspaceOptions: Omit<
        DockerWorkspaceOptions,
        'workspaceId' | 'hostWorkdir' | 'workdir'
    >;
    private readonly workspaceFactory: (options: DockerWorkspaceOptions) => DockerWorkspace;

    constructor(options: DockerWorkspaceManagerOptions) {
        if (!options.baseDirectory.trim()) throw new Error('baseDirectory must not be empty.');
        super(options);
        const {
            isolation: _,
            ttlMs: _ttl,
            sweepIntervalMs: _sweep,
            prewarm: _prewarm,
            baseDirectory,
            workspaceFactory,
            ...rest
        } = options;
        this.baseDirectory = path.resolve(baseDirectory);
        this.workspaceOptions = {
            ...rest,
            baseImage: rest.baseImage ?? DEFAULT_DOCKER_BASE_IMAGE,
            nodeVersion: rest.nodeVersion ?? '20',
            extraPip: [...(rest.extraPip ?? [])],
            gatewayPort: rest.gatewayPort ?? DEFAULT_DOCKER_GATEWAY_PORT,
            env: { ...(rest.env ?? {}) },
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.workspaceFactory = workspaceFactory ?? (input => new DockerWorkspace(input));
    }

    workdirFor(workspaceId: string, userId = '', agentId = ''): string {
        const workdir = path.resolve(this.baseDirectory, workspaceId);
        const relative = path.relative(this.baseDirectory, workdir);
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`workspaceId ${JSON.stringify(workspaceId)} escapes baseDirectory.`);
        }
        if (directoryExists(workdir) || !userId || !agentId) return workdir;
        const legacy = path.resolve(this.baseDirectory, userId, agentId);
        const legacyRelative = path.relative(this.baseDirectory, legacy);
        if (
            legacyRelative &&
            !legacyRelative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(legacyRelative) &&
            directoryExists(legacy)
        ) {
            return legacy;
        }
        return workdir;
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<DockerWorkspace> {
        return this.buildAndStart(options.workspaceId, options.userId, options.agentId);
    }

    protected async createPrewarmed(): Promise<DockerWorkspace> {
        return this.buildAndStart(undefined, '', '');
    }

    private async buildAndStart(
        workspaceId: string | undefined,
        userId: string,
        agentId: string
    ): Promise<DockerWorkspace> {
        const resolvedWorkspaceId = workspaceId ?? randomUUID().replaceAll('-', '');
        const hostWorkdir = this.workdirFor(resolvedWorkspaceId, userId, agentId);
        await fs.mkdir(hostWorkdir, { recursive: true });
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId: resolvedWorkspaceId,
            hostWorkdir,
        });
        await workspace.initialize();
        return workspace;
    }
}

function directoryExists(directory: string): boolean {
    try {
        return statSync(directory).isDirectory();
    } catch {
        return false;
    }
}
