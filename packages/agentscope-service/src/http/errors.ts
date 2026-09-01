/* eslint-disable jsdoc/require-description, jsdoc/require-param, jsdoc/require-returns */

import { ZodError } from 'zod';

/** An HTTP failure with a stable status code and JSON detail payload. */
export class HTTPError extends Error {
    /**
     *
     * @param statusCode
     * @param detail
     * @param headers
     */
    constructor(
        readonly statusCode: number,
        readonly detail: unknown,
        readonly headers?: HeadersInit
    ) {
        super(typeof detail === 'string' ? detail : 'HTTP request failed.');
        this.name = 'HTTPError';
    }
}

/**
 * Convert a Zod error to FastAPI's public validation-error shape.
 * @param error
 * @param location
 */
export function validationDetail(
    error: ZodError,
    location: 'body' | 'query' | 'path',
    input?: unknown
) {
    return error.issues.map(issue => {
        const missing =
            issue.code === 'invalid_type' &&
            (issue.message.endsWith('received undefined') || !pathExists(input, issue.path));
        return {
            type: missing ? 'missing' : issue.code,
            loc: [location, ...issue.path],
            msg: missing ? 'Field required' : issue.message,
            input: missing ? null : valueAtPath(input, issue.path),
        };
    });
}

/** Return whether every segment of one validation path exists in the input. */
function pathExists(input: unknown, path: PropertyKey[]): boolean {
    let value = input;
    for (const key of path) {
        if (value === null || typeof value !== 'object' || !(key in value)) return false;
        value = (value as Record<PropertyKey, unknown>)[key];
    }
    return true;
}

/** Resolve the rejected input value at one Zod issue path. */
function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
    let value = input;
    for (const key of path) {
        if (value === null || typeof value !== 'object') return null;
        value = (value as Record<PropertyKey, unknown>)[key];
    }
    return value ?? null;
}
