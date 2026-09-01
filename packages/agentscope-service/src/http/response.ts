/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

/**
 * Serialize a Python-compatible JSON response.
 * @param value
 * @param status
 * @param headers
 */
export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

/**
 * Return an empty response, most commonly HTTP 204.
 * @param status
 * @param headers
 */
export function emptyResponse(status = 204, headers?: HeadersInit): Response {
    return new Response(null, { status, headers });
}

/**
 * Adapt an async iterable to the Web Streams API without buffering.
 * @param iterable
 * @param init
 * @param onCancel
 */
export function iterableResponse(
    iterable: AsyncIterable<string | Uint8Array>,
    init: ResponseInit = {},
    onCancel?: () => void | Promise<void>
): Response {
    const encoder = new TextEncoder();
    const iterator = iterable[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else
                    controller.enqueue(
                        typeof next.value === 'string' ? encoder.encode(next.value) : next.value
                    );
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            await onCancel?.();
            await iterator.return?.();
        },
    });
    return new Response(body, init);
}

/** Encode a UTF-8 filename with Python urllib.parse.quote semantics. */
export function quoteHeaderFilename(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/** Apply Starlette's UTF-8 charset behavior for textual streaming media. */
export function streamingContentType(mediaType: string): string {
    return mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType;
}
