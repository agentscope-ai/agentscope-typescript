import type { ZodType } from 'zod';
import { ZodError } from 'zod';

import type { AgentScopeServiceApp } from '../app';
import { HTTPError, validationDetail } from './errors';
import { jsonResponse } from './response';

export type HTTPMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface HTTPContext {
    readonly app: AgentScopeServiceApp;
    readonly request: Request;
    readonly url: URL;
    readonly params: Readonly<Record<string, string>>;
    userId(): string;
    query(schema: ZodType): unknown;
    json(schema: ZodType): Promise<unknown>;
}

export type HTTPHandler = (context: HTTPContext) => Response | Promise<Response>;
export type HTTPMiddleware = (
    request: Request,
    next: (request?: Request) => Promise<Response>
) => Promise<Response>;

interface Route {
    method: HTTPMethod;
    path: string;
    expression: RegExp;
    parameterNames: string[];
    handler: HTTPHandler;
}

/** Small Web Standards router used by the service's framework adapters. */
export class AgentScopeHTTPRouter {
    private readonly routes: Route[] = [];
    private readonly middleware: HTTPMiddleware[] = [];

    /**
     *
     * @param app
     */
    constructor(readonly app: AgentScopeServiceApp) {}

    /**
     *
     * @param item
     */
    use(item: HTTPMiddleware): this {
        this.middleware.push(item);
        return this;
    }

    /**
     *
     * @param method
     * @param path
     * @param handler
     */
    route(method: HTTPMethod, path: string, handler: HTTPHandler): this {
        const { expression, parameterNames } = compilePath(path);
        this.routes.push({ method, path, expression, parameterNames, handler });
        return this;
    }

    /**
     *
     * @param path
     * @param handler
     */
    get(path: string, handler: HTTPHandler): this {
        return this.route('GET', path, handler);
    }

    /**
     *
     * @param path
     * @param handler
     */
    post(path: string, handler: HTTPHandler): this {
        return this.route('POST', path, handler);
    }

    /**
     *
     * @param path
     * @param handler
     */
    patch(path: string, handler: HTTPHandler): this {
        return this.route('PATCH', path, handler);
    }

    /**
     *
     * @param path
     * @param handler
     */
    delete(path: string, handler: HTTPHandler): this {
        return this.route('DELETE', path, handler);
    }

    /**
     *
     * @param request
     */
    async fetch(request: Request): Promise<Response> {
        const dispatch = async (index: number, currentRequest: Request): Promise<Response> => {
            const item = this.middleware[index];
            if (item) {
                return item(currentRequest, replacement =>
                    dispatch(index + 1, replacement ?? currentRequest)
                );
            }
            return this.dispatch(currentRequest);
        };
        try {
            return await dispatch(0, request);
        } catch (error) {
            return errorResponse(error);
        }
    }

    /**
     *
     * @param request
     */
    private async dispatch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase() as HTTPMethod;
        let pathMatched = false;
        for (const route of this.routes) {
            const match = route.expression.exec(url.pathname);
            if (!match) continue;
            pathMatched = true;
            if (route.method !== method) continue;
            const params = Object.fromEntries(
                route.parameterNames.map((name, index) => [
                    name,
                    decodeURIComponent(match[index + 1]),
                ])
            );
            return route.handler(new RequestContext(this.app, request, url, params));
        }
        if (pathMatched) {
            throw new HTTPError(405, 'Method Not Allowed');
        }
        throw new HTTPError(404, 'Not Found');
    }
}

/**
 *
 */
class RequestContext implements HTTPContext {
    /**
     *
     * @param app
     * @param request
     * @param url
     * @param params
     */
    constructor(
        readonly app: AgentScopeServiceApp,
        readonly request: Request,
        readonly url: URL,
        readonly params: Readonly<Record<string, string>>
    ) {}

    /**
     *
     */
    userId(): string {
        const value = this.request.headers.get('x-user-id');
        if (!value) {
            throw new HTTPError(422, [
                {
                    type: 'missing',
                    loc: ['header', 'x-user-id'],
                    msg: 'Field required',
                    input: null,
                },
            ]);
        }
        return value;
    }

    /**
     *
     * @param schema
     */
    query(schema: ZodType): unknown {
        const values: Record<string, string | string[]> = {};
        for (const key of new Set(this.url.searchParams.keys())) {
            const all = this.url.searchParams.getAll(key);
            values[key] = all.length === 1 ? all[0] : all;
        }
        try {
            return schema.parse(values);
        } catch (error) {
            if (error instanceof ZodError) {
                throw new HTTPError(422, validationDetail(error, 'query'));
            }
            throw error;
        }
    }

    /**
     *
     * @param schema
     */
    async json(schema: ZodType): Promise<unknown> {
        let value: unknown;
        try {
            value = await this.request.json();
        } catch {
            throw new HTTPError(422, [
                { type: 'json_invalid', loc: ['body'], msg: 'JSON decode error', input: null },
            ]);
        }
        try {
            return schema.parse(value);
        } catch (error) {
            if (error instanceof ZodError) {
                throw new HTTPError(422, validationDetail(error, 'body'));
            }
            throw error;
        }
    }
}

/**
 *
 * @param path
 */
function compilePath(path: string): { expression: RegExp; parameterNames: string[] } {
    const parameterNames: string[] = [];
    const segments = path.split('/').filter(Boolean);
    const pattern = segments
        .map(segment => {
            const match = /^\{([a-zA-Z_][\w]*)(?::path)?\}$/.exec(segment);
            if (!match) return escapeExpression(segment);
            parameterNames.push(match[1]);
            return segment.endsWith(':path}') ? '(.+)' : '([^/]+)';
        })
        .join('/');
    return {
        expression: new RegExp(`^/${pattern}${path === '/' ? '' : '/?'}$`),
        parameterNames,
    };
}

/**
 *
 * @param value
 */
function escapeExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 *
 * @param error
 */
function errorResponse(error: unknown): Response {
    if (error instanceof HTTPError) {
        return jsonResponse({ detail: error.detail }, error.statusCode, error.headers);
    }
    if (error instanceof ZodError) {
        return jsonResponse({ detail: validationDetail(error, 'body') }, 422);
    }
    if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
        const statusCode = (error as Error & { statusCode: number; detail?: unknown }).statusCode;
        const detail = (error as Error & { detail?: unknown }).detail ?? error.message;
        return jsonResponse({ detail }, statusCode);
    }
    return jsonResponse({ detail: 'Internal Server Error' }, 500);
}
