import type { DataBlock, TextBlock, ThinkingBlock, ToolCallBlock } from '../message/block';
import type { JSONSerializableObject } from '../type';
import type { ChatUsage } from './usage';

export interface ChatResponse {
    type: 'chat';
    id: string;
    createdAt: string;
    content: Array<TextBlock | ToolCallBlock | ThinkingBlock | DataBlock>;
    usage?: ChatUsage;
    structuredContent?: Record<string, JSONSerializableObject>;
    metadata?: Record<string, JSONSerializableObject>;
}

export interface StructuredResponse {
    type: 'structured';
    id: string;
    createdAt: string;
    content: Record<string, JSONSerializableObject>;
    usage?: ChatUsage;
    metadata?: Record<string, JSONSerializableObject>;
}
