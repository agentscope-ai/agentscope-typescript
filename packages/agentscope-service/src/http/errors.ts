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
export function validationDetail(error: ZodError, location: 'body' | 'query' | 'path') {
    return error.issues.map(issue => ({
        type: issue.code,
        loc: [location, ...issue.path],
        msg: issue.message,
        input: null,
    }));
}
