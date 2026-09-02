import type { DataBlock, TextBlock } from '../message/block';
import type { JSONSerializableObject } from '../type';

/**
 * The tool response structure.
 */
export interface ToolResponse {
    content: Array<TextBlock | DataBlock>;
    id: string;
    createdAt: string;
    metadata: Record<string, JSONSerializableObject>;
    state: 'success' | 'error' | 'interrupted' | 'running';
    isLast: boolean;
    isInterrupted: boolean;
}

/**
 * Create a tool response object with the given parameters.
 *
 * @param root0
 * @param root0.content
 * @param root0.state
 * @param root0.id
 * @param root0.createdAt
 * @param root0.metadata
 * @param root0.stream
 * @param root0.isLast
 * @param root0.isInterrupted
 * @returns A ToolResponse object
 */
export function createToolResponse({
    content,
    state,
    id = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
    metadata = {},
    stream = false,
    isLast = true,
    isInterrupted = false,
}: {
    content: Array<TextBlock | DataBlock>;
    state: 'success' | 'error' | 'interrupted' | 'running';
    id?: string;
    createdAt?: string;
    metadata?: Record<string, JSONSerializableObject>;
    stream?: boolean;
    isLast?: boolean;
    isInterrupted?: boolean;
}) {
    return {
        content,
        id,
        createdAt,
        metadata,
        state,
        stream,
        isLast,
        isInterrupted,
    } as ToolResponse;
}

/**
 * If the given object conforms to the ToolResponse structure.
 *
 * @param obj
 * @returns True if the object is a ToolResponse, false otherwise
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isToolResponse(obj: any): boolean {
    return (
        obj &&
        typeof obj === 'object' &&
        typeof obj.id === 'string' &&
        typeof obj.createdAt === 'string' &&
        Array.isArray(obj.content) &&
        typeof obj.metadata === 'object' &&
        typeof obj.stream === 'boolean' &&
        typeof obj.isLast === 'boolean' &&
        typeof obj.isInterrupted === 'boolean' &&
        ['success', 'error', 'interrupted', 'running'].includes(obj.state)
    );
}
