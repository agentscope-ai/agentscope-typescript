/* eslint-disable jsdoc/require-jsdoc */

import { OllamaCredential } from '../credential';
import type { TextBlock } from '../message';
import { EmbeddingModelBase, EmbeddingResponse, EmbeddingUsage } from './base';
import type { EmbeddingCacheBase } from './cache';
import type { EmbeddingModelCard } from '../model/card';
import type { FetchLike } from '../model/http-transport';
import { postJSON } from '../model/http-transport';

export interface OllamaEmbeddingClient {
    embed(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ embeddings: number[][] }>;
}

export interface OllamaEmbeddingModelOptions {
    credential: OllamaCredential;
    model: string;
    dimensions?: number | null;
    parameters?: Record<string, unknown>;
    embeddingCache?: EmbeddingCacheBase | null;
    contextSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    client?: OllamaEmbeddingClient;
    fetch?: FetchLike;
}

/** Ollama text embedding model. */
export class OllamaEmbeddingModel extends EmbeddingModelBase<string | TextBlock> {
    static readonly textBatchSize = 512;
    readonly host: string | null;
    readonly embeddingCache: EmbeddingCacheBase | null;
    private readonly client: OllamaEmbeddingClient;

    constructor(options: OllamaEmbeddingModelOptions) {
        super({
            credential: options.credential,
            model: options.model,
            dimensions: options.dimensions,
            parameters: options.parameters,
            contextSize: options.contextSize ?? 8192,
            batchSize: OllamaEmbeddingModel.textBatchSize,
            maxRetries: options.maxRetries,
            retryDelay: options.retryDelay,
        });
        this.host = options.credential.host;
        this.embeddingCache = options.embeddingCache ?? null;
        this.client = options.client ?? createOllamaEmbeddingClient(this.host, options.fetch);
    }

    static listModels(): EmbeddingModelCard[] {
        return [];
    }

    protected async callAPI(
        inputs: string[],
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const { signal, ...requestOptions } = options;
        const body = {
            input: inputs,
            model: this.model,
            dimensions: this.dimensions,
            ...requestOptions,
        };
        const cached = await this.embeddingCache?.retrieve(body);
        if (cached) {
            return new EmbeddingResponse({
                embeddings: cached,
                usage: new EmbeddingUsage({ tokens: 0, time: 0 }),
                source: 'cache',
            });
        }
        const startedAt = Date.now();
        const response = await this.client.embed(body, signal as AbortSignal | undefined);
        await this.embeddingCache?.store(response.embeddings, body);
        return new EmbeddingResponse({
            embeddings: response.embeddings,
            usage: new EmbeddingUsage({ time: (Date.now() - startedAt) / 1000 }),
        });
    }
}

function createOllamaEmbeddingClient(
    host: string | null,
    fetchImplementation?: FetchLike
): OllamaEmbeddingClient {
    const baseUrl = (host ?? 'http://localhost:11434').replace(/\/$/, '');
    return {
        embed: (body, signal) =>
            postJSON<{ embeddings: number[][] }>(`${baseUrl}/api/embed`, body, {
                fetch: fetchImplementation,
                signal,
            }),
    };
}
