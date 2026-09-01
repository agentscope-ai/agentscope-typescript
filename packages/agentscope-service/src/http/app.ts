/* eslint-disable jsdoc/require-returns */

import type { AgentScopeServiceApp } from '../app';
import { AGUIProtocolMiddleware } from '../middleware';
import { AgentScopeHTTPRouter, type HTTPMiddleware } from './router';
import {
    registerFoundationRoutes,
    registerKnowledgeBaseRoutes,
    registerLibraryRoutes,
    registerSessionRoutes,
    registerWorkspaceRoutes,
} from './routes';

export interface CreateHTTPRouterOptions {
    /** Convert AgentScope SSE frames to AG-UI wire events. */
    aguiProtocol?: boolean;
    /** Framework-independent response middleware, applied in array order. */
    middleware?: HTTPMiddleware[];
}

/**
 * Build the complete Python-compatible HTTP/SSE surface for one service app.
 * @param app
 * @param options
 */
export function createHTTPRouter(
    app: AgentScopeServiceApp,
    options: CreateHTTPRouterOptions = {}
): AgentScopeHTTPRouter {
    const router = new AgentScopeHTTPRouter(app);
    for (const middleware of options.middleware ?? []) router.use(middleware);
    if (options.aguiProtocol) {
        router.use(async (_request, next) =>
            new AGUIProtocolMiddleware().transformResponse(await next())
        );
    }
    registerFoundationRoutes(router);
    registerSessionRoutes(router);
    registerLibraryRoutes(router);
    registerKnowledgeBaseRoutes(router);
    registerWorkspaceRoutes(router);
    return router;
}

/** Python-style alias for ports that mirror create_app naming. */
export const create_http_router = createHTTPRouter;
