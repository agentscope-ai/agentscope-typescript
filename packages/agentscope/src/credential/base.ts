/* eslint-disable jsdoc/require-jsdoc */

import { _generateId } from '../_utils/common';
import type { ChatModelBase } from '../model/base';
import type { AnyModelCard, EmbeddingModelCard, ModelCard, TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';

export interface CredentialOptions {
    id?: string;
    name?: string;
}

export type CredentialSchema = Record<string, unknown>;
export type ChatModelClass = abstract new (...args: never[]) => ChatModelBase;

let chatModelResolver: ((provider: string) => Promise<ChatModelClass>) | null = null;

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

    listTTSModels(): TTSModelCard[] {
        if (this.ttsProvider === null) return [];
        return listModelCards({ kind: 'tts', provider: this.ttsProvider }) as TTSModelCard[];
    }

    listEmbeddingModels(): EmbeddingModelCard[] {
        if (this.embeddingProvider === null) return [];
        return listModelCards({
            kind: 'embedding',
            provider: this.embeddingProvider,
        }) as EmbeddingModelCard[];
    }

    abstract toJSON(): Record<string, unknown>;
}

export function registerChatModelResolver(
    resolver: (provider: string) => Promise<ChatModelClass>
): void {
    chatModelResolver = resolver;
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
