import { ToolResponse } from '../tool';

export type JSONSerializableObject =
    | string
    | number
    | boolean
    | null
    | JSONSerializableObject[]
    | { [key: string]: JSONSerializableObject };

/** The reason a reply finished. */
export enum ReplyFinishedReason {
    COMPLETED = 'completed',
    INTERRUPTED = 'interrupted',
    EXCEED_MAX_ITERS = 'exceed_max_iters',
    ERROR = 'error',
}

/** Classification of a fatal error that terminated a reply. */
export enum ErrorType {
    AUTHENTICATION = 'authentication',
    PERMISSION = 'permission',
    RATE_LIMIT = 'rate_limit',
    INVALID_REQUEST = 'invalid_request',
    UPSTREAM = 'upstream',
    CONNECTION = 'connection',
    INTERNAL = 'internal',
    SETUP = 'setup',
    UNKNOWN = 'unknown',
}

/** Structured, UI-facing description of a fatal reply error. */
export class ErrorInfo {
    type: ErrorType;
    message: string;

    /**
     * Create error information.
     * @param options Error fields.
     * @param options.message Sanitized message.
     * @param options.type Stable classification.
     */
    constructor({ message, type = ErrorType.UNKNOWN }: { message: string; type?: ErrorType }) {
        this.type = type;
        this.message = message;
    }
}

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
