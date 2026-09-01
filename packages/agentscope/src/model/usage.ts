/* eslint-disable jsdoc/require-jsdoc */

import type { JSONSerializableObject } from '../type';

export interface ChatUsageOptions {
    inputTokens: number;
    outputTokens: number;
    time: number;
    cacheCreationInputTokens?: number;
    cacheInputTokens?: number;
    metadata?: Record<string, JSONSerializableObject> | null;
}

/** Python-compatible usage of one chat model invocation. */
export class ChatUsage {
    readonly type = 'chat' as const;
    inputTokens: number;
    outputTokens: number;
    time: number;
    cacheCreationInputTokens: number;
    cacheInputTokens: number;
    metadata: Record<string, JSONSerializableObject> | null;

    constructor(options: ChatUsageOptions) {
        this.inputTokens = options.inputTokens;
        this.outputTokens = options.outputTokens;
        this.time = options.time;
        this.cacheCreationInputTokens = options.cacheCreationInputTokens ?? 0;
        this.cacheInputTokens = options.cacheInputTokens ?? 0;
        this.metadata = options.metadata ?? null;
    }

    toJSON(): Record<string, unknown> {
        return {
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            time: this.time,
            cache_creation_input_tokens: this.cacheCreationInputTokens,
            cache_input_tokens: this.cacheInputTokens,
            type: this.type,
            metadata: this.metadata,
        };
    }
}
