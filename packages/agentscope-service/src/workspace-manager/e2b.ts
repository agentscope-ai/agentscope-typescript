/* eslint-disable jsdoc/require-jsdoc */

import {
    DEFAULT_E2B_GATEWAY_PORT,
    DEFAULT_E2B_TEMPLATE,
    DEFAULT_E2B_TIMEOUT,
    E2BWorkspace,
    type E2BWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import {
    CachedPrewarmedWorkspaceManager,
    type CachedPrewarmedWorkspaceManagerOptions,
} from './cached';

export interface E2BWorkspaceManagerOptions
    extends
        CachedPrewarmedWorkspaceManagerOptions,
        Omit<E2BWorkspaceOptions, 'workspaceId' | 'sandboxMetadata'> {
    sandboxMetadata?: Record<string, string>;
    workspaceFactory?: (options: E2BWorkspaceOptions) => E2BWorkspace;
}

/** E2B manager with reattachment metadata and kill-on-unclaimed cleanup. */
export class E2BWorkspaceManager extends CachedPrewarmedWorkspaceManager<E2BWorkspace> {
    private readonly workspaceOptions: Omit<E2BWorkspaceOptions, 'workspaceId' | 'sandboxMetadata'>;
    private readonly sandboxMetadata: Record<string, string>;
    private readonly workspaceFactory: (options: E2BWorkspaceOptions) => E2BWorkspace;

    constructor(options: E2BWorkspaceManagerOptions = {}) {
        super(options);
        const {
            isolation: _,
            ttlMs: _ttl,
            sweepIntervalMs: _sweep,
            prewarm: _prewarm,
            sandboxMetadata,
            workspaceFactory,
            ...rest
        } = options;
        this.workspaceOptions = {
            ...rest,
            template: rest.template ?? DEFAULT_E2B_TEMPLATE,
            apiKey: rest.apiKey ?? '',
            domain: rest.domain ?? '',
            timeoutSeconds: rest.timeoutSeconds ?? DEFAULT_E2B_TIMEOUT,
            gatewayPort: rest.gatewayPort ?? DEFAULT_E2B_GATEWAY_PORT,
            env: { ...(rest.env ?? {}) },
            extraPip: [...(rest.extraPip ?? [])],
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.sandboxMetadata = { ...(sandboxMetadata ?? {}) };
        this.workspaceFactory = workspaceFactory ?? (input => new E2BWorkspace(input));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<E2BWorkspace> {
        return this.buildAndStart(options.workspaceId, options.userId, options.agentId);
    }

    protected async createPrewarmed(): Promise<E2BWorkspace> {
        return this.buildAndStart(undefined, '', '');
    }

    protected async disposePrewarmed(workspace: E2BWorkspace): Promise<void> {
        try {
            await workspace.destroy();
        } catch {
            await workspace.close().catch(() => undefined);
        }
    }

    private async buildAndStart(
        workspaceId: string | undefined,
        userId: string,
        agentId: string
    ): Promise<E2BWorkspace> {
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId,
            sandboxMetadata: {
                'agentscope.user.id': userId,
                'agentscope.agent.id': agentId,
                ...this.sandboxMetadata,
            },
        });
        try {
            await workspace.initialize();
        } catch (error) {
            await this.disposePrewarmed(workspace);
            throw error;
        }
        return workspace;
    }
}
