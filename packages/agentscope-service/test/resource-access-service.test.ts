/* eslint-disable jsdoc/require-jsdoc */

import { ResourceAccessPolicyBase } from '../src/access';
import type { ResourceKind, ResourceRef } from '../src/access';
import { ResourceAccessError, ResourceAccessService } from '../src/service';
import {
    AgentRecordSchema,
    CredentialRecordSchema,
    InMemoryStorage,
    KnowledgeBaseRecordSchema,
    KnowledgeDocumentRecordSchema,
} from '../src/storage';

class SeedStorage extends InMemoryStorage {
    seedCredential(input: unknown): void {
        const record = CredentialRecordSchema.parse(input);
        this.credentials.set(record.id, record);
    }

    seedAgent(input: unknown): void {
        const record = AgentRecordSchema.parse(input);
        this.agents.set(record.id, record);
    }

    seedKnowledgeBase(input: unknown): void {
        const record = KnowledgeBaseRecordSchema.parse(input);
        this.knowledgeBases.set(record.id, record);
    }

    seedKnowledgeDocument(input: unknown): void {
        const record = KnowledgeDocumentRecordSchema.parse(input);
        this.knowledgeDocuments.set(record.id, record);
    }
}

class SharingPolicy extends ResourceAccessPolicyBase {
    async listAccessible(viewerId: string, kind: ResourceKind): Promise<ResourceRef[]> {
        if (viewerId !== 'viewer') return [];
        if (kind === 'credential') {
            return [
                {
                    kind,
                    ownerId: 'owner',
                    resourceId: 'credential-shared',
                },
            ];
        }
        if (kind === 'agent') {
            return [
                { kind, ownerId: 'owner', resourceId: 'agent-shared' },
                { kind, ownerId: 'owner', resourceId: 'agent-team' },
            ];
        }
        return [
            {
                kind,
                ownerId: 'owner',
                resourceId: 'kb-shared',
                permission: 'edit',
            },
        ];
    }
}

class MismatchedPolicy extends ResourceAccessPolicyBase {
    async listAccessible(): Promise<ResourceRef[]> {
        return [{ kind: 'agent', ownerId: 'owner', resourceId: 'agent-shared' }];
    }
}

const agent = (id: string, userId: string, source: 'user' | 'team' = 'user') => ({
    id,
    user_id: userId,
    source,
    data: {
        id: `data-${id}`,
        name: id,
        context_config: {},
        react_config: {},
    },
});

const knowledgeBase = (id: string, userId: string, credentialId: string) => ({
    id,
    user_id: userId,
    data: {
        name: 'My KB',
        description: 'A test knowledge base.',
        embedding_model_config: {
            type: 'openai_credential',
            credential_id: credentialId,
            model: 'text-embedding-3-small',
            dimensions: 1536,
        },
        collection_name: 'kb_deadbeef',
    },
});

describe('ResourceAccessService', () => {
    let storage: SeedStorage;
    let service: ResourceAccessService;

    beforeEach(() => {
        storage = new SeedStorage();
        storage.seedCredential({
            id: 'credential-shared',
            user_id: 'owner',
            data: { type: 'test', name: 'Shared name', api_key: 'secret' },
        });
        storage.seedCredential({
            id: 'credential-own',
            user_id: 'viewer',
            data: { type: 'own', api_key: 'own-secret' },
        });
        storage.seedAgent(agent('agent-shared', 'owner'));
        storage.seedAgent(agent('agent-team', 'owner', 'team'));
        storage.seedAgent(agent('agent-own-team', 'viewer', 'team'));
        storage.seedKnowledgeBase(knowledgeBase('kb-shared', 'owner', 'credential-shared'));
        storage.seedKnowledgeDocument({
            id: 'document-ready',
            user_id: 'owner',
            knowledge_base_id: 'kb-shared',
            status: 'ready',
            data: {
                filename: 'ready.txt',
                size: 10,
                blob_uri: 'memory://ready.txt',
                chunk_count: 3,
            },
        });
        storage.seedKnowledgeDocument({
            id: 'document-error',
            user_id: 'owner',
            knowledge_base_id: 'kb-shared',
            status: 'error',
            data: {
                filename: 'error.txt',
                size: 4,
                blob_uri: 'memory://error.txt',
            },
        });
        service = new ResourceAccessService(storage, new SharingPolicy());
    });

    test('masks shared credential views but returns raw runtime credentials', async () => {
        expect(await service.getResource('viewer', 'credential', 'credential-shared')).toEqual({
            id: 'credential-shared',
            user_id: 'owner',
            created_at: expect.any(String),
            updated_at: expect.any(String),
            data: { type: 'test', name: 'Shared name' },
            editable: false,
        });
        expect((await service.resolveCredential('viewer', 'credential-shared')).data).toEqual({
            type: 'test',
            name: 'Shared name',
            api_key: 'secret',
        });
    });

    test('merges own and shared resources without exposing team workers', async () => {
        expect((await service.listResource('viewer', 'credential')).map(view => view.id)).toEqual([
            'credential-own',
            'credential-shared',
        ]);
        expect(await service.listResource('viewer', 'agent')).toEqual([
            {
                ...AgentRecordSchema.parse(agent('agent-shared', 'owner')),
                editable: false,
            },
        ]);
        await expect(service.resolveAgent('viewer', 'agent-team')).rejects.toMatchObject({
            statusCode: 404,
        });
        expect((await service.resolveAgent('viewer', 'agent-own-team')).source).toBe('team');
    });

    test('builds the flat knowledge-base wire view with owner-scoped aggregates', async () => {
        const view = await service.getResource('viewer', 'knowledge_base', 'kb-shared');
        expect(view).toEqual({
            id: 'kb-shared',
            name: 'My KB',
            description: 'A test knowledge base.',
            embedding_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-shared',
                model: 'text-embedding-3-small',
                dimensions: 1536,
                parameters: {},
            },
            chunker_config: null,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            editable: true,
            document_count: 2,
            chunk_count: 3,
            credential_name: 'Shared name',
            status_counts: {
                pending: 0,
                parsing: 0,
                chunking: 0,
                indexing: 0,
                ready: 1,
                error: 1,
            },
        });
        expect(view).not.toHaveProperty('data');
        expect(view).not.toHaveProperty('owner_id');
        expect(view).not.toHaveProperty('collection_name');
    });

    test('enforces read-only and editable policy refs during mutation resolution', async () => {
        await expect(
            service.resolveForEdit('viewer', 'credential', 'credential-shared')
        ).rejects.toEqual(
            new ResourceAccessError(
                403,
                "Credential 'credential-shared' is read-only for this viewer."
            )
        );
        await expect(
            service.resolveForEdit('viewer', 'knowledge_base', 'kb-shared')
        ).resolves.toEqual(['owner', expect.objectContaining({ id: 'kb-shared' })]);
        await expect(
            service.resolveForEdit('viewer', 'credential', 'credential-own')
        ).resolves.toEqual(['viewer', expect.objectContaining({ id: 'credential-own' })]);
    });

    test('drops mismatched refs and reports the Python-compatible 404 detail', async () => {
        const mismatched = new ResourceAccessService(storage, new MismatchedPolicy());
        await expect(
            mismatched.getResource('viewer', 'credential', 'agent-shared')
        ).rejects.toEqual(new ResourceAccessError(404, "Credential 'agent-shared' not found."));
        await expect(service.getResource('viewer', 'credential', 'missing')).rejects.toEqual(
            new ResourceAccessError(404, "Credential 'missing' not found.")
        );
    });
});
