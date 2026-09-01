/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import type { TextBlock } from '../message';
import { EmbeddingModelBase, EmbeddingResponse, EmbeddingUsage } from './base';
import type { EmbeddingModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import { postJSON } from '../model/http-transport';
import type { FetchLike } from '../model/http-transport';
import type { JSONSerializableObject } from '../type';
import type { EmbeddingCacheBase } from './cache';
import { embeddingModelOrder } from './card-order';

interface OpenAIEmbeddingData {
    embedding?: number[] | null;
    dense_embedding?: number[] | null;
    index?: number;
}

interface OpenAIEmbeddingResult {
    data: OpenAIEmbeddingData[];
    usage?: { total_tokens?: number };
}

export interface OpenAIEmbeddingClient {
    create(body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAIEmbeddingResult>;
}

export interface OpenAIEmbeddingModelOptions {
    credential: OpenAICredential;
    model: string;
    dimensions?: number | null;
    parameters?: Record<string, unknown>;
    passDimensions?: boolean;
    embeddingCache?: EmbeddingCacheBase | null;
    contextSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    client?: OpenAIEmbeddingClient;
    fetch?: FetchLike;
}

/** OpenAI text embedding model. */
export class OpenAIEmbeddingModel extends EmbeddingModelBase<string | TextBlock> {
    static readonly textBatchSize = 2048;
    readonly passDimensions: boolean;
    readonly embeddingCache: EmbeddingCacheBase | null;
    private readonly client: OpenAIEmbeddingClient;

    constructor(options: OpenAIEmbeddingModelOptions) {
        super({
            credential: options.credential,
            model: options.model,
            dimensions: options.dimensions,
            parameters: options.parameters,
            contextSize: options.contextSize ?? 8191,
            batchSize: OpenAIEmbeddingModel.textBatchSize,
            maxRetries: options.maxRetries,
            retryDelay: options.retryDelay,
        });
        this.passDimensions = options.passDimensions ?? true;
        this.embeddingCache = options.embeddingCache ?? null;
        this.client =
            options.client ?? createOpenAIEmbeddingClient(options.credential, options.fetch);
    }

    static listModels(): EmbeddingModelCard[] {
        const cards = listModelCards({
            kind: 'embedding',
            provider: 'openai',
        }) as EmbeddingModelCard[];
        return cards.sort(
            (left, right) =>
                embeddingModelOrder('openai', left.name) - embeddingModelOrder('openai', right.name)
        );
    }

    protected isRetryableError(error: unknown): boolean {
        return (
            error instanceof TypeError ||
            (error instanceof Error &&
                [
                    'APIConnectionError',
                    'APITimeoutError',
                    'RateLimitError',
                    'InternalServerError',
                    'HTTP500Error',
                    'HTTP502Error',
                    'HTTP503Error',
                ].includes(error.name))
        );
    }

    protected async callAPI(
        inputs: string[],
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const { signal, ...requestOptions } = options;
        const body: Record<string, unknown> = {
            input: inputs,
            model: this.model,
            encoding_format: 'float',
            ...requestOptions,
        };
        if (this.passDimensions) body.dimensions = this.dimensions;
        const cacheIdentifier = body as JSONSerializableObject;
        const cached = await this.embeddingCache?.retrieve(cacheIdentifier);
        if (cached) return cachedEmbeddingResponse(cached);

        const startedAt = Date.now();
        const response = await this.client.create(body, signal as AbortSignal | undefined);
        const embeddings = Array.from<number[]>({ length: inputs.length });
        response.data.forEach((item, position) => {
            const index = Number.isInteger(item.index) ? (item.index as number) : position;
            if (index >= 0 && index < inputs.length) {
                const embedding = item.embedding ?? item.dense_embedding;
                if (embedding) embeddings[index] = embedding;
            }
        });
        await this.embeddingCache?.store(embeddings, cacheIdentifier);
        return new EmbeddingResponse({
            embeddings,
            usage: new EmbeddingUsage({
                tokens: response.usage?.total_tokens ?? null,
                time: elapsedSeconds(startedAt),
            }),
        });
    }
}

function createOpenAIEmbeddingClient(
    credential: OpenAICredential,
    fetchImplementation?: FetchLike
): OpenAIEmbeddingClient {
    const baseUrl = (credential.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    return {
        create: (body, signal) =>
            postJSON<OpenAIEmbeddingResult>(`${baseUrl}/embeddings`, body, {
                fetch: fetchImplementation,
                signal,
                headers: {
                    authorization: `Bearer ${credential.apiKey}`,
                    ...(credential.organization
                        ? { 'openai-organization': credential.organization }
                        : {}),
                },
            }),
    };
}

function cachedEmbeddingResponse(embeddings: number[][]): EmbeddingResponse {
    return new EmbeddingResponse({
        embeddings,
        usage: new EmbeddingUsage({ tokens: 0, time: 0 }),
        source: 'cache',
    });
}

function elapsedSeconds(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
}
