/* eslint-disable jsdoc/require-jsdoc */

import { _generateId } from '../_utils/common';
import type { EmbeddingModelBase } from '../embedding/base';
import { embeddingModelOrder } from '../embedding/card-order';
import type { ChatModelBase } from '../model/base';
import { createModelCard } from '../model/card';
import type { AnyModelCard, EmbeddingModelCard, ModelCard, TTSModelCard } from '../model/card';
import { listModelCards, listRawModelCards } from '../model/card-registry';
import type { TTSModelBase } from '../tts/base';
import { ttsModelOrder, ttsParameterSchema } from '../tts/schemas';

export interface CredentialOptions {
    id?: string;
    name?: string;
}

export type CredentialSchema = Record<string, unknown>;
export type ChatModelClass = abstract new (...args: never[]) => ChatModelBase;
export type EmbeddingModelClass = abstract new (...args: never[]) => EmbeddingModelBase;
export type TTSModelClass = abstract new (...args: never[]) => TTSModelBase;

let chatModelResolver: ((provider: string) => Promise<ChatModelClass>) | null = null;
let embeddingModelResolver: ((provider: string) => Promise<EmbeddingModelClass>) | null = null;
let ttsModelResolver: ((provider: string) => Promise<TTSModelClass[]>) | null = null;

/** Shared credential identity and model-card discovery behavior. */
export abstract class CredentialBase {
    abstract readonly type: string;
    abstract readonly chatProvider: string;
    readonly embeddingProvider: string | null = null;
    readonly ttsProvider: string | null = null;
    readonly id: string;
    readonly name: string;

    protected constructor(options: CredentialOptions = {}) {
        this.id = options.id ?? _generateId();
        this.name = options.name ?? '';
    }

    listModels(): ModelCard[] {
        return listModelCards({ kind: 'chat', provider: this.chatProvider }) as ModelCard[];
    }

    getChatModelClass(): Promise<ChatModelClass> {
        if (!chatModelResolver) throw new Error('Chat model registry is not initialized.');
        return chatModelResolver(this.chatProvider);
    }

    getEmbeddingModelClass(): Promise<EmbeddingModelClass | null> {
        if (this.embeddingProvider === null) return Promise.resolve(null);
        if (!embeddingModelResolver) {
            throw new Error('Embedding model registry is not initialized.');
        }
        return embeddingModelResolver(this.embeddingProvider);
    }

    listTTSModels(): TTSModelCard[] {
        if (this.ttsProvider === null) return [];
        return listRawModelCards({ kind: 'tts', provider: this.ttsProvider })
            .map(record => {
                return createModelCard(
                    record,
                    ttsParameterSchema(record.provider, String(record.config.name))
                ) as TTSModelCard;
            })
            .sort(
                (left, right) =>
                    ttsModelOrder(this.ttsProvider as string, left.name) -
                    ttsModelOrder(this.ttsProvider as string, right.name)
            );
    }

    getTTSModelClasses(): Promise<TTSModelClass[]> {
        if (this.ttsProvider === null) return Promise.resolve([]);
        if (!ttsModelResolver) throw new Error('TTS model registry is not initialized.');
        return ttsModelResolver(this.ttsProvider);
    }

    listEmbeddingModels(): EmbeddingModelCard[] {
        if (this.embeddingProvider === null) return [];
        const cards = listModelCards({
            kind: 'embedding',
            provider: this.embeddingProvider,
        }) as EmbeddingModelCard[];
        return cards.sort(
            (left, right) =>
                embeddingModelOrder(this.embeddingProvider as string, left.name) -
                embeddingModelOrder(this.embeddingProvider as string, right.name)
        );
    }

    abstract toJSON(): Record<string, unknown>;
}

export function registerChatModelResolver(
    resolver: (provider: string) => Promise<ChatModelClass>
): void {
    chatModelResolver = resolver;
}

export function registerEmbeddingModelResolver(
    resolver: (provider: string) => Promise<EmbeddingModelClass>
): void {
    embeddingModelResolver = resolver;
}

export function registerTTSModelResolver(
    resolver: (provider: string) => Promise<TTSModelClass[]>
): void {
    ttsModelResolver = resolver;
}

export interface CredentialClass<T extends CredentialBase = CredentialBase> {
    readonly credentialType: string;
    readonly schema: CredentialSchema;
    fromDict(data: Record<string, unknown>): T;
}

export function credentialJSON(
    credential: CredentialBase,
    fields: Record<string, unknown>
): Record<string, unknown> {
    return {
        id: credential.id,
        name: credential.name,
        type: credential.type,
        ...fields,
    };
}

export function baseCredentialProperties(type: string): Record<string, unknown> {
    return {
        id: {
            description: 'The credential id',
            title: 'Id',
            type: 'string',
        },
        name: {
            default: '',
            description: 'User-facing display name for this credential.',
            title: 'Name',
            type: 'string',
        },
        type: {
            const: type,
            default: type,
            title: 'Type',
            type: 'string',
        },
    };
}

export function apiKeySchema(description: string, title = 'Api Key'): Record<string, unknown> {
    return {
        description,
        format: 'password',
        title,
        type: 'string',
        writeOnly: true,
    };
}

export function requireString(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Credential field '${key}' is required and must be a string.`);
    }
    return value;
}

export function optionalString(data: Record<string, unknown>, key: string): string | null {
    const value = data[key];
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error(`Credential field '${key}' must be a string.`);
    return value;
}

export function commonOptions(data: Record<string, unknown>): CredentialOptions {
    return {
        id: typeof data.id === 'string' ? data.id : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
    };
}

export type CredentialModelCard = AnyModelCard;
