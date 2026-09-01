/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import type { AgentScopeServiceApp } from '../app';
import { createHTTPRouter, type CreateHTTPRouterOptions } from './app';
import type { AgentScopeHTTPRouter } from './router';

export interface NodeHTTPServerOptions extends CreateHTTPRouterOptions {
    host?: string;
    port?: number;
}

export interface AgentScopeNodeServer {
    readonly app: AgentScopeServiceApp;
    readonly router: AgentScopeHTTPRouter;
    readonly server: Server;
    close(): Promise<void>;
}

/**
 * Adapt a Web Standards router to Node's native request listener contract.
 * @param router
 */
export function createNodeRequestListener(router: AgentScopeHTTPRouter) {
    return async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
        try {
            const request = nodeRequest(incoming);
            const response = await router.fetch(request);
            await writeNodeResponse(response, outgoing);
        } catch {
            if (!outgoing.headersSent) {
                outgoing.statusCode = 500;
                outgoing.setHeader('content-type', 'application/json');
            }
            if (!outgoing.writableEnded) outgoing.end('{"detail":"Internal Server Error"}');
        }
    };
}

/**
 * Open the service lifecycle and listen with Node's dependency-free HTTP server.
 * @param app
 * @param options
 */
export async function serveHTTP(
    app: AgentScopeServiceApp,
    options: NodeHTTPServerOptions = {}
): Promise<AgentScopeNodeServer> {
    await app.open();
    const router = createHTTPRouter(app, options);
    const server = createServer(createNodeRequestListener(router));
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = (): void => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
        });
    } catch (error) {
        await app.close();
        throw error;
    }
    return {
        app,
        router,
        server,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close(error => (error ? reject(error) : resolve()));
            });
            await app.close();
        },
    };
}

/**
 *
 * @param incoming
 */
function nodeRequest(incoming: IncomingMessage): Request {
    const protocol = firstHeader(incoming.headers['x-forwarded-proto']) ?? 'http';
    const host = incoming.headers.host ?? 'localhost';
    const url = new URL(incoming.url ?? '/', `${protocol}://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = { method, headers };
    if (hasBody) {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
    }
    return new Request(url, init);
}

/**
 *
 * @param response
 * @param outgoing
 */
async function writeNodeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (!response.body) {
        outgoing.end();
        return;
    }
    const reader = response.body.getReader();
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            if (!outgoing.write(Buffer.from(item.value))) {
                await new Promise<void>(resolve => outgoing.once('drain', resolve));
            }
        }
        outgoing.end();
    } finally {
        reader.releaseLock();
    }
}

/**
 *
 * @param value
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}
