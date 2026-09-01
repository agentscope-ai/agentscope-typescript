/* eslint-disable jsdoc/require-jsdoc */

import {
    AppleContainerWorkspace,
    DEFAULT_APPLE_CONTAINER_BASE_IMAGE,
    DEFAULT_APPLE_CONTAINER_CPUS,
    DEFAULT_APPLE_CONTAINER_GATEWAY_PORT,
    DEFAULT_APPLE_CONTAINER_MEMORY,
    type AppleContainerWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import { CachedWorkspaceManager, type CachedWorkspaceManagerOptions } from './cached';

export interface AppleContainerWorkspaceManagerOptions
    extends CachedWorkspaceManagerOptions, Omit<AppleContainerWorkspaceOptions, 'workspaceId'> {
    workspaceFactory?: (options: AppleContainerWorkspaceOptions) => AppleContainerWorkspace;
}

/** TTL-cached Apple Container workspace manager. */
export class AppleContainerWorkspaceManager extends CachedWorkspaceManager<AppleContainerWorkspace> {
    private readonly workspaceOptions: Omit<AppleContainerWorkspaceOptions, 'workspaceId'>;
    private readonly workspaceFactory: (
        options: AppleContainerWorkspaceOptions
    ) => AppleContainerWorkspace;

    constructor(options: AppleContainerWorkspaceManagerOptions = {}) {
        super(options);
        const {
            isolation: _,
            ttlMs: _ttl,
            sweepIntervalMs: _sweep,
            workspaceFactory,
            ...rest
        } = options;
        this.workspaceOptions = {
            ...rest,
            baseImage: rest.baseImage ?? DEFAULT_APPLE_CONTAINER_BASE_IMAGE,
            cpus: rest.cpus ?? DEFAULT_APPLE_CONTAINER_CPUS,
            memory: rest.memory ?? DEFAULT_APPLE_CONTAINER_MEMORY,
            gatewayPort: rest.gatewayPort ?? DEFAULT_APPLE_CONTAINER_GATEWAY_PORT,
            env: { ...(rest.env ?? {}) },
            extraPip: [...(rest.extraPip ?? [])],
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.workspaceFactory = workspaceFactory ?? (input => new AppleContainerWorkspace(input));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<AppleContainerWorkspace> {
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId: options.workspaceId,
        });
        await workspace.initialize();
        return workspace;
    }
}
