/* eslint-disable jsdoc/require-jsdoc */

import {
    DaytonaWorkspace,
    DEFAULT_DAYTONA_GATEWAY_PORT,
    DEFAULT_DAYTONA_TIMEOUT,
    type DaytonaWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import { CachedWorkspaceManager, type CachedWorkspaceManagerOptions } from './cached';

export interface DaytonaWorkspaceManagerOptions
    extends
        CachedWorkspaceManagerOptions,
        Omit<DaytonaWorkspaceOptions, 'workspaceId' | 'sandboxMetadata'> {
    sandboxMetadata?: Record<string, string>;
    workspaceFactory?: (options: DaytonaWorkspaceOptions) => DaytonaWorkspace;
}

/** TTL-cached Daytona manager with owner metadata and provider reattachment. */
export class DaytonaWorkspaceManager extends CachedWorkspaceManager<DaytonaWorkspace> {
    private readonly workspaceOptions: Omit<
        DaytonaWorkspaceOptions,
        'workspaceId' | 'sandboxMetadata'
    >;
    private readonly sandboxMetadata: Record<string, string>;
    private readonly workspaceFactory: (options: DaytonaWorkspaceOptions) => DaytonaWorkspace;

    constructor(options: DaytonaWorkspaceManagerOptions = {}) {
        super(options);
        const {
            isolation: _,
            ttlMs: _ttl,
            sweepIntervalMs: _sweep,
            sandboxMetadata,
            workspaceFactory,
            ...rest
        } = options;
        this.workspaceOptions = {
            ...rest,
            apiKey: rest.apiKey ?? '',
            apiUrl: rest.apiUrl ?? '',
            target: rest.target ?? '',
            timeoutSeconds: rest.timeoutSeconds ?? DEFAULT_DAYTONA_TIMEOUT,
            gatewayPort: rest.gatewayPort ?? DEFAULT_DAYTONA_GATEWAY_PORT,
            env: { ...(rest.env ?? {}) },
            extraPip: [...(rest.extraPip ?? [])],
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
            osUser: rest.osUser ?? null,
        };
        this.sandboxMetadata = { ...(sandboxMetadata ?? {}) };
        this.workspaceFactory = workspaceFactory ?? (input => new DaytonaWorkspace(input));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<DaytonaWorkspace> {
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId: options.workspaceId,
            sandboxMetadata: {
                'agentscope.user.id': options.userId,
                'agentscope.agent.id': options.agentId,
                ...this.sandboxMetadata,
            },
        });
        await workspace.initialize();
        return workspace;
    }
}
