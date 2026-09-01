import type { JSONSerializableObject } from '../type';

/**
 * The usage structure for chat models.
 */
export interface ChatUsage {
    type: 'chat_usage';
    inputTokens: number;
    outputTokens: number;
    time: number;
    metadata?: Record<string, JSONSerializableObject>;
}
