/* eslint-disable jsdoc/require-jsdoc */

import type { EmbeddingModelCard } from '@agentscope-ai/agentscope/model';
import { KnowledgeBase } from '@agentscope-ai/agentscope/rag';
import type { VectorStoreBase } from '@agentscope-ai/agentscope/rag';

import { buildEmbeddingModel } from '../service/model-service';
import {
    KnowledgeBaseRecordSchema,
    type ChunkerConfig,
    type EmbeddingModelConfig,
    type KnowledgeBaseRecord,
    type StorageBase,
} from '../storage';

export enum DimensionPolicyKind {
    ANY = 'any',
    FIXED = 'fixed',
    LOCKED_BY_EXISTING = 'locked_by_existing',
}

export class DimensionPolicy {
    readonly kind: DimensionPolicyKind;
    readonly dimension: number | null;

    constructor(options: { kind: DimensionPolicyKind; dimension?: number | null }) {
        this.kind = options.kind;
        this.dimension = options.dimension ?? null;
        if (this.kind === DimensionPolicyKind.ANY && this.dimension !== null) {
            throw new Error(
                `DimensionPolicy: kind=ANY requires dimension=null, got dimension=${this.dimension}.`
            );
        }
        if (
            this.kind !== DimensionPolicyKind.ANY &&
            (this.dimension === null || this.dimension <= 0)
        ) {
            throw new Error(
                `DimensionPolicy: kind=${this.kind} requires a positive dimension, got dimension=${this.dimension}.`
            );
        }
    }

    accepts(dimensions: number): boolean {
        return this.kind === DimensionPolicyKind.ANY
            ? dimensions > 0
            : dimensions === this.dimension;
    }

    filterCard(card: EmbeddingModelCard): EmbeddingModelCard | null {
        if (this.kind === DimensionPolicyKind.ANY) return card;
        if (card.supportedDimensions === null) {
            return card.dimensions === this.dimension ? card : null;
        }
        if (!card.supportedDimensions.includes(this.dimension as number)) return null;
        return Object.assign(Object.create(Object.getPrototypeOf(card)), card, {
            dimensions: this.dimension,
            supportedDimensions: [this.dimension],
        }) as EmbeddingModelCard;
    }
}

export class KnowledgeBaseError extends Error {}
export class KnowledgeBaseNotFoundError extends KnowledgeBaseError {}

export class DimensionPolicyError extends KnowledgeBaseError {
    constructor(
        message: string,
        readonly requestedDimension: number,
        readonly policyDimension: number | null
    ) {
        super(message);
        this.name = 'DimensionPolicyError';
    }
}

/** Lifecycle and runtime contract for service-owned knowledge bases. */
export abstract class KnowledgeBaseManagerBase {
    constructor(
        protected readonly storage: StorageBase,
        protected readonly vectorStore: VectorStoreBase
    ) {}

    async open(): Promise<this> {
        return this;
    }

    async close(): Promise<void> {
        await this.vectorStore.close();
    }

    abstract getDimensionPolicy(): Promise<DimensionPolicy>;
    abstract createKnowledgeBase(options: {
        userId: string;
        name: string;
        description: string;
        embeddingModelConfig: EmbeddingModelConfig;
        chunkerConfig?: ChunkerConfig | null;
    }): Promise<KnowledgeBaseRecord>;
    abstract deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<boolean>;
    abstract getKnowledge(userId: string, knowledgeBaseId: string): Promise<KnowledgeBase>;

    getKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseRecord | null> {
        return this.storage.getKnowledgeBase(userId, knowledgeBaseId);
    }

    listKnowledgeBases(userId: string): Promise<KnowledgeBaseRecord[]> {
        return this.storage.listKnowledgeBases(userId);
    }

    async updateKnowledgeBase(
        userId: string,
        knowledgeBaseId: string,
        options: { name?: string | null; description?: string | null }
    ): Promise<KnowledgeBaseRecord | null> {
        const record = await this.storage.getKnowledgeBase(userId, knowledgeBaseId);
        if (!record) return null;
        if (options.name != null) record.data.name = options.name;
        if (options.description != null) record.data.description = options.description;
        return this.storage.upsertKnowledgeBase(userId, record);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/** One vector-store collection per knowledge base. */
export class CollectionPerKbManager extends KnowledgeBaseManagerBase {
    async getDimensionPolicy(): Promise<DimensionPolicy> {
        return new DimensionPolicy({ kind: DimensionPolicyKind.ANY });
    }

    async createKnowledgeBase(options: {
        userId: string;
        name: string;
        description: string;
        embeddingModelConfig: EmbeddingModelConfig;
        chunkerConfig?: ChunkerConfig | null;
    }): Promise<KnowledgeBaseRecord> {
        const record = KnowledgeBaseRecordSchema.parse({
            user_id: options.userId,
            data: {
                name: options.name,
                description: options.description,
                embedding_model_config: options.embeddingModelConfig,
                chunker_config: options.chunkerConfig ?? null,
                collection_name: '',
            },
        });
        record.data.collection_name = `kb_${record.id}`;
        await this.vectorStore.createCollection(
            record.data.collection_name,
            options.embeddingModelConfig.dimensions
        );
        try {
            return await this.storage.upsertKnowledgeBase(options.userId, record);
        } catch (error) {
            try {
                await this.vectorStore.deleteCollection(record.data.collection_name);
            } catch {
                // Cleanup is best effort and must not shadow the storage error.
            }
            throw error;
        }
    }

    async deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<boolean> {
        const record = await this.storage.getKnowledgeBase(userId, knowledgeBaseId);
        if (!record) return false;
        if (await this.vectorStore.hasCollection(record.data.collection_name)) {
            await this.vectorStore.deleteCollection(record.data.collection_name);
        }
        return this.storage.deleteKnowledgeBase(userId, knowledgeBaseId);
    }

    async getKnowledge(userId: string, knowledgeBaseId: string): Promise<KnowledgeBase> {
        const record = await this.storage.getKnowledgeBase(userId, knowledgeBaseId);
        if (!record) {
            throw new KnowledgeBaseNotFoundError(`Knowledge base '${knowledgeBaseId}' not found.`);
        }
        const credential = await this.storage.getCredential(
            record.user_id,
            record.data.embedding_model_config.credential_id
        );
        if (!credential) {
            throw new KnowledgeBaseNotFoundError(
                `Credential '${record.data.embedding_model_config.credential_id}' for knowledge base '${knowledgeBaseId}' not found.`
            );
        }
        return new KnowledgeBase({
            name: record.data.name,
            description: record.data.description,
            embedding_model: await buildEmbeddingModel(
                credential,
                record.data.embedding_model_config
            ),
            vector_store: this.vectorStore,
            collection: record.data.collection_name,
            metadata_filter: null,
        });
    }
}
