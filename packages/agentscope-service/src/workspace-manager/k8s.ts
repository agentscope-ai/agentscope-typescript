/* eslint-disable jsdoc/require-jsdoc */

import {
    DEFAULT_K8S_GATEWAY_PORT,
    DEFAULT_K8S_IMAGE,
    K8sWorkspace,
    type K8sWorkspaceOptions,
} from '@agentscope-ai/agentscope/workspace';

import { CachedWorkspaceManager, type CachedWorkspaceManagerOptions } from './cached';

export interface K8sWorkspaceManagerOptions
    extends CachedWorkspaceManagerOptions, Omit<K8sWorkspaceOptions, 'workspaceId'> {
    workspaceFactory?: (options: K8sWorkspaceOptions) => K8sWorkspace;
}

/** TTL-cached Kubernetes manager; Core owns Pod/PVC reattachment semantics. */
export class K8sWorkspaceManager extends CachedWorkspaceManager<K8sWorkspace> {
    private readonly workspaceOptions: Omit<K8sWorkspaceOptions, 'workspaceId'>;
    private readonly workspaceFactory: (options: K8sWorkspaceOptions) => K8sWorkspace;

    constructor(options: K8sWorkspaceManagerOptions = {}) {
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
            namespace: rest.namespace ?? 'agentscope',
            kubeconfig: rest.kubeconfig ?? null,
            image: rest.image ?? DEFAULT_K8S_IMAGE,
            imagePullPolicy: rest.imagePullPolicy ?? 'IfNotPresent',
            imagePullSecrets: [...(rest.imagePullSecrets ?? [])],
            resources: rest.resources ?? null,
            nodeSelector: rest.nodeSelector ?? null,
            tolerations: rest.tolerations ?? null,
            serviceAccount: rest.serviceAccount ?? null,
            gatewayPort: rest.gatewayPort ?? DEFAULT_K8S_GATEWAY_PORT,
            extraPip: [...(rest.extraPip ?? [])],
            storageClass: rest.storageClass ?? null,
            storageSize: rest.storageSize ?? '1Gi',
            deletePvcOnClose: rest.deletePvcOnClose ?? false,
            env: { ...(rest.env ?? {}) },
            defaultMcps: [...(rest.defaultMcps ?? [])],
            skillPaths: [...(rest.skillPaths ?? [])],
        };
        this.workspaceFactory = workspaceFactory ?? (input => new K8sWorkspace(input));
    }

    protected async buildWorkspace(options: {
        workspaceId: string;
        userId: string;
        agentId: string;
    }): Promise<K8sWorkspace> {
        const workspace = this.workspaceFactory({
            ...this.workspaceOptions,
            workspaceId: options.workspaceId,
        });
        await workspace.initialize();
        return workspace;
    }
}
