/* eslint-disable jsdoc/require-jsdoc */

import type { CredentialBase } from '../credential';
import type { DataBlock, TextBlock } from '../message';
import type { Embedding } from '../type';

export type EmbeddingInput = string | TextBlock | DataBlock;

export class EmbeddingUsage {
    readonly type = 'embedding' as const;
    time: number;
    tokens: number | null;

    constructor(options: { time: number; tokens?: number | null }) {
        this.time = options.time;
        this.tokens = options.tokens ?? null;
    }

    toJSON(): Record<string, unknown> {
        return { time: this.time, tokens: this.tokens, type: this.type };
    }
}

export class EmbeddingResponse {
    readonly type = 'embedding' as const;
    embeddings: Embedding[];
    id: string;
    createdAt: string;
    usage: EmbeddingUsage | null;
    source: 'cache' | 'api';

    constructor(options: {
        embeddings: Embedding[];
        id?: string;
        createdAt?: string;
        usage?: EmbeddingUsage | null;
        source?: 'cache' | 'api';
    }) {
        this.embeddings = options.embeddings;
        this.id = options.id ?? `${Date.now()}`;
        this.createdAt = options.createdAt ?? new Date().toISOString();
        this.usage = options.usage ?? null;
        this.source = options.source ?? 'api';
    }

    toJSON(): Record<string, unknown> {
        return {
            embeddings: this.embeddings,
            id: this.id,
            created_at: this.createdAt,
            type: this.type,
            usage: this.usage,
            source: this.source,
        };
    }
}

export interface EmbeddingModelOptions {
    credential: CredentialBase;
    model: string;
    dimensions?: number | null;
    parameters?: Record<string, unknown>;
    contextSize: number;
    batchSize: number;
    maxRetries?: number;
    retryDelay?: number;
    supportsMultimodal?: boolean;
}

/** Concurrent batching and per-batch retry contract for embedding models. */
export abstract class EmbeddingModelBase<T extends EmbeddingInput = EmbeddingInput> {
    readonly credential: CredentialBase;
    readonly model: string;
    readonly dimensions: number;
    readonly parameters: Record<string, unknown>;
    readonly contextSize: number;
    batchSize: number;
    readonly maxRetries: number;
    readonly retryDelay: number;
    readonly supportsMultimodal: boolean;

    protected constructor(options: EmbeddingModelOptions) {
        const parameters = { ...(options.parameters ?? {}) };
        const legacyDimensions = parameters.dimensions;
        delete parameters.dimensions;
        const dimensions = options.dimensions ?? Number(legacyDimensions);
        if (!Number.isInteger(dimensions) || dimensions <= 0) {
            throw new Error(`dimensions must be a positive integer, got ${dimensions}.`);
        }
        this.credential = options.credential;
        this.model = options.model;
        this.dimensions = dimensions;
        this.parameters = parameters;
        this.contextSize = options.contextSize;
        this.batchSize = options.batchSize;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 1;
        this.supportsMultimodal = options.supportsMultimodal ?? false;
    }

    async call(inputs: T[], options: Record<string, unknown> = {}): Promise<EmbeddingResponse> {
        if (inputs.length === 0) {
            return new EmbeddingResponse({
                embeddings: [],
                usage: new EmbeddingUsage({ tokens: 0, time: 0 }),
            });
        }
        const normalized: Array<string | DataBlock> = inputs.map(input => {
            if (typeof input === 'string') return input;
            return input.type === 'text' ? input.text : (input as DataBlock);
        });
        const batches = Array.from(
            { length: Math.ceil(normalized.length / this.batchSize) },
            (_, index) => normalized.slice(index * this.batchSize, (index + 1) * this.batchSize)
        );
        const responses = await Promise.all(
            batches.map(batch => this.callWithRetry(batch, options))
        );
        return mergeEmbeddingResponses(responses);
    }

    protected abstract callAPI(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse>;

    protected isRetryableError(_error: unknown): boolean {
        return false;
    }

    protected async callWithRetry(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await this.callAPI(inputs, options);
            } catch (error) {
                lastError = error;
                if (!this.isRetryableError(error) || attempt === this.maxRetries) throw error;
                if (this.retryDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay * 1000));
                }
            }
        }
        throw lastError;
    }
}

export function mergeEmbeddingResponses(responses: EmbeddingResponse[]): EmbeddingResponse {
    if (responses.length === 1) return responses[0];
    return new EmbeddingResponse({
        embeddings: responses.flatMap(response => response.embeddings),
        usage: new EmbeddingUsage({
            tokens: responses.reduce((sum, response) => sum + (response.usage?.tokens ?? 0), 0),
            time: responses.reduce((sum, response) => sum + (response.usage?.time ?? 0), 0),
        }),
    });
}
