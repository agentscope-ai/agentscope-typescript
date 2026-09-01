/* eslint-disable jsdoc/require-jsdoc */

import {
    DEFAULT_OPENSANDBOX_GATEWAY_PORT,
    DEFAULT_OPENSANDBOX_IMAGE,
    DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT,
    DEFAULT_OPENSANDBOX_TIMEOUT,
    OpenSandboxWorkspace,
    type OpenSandboxWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import { CachedWorkspaceManager, type CachedWorkspaceManagerOptions } from './cached';

export interface OpenSandboxWorkspaceManagerOptions
    extends
        CachedWorkspaceManagerOptions,
        Omit<OpenSandboxWorkspaceOptions, 'workspaceId' | 'sandboxMetadata'> {
    sandboxMetadata?: Record<string, string>;
    workspaceFactory?: (options: OpenSandboxWorkspaceOptions) => OpenSandboxWorkspace;
}

/** TTL-cached OpenSandbox manager with metadata-based reattachment. */
export class OpenSandboxWorkspaceManager extends CachedWorkspaceManager<OpenSandboxWorkspace> {
    private readonly workspaceOptions: Omit<
        OpenSandboxWorkspaceOptions,
        'workspaceId' | 'sandboxMetadata'
    >;
    private readonly sandboxMetadata: Record<string, string>;
    private readonly workspaceFactory: (
        options: OpenSandboxWorkspaceOptions
    ) => OpenSandboxWorkspace;

    constructor(options: OpenSandboxWorkspaceManagerOptions = {}) {
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
            image: rest.image ?? DEFAULT_OPENSANDBOX_IMAGE,
            apiKey: rest.apiKey ?? '',
            domain: rest.domain ?? '',
            protocol: rest.protocol ?? 'http',
            requestTimeoutSeconds:
                rest.requestTimeoutSeconds === undefined
                    ? DEFAULT_OPENSANDBOX_REQUEST_TIMEOUT
                    : rest.requestTimeoutSeconds,
            timeoutSeconds: rest.timeoutSeconds ?? DEFAULT_OPENSANDBOX_TIMEOUT,
            gatewayPort: rest.gatewayPort ?? DEFAULT_OPENSANDBOX_GATEWAY_PORT,
            env: { ...(rest.env ?? {}) },
            resource: { ...(rest.resource ?? {}) },
            entrypoint: [...(rest.entrypoint ?? [])],
            networkPolicy: rest.networkPolicy ?? null,
            extraPip: [...(rest.extraPip ?? [])],
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.sandboxMetadata = { ...(sandboxMetadata ?? {}) };
        this.workspaceFactory = workspaceFactory ?? (input => new OpenSandboxWorkspace(input));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<OpenSandboxWorkspace> {
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
