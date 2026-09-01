/* eslint-disable jsdoc/require-jsdoc */

import type { ResourceAccessPolicyBase, ResourceKind, ResourceRef } from '../access';
import type {
    AgentRecord,
    CredentialRecord,
    KnowledgeBaseRecord,
    KnowledgeDocumentStatus,
    StorageBase,
} from '../storage';

export interface AgentView extends AgentRecord {
    editable: boolean;
}

export interface CredentialView extends CredentialRecord {
    editable: boolean;
}

export interface KnowledgeBaseStatusCounts {
    pending: number;
    parsing: number;
    chunking: number;
    indexing: number;
    ready: number;
    error: number;
}

export interface KnowledgeBaseView extends Omit<KnowledgeBaseRecord['data'], 'collection_name'> {
    id: string;
    created_at: string;
    updated_at: string;
    editable: boolean;
    document_count: number;
    chunk_count: number;
    credential_name: string | null;
    status_counts: KnowledgeBaseStatusCounts;
    /** Owning storage key, intentionally non-enumerable on the wire view. */
    ownerId: string;
}

export type ResourceView = AgentView | CredentialView | KnowledgeBaseView;
export type RawResource = AgentRecord | CredentialRecord | KnowledgeBaseRecord;

export class ResourceAccessError extends Error {
    constructor(
        public readonly statusCode: 403 | 404,
        public readonly detail: string
    ) {
        super(detail);
        this.name = 'ResourceAccessError';
    }
}

const emptyStatusCounts = (): KnowledgeBaseStatusCounts => ({
    pending: 0,
    parsing: 0,
    chunking: 0,
    indexing: 0,
    ready: 0,
    error: 0,
});

/** Resolve resources visible to one viewer through owner storage and policy refs. */
export class ResourceAccessService {
    constructor(
        private readonly storage: StorageBase,
        private readonly policy: ResourceAccessPolicyBase
    ) {}

    async listResource(viewerId: string, kind: 'credential'): Promise<CredentialView[]>;
    async listResource(viewerId: string, kind: 'agent'): Promise<AgentView[]>;
    async listResource(viewerId: string, kind: 'knowledge_base'): Promise<KnowledgeBaseView[]>;
    async listResource(viewerId: string, kind: ResourceKind): Promise<ResourceView[]> {
        const own = await this.listOwned(viewerId, kind);
        const views: ResourceView[] = await Promise.all(
            own.map(record => this.buildView(kind, record, viewerId, true))
        );
        const seen = new Set(own.map(record => this.key(record.user_id, record.id)));

        for (const reference of await this.listRefs(viewerId, kind)) {
            const key = this.key(reference.ownerId, reference.resourceId);
            if (seen.has(key)) continue;
            const record = await this.getOwned(kind, reference.ownerId, reference.resourceId);
            if (!record || (isAgentRecord(record) && record.source === 'team')) continue;
            views.push(
                await this.buildView(kind, record, viewerId, reference.permission === 'edit')
            );
            seen.add(key);
        }
        return views;
    }

    async getResource(
        viewerId: string,
        kind: 'credential',
        resourceId: string
    ): Promise<CredentialView>;
    async getResource(viewerId: string, kind: 'agent', resourceId: string): Promise<AgentView>;
    async getResource(
        viewerId: string,
        kind: 'knowledge_base',
        resourceId: string
    ): Promise<KnowledgeBaseView>;
    async getResource(
        viewerId: string,
        kind: ResourceKind,
        resourceId: string
    ): Promise<ResourceView> {
        const own = await this.getOwned(kind, viewerId, resourceId);
        if (own) return this.buildView(kind, own, viewerId, true);

        for (const reference of await this.listRefs(viewerId, kind)) {
            if (reference.resourceId !== resourceId) continue;
            const record = await this.getOwned(kind, reference.ownerId, reference.resourceId);
            if (!record || (isAgentRecord(record) && record.source === 'team')) continue;
            return this.buildView(kind, record, viewerId, reference.permission === 'edit');
        }
        throw this.notFound(kind, resourceId);
    }

    async resolveCredential(viewerId: string, credentialId: string): Promise<CredentialRecord> {
        const own = await this.storage.getCredential(viewerId, credentialId);
        if (own) return own;
        for (const reference of await this.listRefs(viewerId, 'credential')) {
            if (reference.resourceId !== credentialId) continue;
            const record = await this.storage.getCredential(
                reference.ownerId,
                reference.resourceId
            );
            if (record) return record;
        }
        throw this.notFound('credential', credentialId);
    }

    async resolveAgent(viewerId: string, agentId: string): Promise<AgentRecord> {
        const own = await this.storage.getAgent(viewerId, agentId);
        if (own) return own;
        for (const reference of await this.listRefs(viewerId, 'agent')) {
            if (reference.resourceId !== agentId) continue;
            const record = await this.storage.getAgent(reference.ownerId, reference.resourceId);
            if (record && record.source !== 'team') return record;
        }
        throw this.notFound('agent', agentId);
    }

