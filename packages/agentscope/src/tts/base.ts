/* eslint-disable jsdoc/require-jsdoc */

import type { CredentialBase } from '../credential';
import type { DataBlock } from '../message';
import type { JSONSerializableObject } from '../type';

export class TTSUsage {
    readonly type = 'tts' as const;
    inputTokens: number;
    outputTokens: number;
    time: number;

    constructor(options: { inputTokens: number; outputTokens: number; time: number }) {
        this.inputTokens = options.inputTokens;
        this.outputTokens = options.outputTokens;
        this.time = options.time;
    }

    toJSON(): Record<string, unknown> {
        return {
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            time: this.time,
            type: this.type,
        };
    }
}

export class TTSResponse {
    readonly type = 'tts' as const;
    content: DataBlock | null;
    id: string;
    createdAt: string;
    usage: TTSUsage | null;
    metadata: Record<string, JSONSerializableObject> | null;
    isLast: boolean;

    constructor(options: {
        content: DataBlock | null;
        id?: string;
        createdAt?: string;
        usage?: TTSUsage | null;
        metadata?: Record<string, JSONSerializableObject> | null;
        isLast?: boolean;
    }) {
        this.content = options.content;
        this.id = options.id ?? `${Date.now()}`;
        this.createdAt = options.createdAt ?? new Date().toISOString();
        this.usage = options.usage ?? null;
        this.metadata = options.metadata ?? null;
        this.isLast = options.isLast ?? true;
    }

    toJSON(): Record<string, unknown> {
        return {
            content: this.content,
            id: this.id,
            created_at: this.createdAt,
            type: this.type,
            usage: this.usage,
            metadata: this.metadata,
            is_last: this.isLast,
        };
    }
}

export interface TTSModelOptions<P extends Record<string, unknown>> {
    credential: CredentialBase;
    model: string;
    parameters: P;
    stream?: boolean;
    realtime?: boolean;
}

/** Shared lifecycle for one-shot and realtime text-to-speech models. */
export abstract class TTSModelBase<P extends Record<string, unknown> = Record<string, unknown>> {
    readonly credential: CredentialBase;
    readonly model: string;
    readonly parameters: P;
    readonly stream: boolean;
    readonly realtime: boolean;

    protected constructor(options: TTSModelOptions<P>) {
        this.credential = options.credential;
        this.model = options.model;
        this.parameters = options.parameters;
        this.stream = options.stream ?? true;
        this.realtime = options.realtime ?? false;
    }

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    async push(_text: string, _options: Record<string, unknown> = {}): Promise<TTSResponse> {
        return new TTSResponse({ content: null });
    }

    async withConnection<T>(operation: (model: this) => Promise<T>): Promise<T> {
        if (this.realtime) await this.connect();
        try {
            return await operation(this);
        } finally {
            if (this.realtime) await this.close();
        }
    }

    abstract synthesize(
        text?: string | null,
        options?: Record<string, unknown>
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>>;
}
