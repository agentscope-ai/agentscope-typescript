import type { ToolResponse } from '../tool/response';

export type JSONSerializableObject =
    | string
    | number
    | boolean
    | null
    | JSONSerializableObject[]
    | { [key: string]: JSONSerializableObject };

export type ToolName = string;
export type ToolChoice = 'auto' | 'none' | 'required' | ToolName;

export interface ToolInputSchema {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
}

export interface ToolSchema {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: ToolInputSchema;
    };
}

/**
 * Defines the possible function types for a tool function:
 * - Synchronous: string
 * - Asynchronous: Promise<string>
 * - Synchronous Generator: Generator<string>
 * - Asynchronous Generator: AsyncGenerator<string>
 * - Synchronous: ToolResponse
 * - Asynchronous: Promise<ToolResponse>
 * - Synchronous Generator: Generator<ToolResponse>
 * - Asynchronous Generator: AsyncGenerator<ToolResponse>
 */
export type ToolFunction = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any
) =>
    | string
    | Promise<string>
    | Generator<string>
    | AsyncGenerator<string>
    | ToolResponse
    | Promise<ToolResponse>
    | Generator<ToolResponse>
    | AsyncGenerator<ToolResponse>;
