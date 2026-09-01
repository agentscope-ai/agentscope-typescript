/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { CredentialFactory } from '@agentscope-ai/agentscope/credential';
import type { CredentialBase } from '@agentscope-ai/agentscope/credential';
import type { EmbeddingModelBase } from '@agentscope-ai/agentscope/embedding';
import type { ChatModelBase } from '@agentscope-ai/agentscope/model';
import type { EmbeddingModelCard, TTSModelCard } from '@agentscope-ai/agentscope/model';
import type { TTSModelBase } from '@agentscope-ai/agentscope/tts';

import type {
    ChatModelConfig,
    CredentialRecord,
    EmbeddingModelConfig,
    TTSModelConfig,
} from '../storage';
import type { ResourceAccessService } from './resource-access-service';

interface ModelOptions {
    credential: CredentialBase;
    model: string;
    parameters?: Record<string, unknown>;
    dimensions?: number;
    contextSize?: number;
}

interface ChatModelConstructor {
    new (options: ModelOptions): ChatModelBase;
}

interface EmbeddingModelConstructor {
    new (options: ModelOptions): EmbeddingModelBase;
}

interface TTSModelConstructor {
    new (options: ModelOptions): TTSModelBase;
    listModels(): TTSModelCard[];
}

export class ModelServiceError extends Error {
    readonly statusCode = 400;

    constructor(public readonly detail: string) {
        super(detail);
        this.name = 'ModelServiceError';
    }
}

/** Build a chat model from a viewer-visible stored credential. */
export async function getModel(
    userId: string,
    config: ChatModelConfig,
    access: ResourceAccessService
): Promise<ChatModelBase> {
    const record = await access.resolveCredential(userId, config.credential_id);
    const credential = CredentialFactory.fromDict(record.data);
    const ModelClass = (await credential.getChatModelClass()) as ChatModelConstructor;
    const model = new ModelClass({
        credential,
        model: config.model,
        parameters: normalizeParameters(config.parameters),
    });
    const card = credential.listModels().find(candidate => candidate.name === config.model);
    if (card && model.formatter) {
        (model.formatter as { inputTypes: string[] }).inputTypes = [...card.inputTypes];
    }
    return model;
}

/** Build an embedding model from an already-resolved credential record. */
export async function buildEmbeddingModel(
    credentialRecord: CredentialRecord,
    config: EmbeddingModelConfig
): Promise<EmbeddingModelBase> {
    const credential = CredentialFactory.fromDict(credentialRecord.data);
    if (!CredentialFactory.getCredentialClass(config.type)) {
        throw new ModelServiceError(`Provider '${config.type}' not found.`);
    }
    const ModelClass =
        (await credential.getEmbeddingModelClass()) as EmbeddingModelConstructor | null;
    if (!ModelClass) {
        throw new ModelServiceError(`Provider '${config.type}' does not support embedding models.`);
    }
    const card = credential
        .listEmbeddingModels()
        .find((candidate: EmbeddingModelCard) => candidate.name === config.model);
    return new ModelClass({
        credential,
        model: config.model,
        dimensions: config.dimensions,
        parameters: normalizeParameters(config.parameters),
        ...(card?.contextSize == null ? {} : { contextSize: card.contextSize }),
    });
}

/** Resolve a viewer-visible credential and build its embedding model. */
export async function getEmbeddingModel(
    userId: string,
    config: EmbeddingModelConfig,
    access: ResourceAccessService
): Promise<EmbeddingModelBase> {
    return buildEmbeddingModel(
        await access.resolveCredential(userId, config.credential_id),
        config
    );
}

/** Build a TTS model from a viewer-visible stored credential. */
export async function getTTSModel(
    userId: string,
    config: TTSModelConfig,
    access: ResourceAccessService
): Promise<TTSModelBase> {
    const record = await access.resolveCredential(userId, config.credential_id);
    const credential = CredentialFactory.fromDict(record.data);
    const classes = (await credential.getTTSModelClasses()) as TTSModelConstructor[];
    if (classes.length === 0) {
        throw new ModelServiceError(`Provider '${config.type}' does not support TTS models.`);
    }
    const ModelClass = resolveTTSClass(classes, config.model);
    return new ModelClass({
        credential,
        model: config.model,
        parameters: normalizeParameters(config.parameters),
    });
}

function resolveTTSClass(classes: TTSModelConstructor[], model: string): TTSModelConstructor {
    return (
        classes.find(candidate => candidate.listModels().some(card => card.name === model)) ??
        classes[0]
    );
}

function normalizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            value,
        ])
    );
}
