/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import type { StorageBase } from '../storage';

/** Resource kinds resolved through cross-owner access policy. */
export type ResourceKind = 'credential' | 'agent' | 'knowledge_base';

/** Permission granted for a referenced resource. */
export type ResourcePermission = 'read' | 'edit';

/** Cross-owner resource reference returned by an access policy. */
export interface ResourceRef {
    kind: ResourceKind;
    ownerId: string;
    resourceId: string;
    permission?: ResourcePermission;
}

/** Extension point for application-defined resource sharing. */
export abstract class ResourceAccessPolicyBase {
    /** List cross-owner resources visible to a viewer. */
    abstract listAccessible(
        viewerId: string,
        kind: ResourceKind,
        storage: StorageBase
    ): Promise<ResourceRef[]>;

    /** Return whether a viewer may mutate one resource. */
    async canEdit(
        viewerId: string,
        kind: ResourceKind,
        ownerId: string,
        resourceId: string,
        storage: StorageBase
    ): Promise<boolean> {
        if (viewerId === ownerId) return true;
        return (await this.listAccessible(viewerId, kind, storage)).some(
            reference =>
                reference.kind === kind &&
                reference.ownerId === ownerId &&
                reference.resourceId === resourceId &&
                reference.permission === 'edit'
        );
    }
}

/** Default policy preserving strict owner isolation. */
export class DenyAllResourceAccessPolicy extends ResourceAccessPolicyBase {
    async listAccessible(
        _viewerId: string,
        _kind: ResourceKind,
        _storage: StorageBase
    ): Promise<ResourceRef[]> {
        return [];
    }
}
