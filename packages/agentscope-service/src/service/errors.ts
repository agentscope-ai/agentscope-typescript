/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { DeveloperOrientedException } from '@agentscope-ai/agentscope/exception';
import { ErrorInfo, ErrorType } from '@agentscope-ai/agentscope/type';

const STATUS_TYPES = new Map<number, ErrorType>([
    [400, ErrorType.INVALID_REQUEST],
    [401, ErrorType.AUTHENTICATION],
    [403, ErrorType.PERMISSION],
    [404, ErrorType.INVALID_REQUEST],
    [422, ErrorType.INVALID_REQUEST],
    [429, ErrorType.RATE_LIMIT],
]);

const NETWORK_NAMES = new Set([
    'TransportError',
    'APIConnectionError',
    'APITimeoutError',
    'ClientConnectionError',
    'ClientConnectorError',
]);

const MESSAGES: Record<ErrorType, string> = {
    [ErrorType.AUTHENTICATION]: "Authentication failed — check the model's API key / credential.",
    [ErrorType.PERMISSION]:
        'Request not allowed — the credential lacks permission for this model or endpoint.',
    [ErrorType.RATE_LIMIT]: 'Rate limit or quota exceeded — try again later.',
    [ErrorType.INVALID_REQUEST]: 'The request to the model was rejected as invalid.',
    [ErrorType.UPSTREAM]: 'The upstream model service returned an error.',
    [ErrorType.CONNECTION]: 'Could not reach the model service — network error or timeout.',
    [ErrorType.INTERNAL]: 'An unexpected internal error occurred.',
    [ErrorType.SETUP]:
        "The session could not be prepared — check the agent's model, tools and knowledge bases.",
    [ErrorType.UNKNOWN]: 'The reply failed with an unknown error.',
};

/** Classify a fatal reply failure without leaking provider details. */
export function classifyError(error: unknown): ErrorInfo {
    const type = classifyErrorType(error);
    return new ErrorInfo({ type, message: MESSAGES[type] });
}

/** Classify an error raised before a reply could be assembled. */
export function classifySetupError(error: unknown): ErrorInfo {
    const classified = classifyError(error);
    return classified.type === ErrorType.UNKNOWN
        ? new ErrorInfo({ type: ErrorType.SETUP, message: MESSAGES[ErrorType.SETUP] })
        : classified;
}

function classifyErrorType(error: unknown): ErrorType {
    const status = extractStatus(error);
    if (status !== null) {
        return (
            STATUS_TYPES.get(status) ??
            (status >= 500 ? ErrorType.UPSTREAM : ErrorType.INVALID_REQUEST)
        );
    }
    if (isNetworkError(error)) return ErrorType.CONNECTION;
    if (error instanceof DeveloperOrientedException) return ErrorType.INTERNAL;
    return ErrorType.UNKNOWN;
}

function extractStatus(error: unknown): number | null {
    for (const candidate of errorChain(error)) {
        const record = candidate as unknown as Record<string, unknown>;
        const response = isRecord(record.response) ? record.response : null;
        for (const value of [record.status_code, record.status, response?.status_code]) {
            if (typeof value === 'number' && Number.isInteger(value)) return value;
        }
    }
    return null;
}

function isNetworkError(error: unknown): boolean {
    return errorChain(error).some(candidate => {
        if (candidate instanceof TypeError && /fetch|network/i.test(candidate.message)) return true;
        if (candidate instanceof DOMException && candidate.name === 'TimeoutError') return true;
        let prototype: object | null = candidate;
        while (prototype) {
            const name = (prototype as { constructor?: { name?: string } }).constructor?.name;
            if (name && NETWORK_NAMES.has(name)) return true;
            prototype = Object.getPrototypeOf(prototype);
        }
        return false;
    });
}

function errorChain(root: unknown): Error[] {
    const result: Error[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
        if (!(value instanceof Error) || seen.has(value)) return;
        seen.add(value);
        result.push(value);
        if (value instanceof AggregateError) {
            for (const nested of value.errors) visit(nested);
        }
        visit((value as Error & { cause?: unknown }).cause);
        visit((value as Error & { context?: unknown }).context);
    };
    visit(root);
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
