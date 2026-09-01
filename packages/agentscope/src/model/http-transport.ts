/* eslint-disable jsdoc/require-jsdoc */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface JSONRequestOptions {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    fetch?: FetchLike;
}

export async function postJSON<T>(
    url: string,
    body: Record<string, unknown>,
    options: JSONRequestOptions = {}
): Promise<T> {
    const response = await (options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as T;
}

export async function postSSE(
    url: string,
    body: Record<string, unknown>,
    options: JSONRequestOptions = {}
): Promise<AsyncGenerator<Record<string, unknown>>> {
    const response = await (options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            ...options.headers,
        },
        body: JSON.stringify(body),
        signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('Streaming response body is empty.');
    return parseSSE(response.body);
}

export async function* parseSSE(
    stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const result = await reader.read();
            buffer += decoder.decode(result.value, { stream: !result.done });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
                const parsed = parseFrame(frame);
                if (parsed) yield parsed;
            }
            if (result.done) break;
        }
        if (buffer.trim()) {
            const parsed = parseFrame(buffer);
            if (parsed) yield parsed;
        }
    } finally {
        reader.releaseLock();
    }
}

function parseFrame(frame: string): Record<string, unknown> | null {
    const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
    if (!data || data === '[DONE]') return null;
    const value = JSON.parse(data) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('SSE data must contain a JSON object.');
    }
    return value as Record<string, unknown>;
}

async function responseError(response: Response): Promise<Error> {
    const text = await response.text();
    const error = new Error(
        `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`
    );
    error.name = response.status === 429 ? 'RateLimitError' : `HTTP${response.status}Error`;
    return error;
}
