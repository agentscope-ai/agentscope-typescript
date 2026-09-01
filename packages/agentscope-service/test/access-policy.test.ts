/* eslint-disable jsdoc/require-jsdoc */

import { DenyAllResourceAccessPolicy, ResourceAccessPolicyBase } from '../src/access';
import type { StorageBase } from '../src/storage';

class EditPolicy extends ResourceAccessPolicyBase {
    async listAccessible() {
        return [
            {
                kind: 'agent' as const,
                ownerId: 'owner',
                resourceId: 'agent-1',
                permission: 'edit' as const,
            },
        ];
    }
}

describe('resource access policies', () => {
    const storage = {} as StorageBase;

    test('denies cross-owner access by default', async () => {
        const policy = new DenyAllResourceAccessPolicy();
        expect(await policy.listAccessible('viewer', 'credential', storage)).toEqual([]);
        expect(await policy.canEdit('viewer', 'credential', 'owner', 'credential-1', storage)).toBe(
            false
        );
    });

    test('always permits an owner to edit their resource', async () => {
        expect(
            await new DenyAllResourceAccessPolicy().canEdit(
                'owner',
                'agent',
                'owner',
                'agent-1',
                storage
            )
        ).toBe(true);
    });

    test('uses edit references for cross-owner authorization', async () => {
        const policy = new EditPolicy();
        expect(await policy.canEdit('viewer', 'agent', 'owner', 'agent-1', storage)).toBe(true);
        expect(await policy.canEdit('viewer', 'agent', 'owner', 'agent-2', storage)).toBe(false);
    });
});
