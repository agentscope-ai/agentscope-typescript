/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import type { DataBlock, TextBlock } from '../message';
import type { EmbeddingModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';
import type { FetchLike } from '../model/http-transport';
import { postJSON } from '../model/http-transport';
import type { JSONSerializableObject } from '../type';
import {
    EmbeddingModelBase,
    EmbeddingResponse,
    EmbeddingUsage,
    mergeEmbeddingResponses,
} from './base';
import type { EmbeddingCacheBase } from './cache';
import { embeddingModelOrder } from './card-order';

interface GeminiPart {
    text?: string;
    inlineData?: { data: string; mimeType: string };
}

interface GeminiContent {
    parts: GeminiPart[];
}

export interface GeminiEmbeddingClient {
    embedContent(request: {
        model: string;
        contents: GeminiContent[];
        config: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<{ embeddings: Array<{ values: number[] }> }>;
}

interface MultimodalLimits {
    maxElements: number;
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    maxPdfs: number;
}

const DEFAULT_LIMITS: MultimodalLimits = {
    maxElements: 20,
    maxImages: 6,
    maxVideos: 1,
    maxAudios: 1,
    maxPdfs: 1,
};

export interface GeminiEmbeddingModelOptions {
    credential: GeminiCredential;
    model: string;
    dimensions?: number | null;
    parameters?: Record<string, unknown>;
    embeddingCache?: EmbeddingCacheBase | null;
    contextSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    client?: GeminiEmbeddingClient;
    fetch?: FetchLike;
}

/** Unified text and multimodal Gemini embedding model. */
export class GeminiEmbeddingModel extends EmbeddingModelBase<string | TextBlock | DataBlock> {
    static readonly textBatchSize = 100;
    readonly embeddingCache: EmbeddingCacheBase | null;
    private readonly multimodal: boolean;
    private readonly limits: MultimodalLimits;
    private readonly client: GeminiEmbeddingClient;

    constructor(options: GeminiEmbeddingModelOptions) {
        const multimodal = options.model.startsWith('gemini-embedding-2');
        super({
            credential: options.credential,
            model: options.model,
            dimensions: options.dimensions,
            parameters: options.parameters,
            contextSize: options.contextSize ?? 8192,
            batchSize: GeminiEmbeddingModel.textBatchSize,
            maxRetries: options.maxRetries,
            retryDelay: options.retryDelay,
            supportsMultimodal: multimodal,
        });
        this.multimodal = multimodal;
        this.limits = DEFAULT_LIMITS;
        this.embeddingCache = options.embeddingCache ?? null;
        this.client =
            options.client ?? createGeminiEmbeddingClient(options.credential, options.fetch);
    }

    static listModels(): EmbeddingModelCard[] {
        const cards = listModelCards({
            kind: 'embedding',
            provider: 'gemini',
        }) as EmbeddingModelCard[];
        return cards.sort(
            (left, right) =>
                embeddingModelOrder('gemini', left.name) - embeddingModelOrder('gemini', right.name)
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
        const config = { output_dimensionality: this.dimensions, ...options };
        const cacheKey = {
            model: this.model,
            contents: texts,
            output_dimensionality: this.dimensions,
            ...options,
        };
        const cached = await this.embeddingCache?.retrieve(cacheKey as JSONSerializableObject);
        if (cached) return cachedResponse(cached);
        return this.request(
            texts.map(text => ({ parts: [{ text }] })),
            config,
            cacheKey
        );
    }

    private async callMultimodal(
        inputs: Array<string | DataBlock>,
        options: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const contents = inputs.map(item => ({
            parts: [typeof item === 'string' ? { text: item } : dataBlockToPart(item)],
        }));
        return this.request(contents, { output_dimensionality: this.dimensions, ...options });
    }

    private async request(
        contents: GeminiContent[],
        config: Record<string, unknown>,
        cacheKey?: Record<string, unknown>
    ): Promise<EmbeddingResponse> {
        const startedAt = Date.now();
        const { signal, ...providerConfig } = config;
        const response = await this.client.embedContent({
            model: this.model,
            contents,
            config: providerConfig,
            signal: signal as AbortSignal | undefined,
        });
        const embeddings = response.embeddings.map(item => item.values);
        if (cacheKey) {
            await this.embeddingCache?.store(embeddings, cacheKey as JSONSerializableObject);
        }
        return new EmbeddingResponse({
            embeddings,
            usage: new EmbeddingUsage({ time: (Date.now() - startedAt) / 1000 }),
        });
    }

    private splitMultimodalBatches(
        inputs: Array<string | DataBlock>
    ): Array<Array<string | DataBlock>> {
        const batches: Array<Array<string | DataBlock>> = [];
        let current: Array<string | DataBlock> = [];
        let images = 0;
        let videos = 0;
        let audios = 0;
        let pdfs = 0;
        for (const item of inputs) {
            const mediaType = typeof item === 'string' ? '' : item.source.media_type;
            const image = mediaType.startsWith('image/');
            const video = mediaType.startsWith('video/');
            const audio = mediaType.startsWith('audio/');
            const pdf = mediaType === 'application/pdf';
            const exceeds =
                current.length + 1 > this.limits.maxElements ||
                (image && images + 1 > this.limits.maxImages) ||
                (video && videos + 1 > this.limits.maxVideos) ||
                (audio && audios + 1 > this.limits.maxAudios) ||
                (pdf && pdfs + 1 > this.limits.maxPdfs);
            if (exceeds && current.length > 0) {
                batches.push(current);
                current = [];
                images = videos = audios = pdfs = 0;
            }
            current.push(item);
            images += Number(image);
            videos += Number(video);
            audios += Number(audio);
            pdfs += Number(pdf);
        }
        if (current.length > 0) batches.push(current);
        return batches;
    }
}

function dataBlockToPart(block: DataBlock): GeminiPart {
    if (block.source.type === 'url') {
        throw new Error(
            `Gemini embedding API requires inline data (Base64Source). URLSource is not directly supported for embedding. Got URL: ${block.source.url}`
        );
    }
    return {
        inlineData: {
            data: block.source.data,
            mimeType: block.source.media_type,
        },
    };
}

function createGeminiEmbeddingClient(
    credential: GeminiCredential,
    fetchImplementation?: FetchLike
): GeminiEmbeddingClient {
    return {
        async embedContent({ model, contents, config, signal }) {
            const modelPath = `models/${model}`;
            const requests = contents.map(content => ({
                model: modelPath,
                content,
                ...toGeminiConfig(config),
            }));
            return postJSON<{ embeddings: Array<{ values: number[] }> }>(
                `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${encodeURIComponent(credential.apiKey)}`,
                { requests },
                { fetch: fetchImplementation, signal }
            );
        },
    };
}

function toGeminiConfig(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(config).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            value,
        ])
    );
}

function cachedResponse(embeddings: number[][]): EmbeddingResponse {
    return new EmbeddingResponse({
        embeddings,
        usage: new EmbeddingUsage({ tokens: 0, time: 0 }),
        source: 'cache',
    });
}
