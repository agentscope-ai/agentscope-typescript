/* eslint-disable @typescript-eslint/no-explicit-any, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

export type HubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HubHTTPOptions {
    baseUrl?: string;
    apiToken?: string | null;
    timeout?: number;
    fetch?: HubFetch;
}

/** Convert a timeout in seconds to an AbortSignal without leaking a timer. */
export async function fetchWithTimeout(
    fetcher: HubFetch,
    input: string | URL | Request,
    init: RequestInit,
    timeoutSeconds: number
): Promise<Response> {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return fetcher(input, init);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await fetcher(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/** Append Python-style scalar query parameters to a URL. */
export function withQuery(
    baseUrl: string,
    path: string,
    params?: Record<string, string | number | boolean | null | undefined>
): URL {
    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    return url;
}

export function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, any>)
        : {};
}
