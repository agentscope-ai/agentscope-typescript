/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import type { DataBlock, TextBlock } from '../message';
import {
    EmbeddingModelBase,
    EmbeddingResponse,
    EmbeddingUsage,
    mergeEmbeddingResponses,
} from './base';
import type { EmbeddingCacheBase } from './cache';
import { embeddingModelOrder } from './card-order';
import type { EmbeddingModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import type { FetchLike } from '../model/http-transport';
import { postJSON } from '../model/http-transport';

interface DashScopeResult {
    statusCode?: number;
    output: { embeddings: Array<{ embedding: number[] }> };
    usage?: { total_tokens?: number; image_tokens?: number; input_tokens?: number };
}

export interface DashScopeEmbeddingClient {
    text(body: Record<string, unknown>, signal?: AbortSignal): Promise<DashScopeResult>;
    multimodal(body: Record<string, unknown>, signal?: AbortSignal): Promise<DashScopeResult>;
}

interface MultimodalLimits {
    maxElements: number;
    maxImages: number;
    maxVideos: number;
}

const MODEL_LIMITS: Record<string, MultimodalLimits> = {
    'qwen3-vl-embedding': { maxElements: 20, maxImages: 5, maxVideos: 1 },
    'qwen2.5-vl-embedding': { maxElements: 20, maxImages: 5, maxVideos: 1 },
    'tongyi-embedding-vision-plus': { maxElements: 20, maxImages: 64, maxVideos: 8 },
    'tongyi-embedding-vision-flash': { maxElements: 20, maxImages: 64, maxVideos: 8 },
    'multimodal-embedding-v1': { maxElements: 20, maxImages: 1, maxVideos: 1 },
};

const DEFAULT_LIMITS = { maxElements: 20, maxImages: 1, maxVideos: 1 };
const MULTIMODAL_PREFIXES = [
    'multimodal-embedding-',
    'tongyi-embedding-vision-',
    'qwen3-vl-embedding',
    'qwen2.5-vl-embedding',
];

export interface DashScopeEmbeddingModelOptions {
    credential: DashScopeCredential;
    model: string;
    dimensions?: number | null;
    parameters?: Record<string, unknown>;
    embeddingCache?: EmbeddingCacheBase | null;
    contextSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    client?: DashScopeEmbeddingClient;
    fetch?: FetchLike;
}

/** Unified text and multimodal DashScope embedding model. */
export class DashScopeEmbeddingModel extends EmbeddingModelBase<string | TextBlock | DataBlock> {
    static readonly textBatchSize = 10;
    readonly apiKey: string;
    readonly embeddingCache: EmbeddingCacheBase | null;
    private readonly multimodal: boolean;
    private readonly limits: MultimodalLimits;
    private readonly client: DashScopeEmbeddingClient;

    constructor(options: DashScopeEmbeddingModelOptions) {
        const multimodal = MULTIMODAL_PREFIXES.some(prefix => options.model.startsWith(prefix));
        super({
            credential: options.credential,
            model: options.model,
            dimensions: options.dimensions,
            parameters: options.parameters,
            contextSize: options.contextSize ?? 8192,
            batchSize: DashScopeEmbeddingModel.textBatchSize,
            maxRetries: options.maxRetries,
            retryDelay: options.retryDelay,
            supportsMultimodal: multimodal,
        });
        this.multimodal = multimodal;
        this.limits = MODEL_LIMITS[options.model] ?? DEFAULT_LIMITS;
        this.apiKey = options.credential.apiKey;
        this.embeddingCache = options.embeddingCache ?? null;
        this.client = options.client ?? createDashScopeEmbeddingClient(this.apiKey, options.fetch);
    }

    static listModels(): EmbeddingModelCard[] {
        const cards = listModelCards({
            kind: 'embedding',
            provider: 'dashscope',
        }) as EmbeddingModelCard[];
        return cards.sort(
            (left, right) =>
                embeddingModelOrder('dashscope', left.name) -
                embeddingModelOrder('dashscope', right.name)
        );
    }

    override async call(
        inputs: Array<string | TextBlock | DataBlock>,
        options: Record<string, unknown> = {}
    ): Promise<EmbeddingResponse> {
        if (!this.multimodal) return super.call(inputs, options);
        if (inputs.length === 0) return super.call(inputs, options);
        const normalized = inputs.map(item => {
            if (typeof item === 'string') return item;
            return item.type === 'text' ? item.text : item;
        });
        const responses = await Promise.all(
            this.splitMultimodalBatches(normalized).map(batch => this.callWithRetry(batch, options))
        );
        return mergeEmbeddingResponses(responses);
    }

    static formatDataBlock(block: DataBlock): Record<string, string> {
        const { source } = block;
        if (source.media_type.startsWith('video/')) {
            if (source.type !== 'url') {
                throw new Error(
                    `Multimodal embedding API only supports URL input for video data, got ${source.type}.`
                );
            }
            return { video: source.url };
        }
        if (source.media_type.startsWith('image/')) {
            return source.type === 'base64'
                ? { image: `data:${source.media_type};base64,${source.data}` }
                : { image: source.url };
        }
        throw new Error(
            `Unsupported media type '${source.media_type}' in DataBlock. Expected image/* or video/*.`
        );
    }

    protected isRetryableError(error: unknown): boolean {
        return error instanceof Error && error.name === 'RuntimeError';
    }

    protected callAPI(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        return this.multimodal
            ? this.callMultimodal(inputs, options)
            : this.callText(inputs, options);
    }

    private async callText(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const texts = inputs.map(item => {
            if (typeof item !== 'string') {
                throw new Error(
                    `Text embedding model '${this.model}' only accepts string inputs, got DataBlock.`
                );
            }
            return item;
        });
        const { signal, ...requestOptions } = options;
        const body = {
            input: texts,
            model: this.model,
            dimension: this.dimensions,
            ...requestOptions,
        };
        const cached = await this.embeddingCache?.retrieve(body);
        if (cached) return cachedResponse(cached);
        const startedAt = Date.now();
        const response = await this.client.text(body, signal as AbortSignal | undefined);
        assertSuccessful(response, 'text');
        const embeddings = response.output.embeddings.map(item => item.embedding);
        await this.embeddingCache?.store(embeddings, body);
        return new EmbeddingResponse({
            embeddings,
            usage: new EmbeddingUsage({
                tokens: response.usage?.total_tokens ?? null,
                time: (Date.now() - startedAt) / 1000,
            }),
        });
    }

    private async callMultimodal(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const formatted = inputs.map(item =>
            typeof item === 'string'
                ? { text: item }
                : DashScopeEmbeddingModel.formatDataBlock(item)
        );
        const { signal, ...requestOptions } = options;
        const body = { input: formatted, model: this.model, ...requestOptions };
        const cached = await this.embeddingCache?.retrieve(body);
        if (cached) return cachedResponse(cached);
        const startedAt = Date.now();
        const response = await this.client.multimodal(body, signal as AbortSignal | undefined);
        assertSuccessful(response, 'multimodal');
        const embeddings = response.output.embeddings.map(item => item.embedding);
        await this.embeddingCache?.store(embeddings, body);
        return new EmbeddingResponse({
            embeddings,
            usage: new EmbeddingUsage({
                tokens: (response.usage?.image_tokens ?? 0) + (response.usage?.input_tokens ?? 0),
                time: (Date.now() - startedAt) / 1000,
            }),
        });
    }

    private splitMultimodalBatches(
        inputs: Array<string | DataBlock>
    ): Array<Array<string | DataBlock>> {
        const batches: Array<Array<string | DataBlock>> = [];
        let current: Array<string | DataBlock> = [];
        let images = 0;
        let videos = 0;
        for (const item of inputs) {
            const mediaType = typeof item === 'string' ? '' : item.source.media_type;
            const image = mediaType.startsWith('image/');
            const video = mediaType.startsWith('video/');
            const exceeds =
                current.length + 1 > this.limits.maxElements ||
                (image && images + 1 > this.limits.maxImages) ||
                (video && videos + 1 > this.limits.maxVideos);
            if (exceeds && current.length > 0) {
                batches.push(current);
                current = [];
                images = videos = 0;
            }
            current.push(item);
            images += Number(image);
            videos += Number(video);
        }
        if (current.length > 0) batches.push(current);
        return batches;
    }
}

function createDashScopeEmbeddingClient(
    apiKey: string,
    fetchImplementation?: FetchLike
): DashScopeEmbeddingClient {
    const baseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings';
    const request = (path: string, body: Record<string, unknown>, signal?: AbortSignal) =>
        postJSON<DashScopeResult>(`${baseUrl}/${path}/${path}`, body, {
            fetch: fetchImplementation,
            signal,
            headers: { authorization: `Bearer ${apiKey}` },
        });
    return {
        text: (body, signal) => request('text-embedding', toDashScopeBody(body, 'texts'), signal),
        multimodal: (body, signal) =>
            request('multimodal-embedding', toDashScopeBody(body, 'contents'), signal),
    };
}

function toDashScopeBody(
    body: Record<string, unknown>,
    inputKey: 'texts' | 'contents'
): Record<string, unknown> {
    const { model, input, ...parameters } = body;
    return { model, input: { [inputKey]: input }, parameters };
}

function assertSuccessful(response: DashScopeResult, kind: string): void {
    if (response.statusCode != null && response.statusCode !== 200) {
        const error = new Error(`DashScope ${kind} embedding API error.`);
        error.name = 'RuntimeError';
        throw error;
    }
}

function cachedResponse(embeddings: number[][]): EmbeddingResponse {
    return new EmbeddingResponse({
        embeddings,
        usage: new EmbeddingUsage({ tokens: 0, time: 0 }),
        source: 'cache',
    });
}