    async resolveKnowledgeBase(
        viewerId: string,
        knowledgeBaseId: string
    ): Promise<KnowledgeBaseRecord> {
        const own = await this.storage.getKnowledgeBase(viewerId, knowledgeBaseId);
        if (own) return own;
        for (const reference of await this.listRefs(viewerId, 'knowledge_base')) {
            if (reference.resourceId !== knowledgeBaseId) continue;
            const record = await this.storage.getKnowledgeBase(
                reference.ownerId,
                reference.resourceId
            );
            if (record) return record;
        }
        throw this.notFound('knowledge_base', knowledgeBaseId);
    }

    async resolveForEdit(
        viewerId: string,
        kind: ResourceKind,
        resourceId: string
    ): Promise<[ownerId: string, record: RawResource]> {
        const own = await this.getOwned(kind, viewerId, resourceId);
        if (own) return [viewerId, own];

        for (const reference of await this.listRefs(viewerId, kind)) {
            if (reference.resourceId !== resourceId) continue;
            const record = await this.getOwned(kind, reference.ownerId, reference.resourceId);
            if (!record || (isAgentRecord(record) && record.source === 'team')) continue;
            if (reference.permission !== 'edit') {
                throw new ResourceAccessError(
                    403,
                    `${this.label(kind)} '${resourceId}' is read-only for this viewer.`
                );
            }
            return [reference.ownerId, record];
        }
        throw this.notFound(kind, resourceId);
    }

    private async listOwned(viewerId: string, kind: ResourceKind): Promise<RawResource[]> {
        if (kind === 'credential') return this.storage.listCredentials(viewerId);
        if (kind === 'agent') {
            return (await this.storage.listAgents(viewerId)).filter(
                record => record.source !== 'team'
            );
        }
        return this.storage.listKnowledgeBases(viewerId);
    }

    private async getOwned(
        kind: ResourceKind,
        ownerId: string,
        resourceId: string
    ): Promise<RawResource | null> {
        if (kind === 'credential') return this.storage.getCredential(ownerId, resourceId);
        if (kind === 'agent') return this.storage.getAgent(ownerId, resourceId);
        return this.storage.getKnowledgeBase(ownerId, resourceId);
    }

    private async buildView(
        kind: ResourceKind,
        record: RawResource,
        viewerId: string,
        editable: boolean
    ): Promise<ResourceView> {
        if (kind === 'credential') {
            const credentialRecord = record as CredentialRecord;
            const data =
                credentialRecord.user_id === viewerId
                    ? structuredClone(credentialRecord.data)
                    : Object.fromEntries(
                          ['type', 'name']
                              .filter(key => key in credentialRecord.data)
                              .map(key => [key, credentialRecord.data[key]])
                      );
            return { ...structuredClone(credentialRecord), data, editable };
        }
        if (kind === 'agent') return { ...structuredClone(record as AgentRecord), editable };

        const knowledgeBaseRecord = record as KnowledgeBaseRecord;
        const documents = await this.storage.listKnowledgeDocuments(record.user_id, record.id);
        const statusCounts = emptyStatusCounts();
        let chunkCount = 0;
        for (const document of documents) {
            statusCounts[document.status as KnowledgeDocumentStatus] += 1;
            chunkCount += document.data.chunk_count;
        }
        const credential = await this.storage.getCredential(
            record.user_id,
            knowledgeBaseRecord.data.embedding_model_config.credential_id
        );
        const view = {
            id: knowledgeBaseRecord.id,
            name: knowledgeBaseRecord.data.name,
            description: knowledgeBaseRecord.data.description,
            embedding_model_config: structuredClone(
                knowledgeBaseRecord.data.embedding_model_config
            ),
            chunker_config: structuredClone(knowledgeBaseRecord.data.chunker_config),
            created_at: knowledgeBaseRecord.created_at,
            updated_at: knowledgeBaseRecord.updated_at,
            editable,
            document_count: documents.length,
            chunk_count: chunkCount,
            credential_name:
                credential && typeof credential.data.name === 'string'
                    ? credential.data.name
                    : null,
            status_counts: statusCounts,
        } as KnowledgeBaseView;
        Object.defineProperty(view, 'ownerId', {
            value: knowledgeBaseRecord.user_id,
            enumerable: false,
        });
        return view;
    }

    private async listRefs(viewerId: string, kind: ResourceKind): Promise<ResourceRef[]> {
        return (await this.policy.listAccessible(viewerId, kind, this.storage)).filter(
            reference => reference.kind === kind
        );
    }

    private key(ownerId: string, resourceId: string): string {
        return `${ownerId}\u0000${resourceId}`;
    }

    private label(kind: ResourceKind): string {
        return kind
            .split('_')
            .map(part => part[0].toUpperCase() + part.slice(1))
            .join(' ');
    }

    private notFound(kind: ResourceKind, resourceId: string): ResourceAccessError {
        return new ResourceAccessError(404, `${this.label(kind)} '${resourceId}' not found.`);
    }
}

function isAgentRecord(record: RawResource): record is AgentRecord {
    return 'source' in record;
}
