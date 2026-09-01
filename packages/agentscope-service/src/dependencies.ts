/* eslint-disable jsdoc/require-jsdoc */

import type { AgentScopeServiceApp } from './app';

export class ServiceDependencyError extends Error {
    constructor(
        readonly statusCode: 401 | 503,
        readonly detail: string
    ) {
        super(detail);
        this.name = 'ServiceDependencyError';
    }
}

export type UserIdHeaders = Headers | Record<string, string | string[] | undefined>;

export function getCurrentUserId(headers: UserIdHeaders): string {
    const value =
        headers instanceof Headers
            ? headers.get('x-user-id')
            : Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1];
    const userId = Array.isArray(value) ? value[0] : value;
    if (!userId) throw new ServiceDependencyError(401, 'X-User-ID header is required.');
    return userId;
}

export const getStorage = (app: AgentScopeServiceApp) => app.storage;
export const getMessageBus = (app: AgentScopeServiceApp) => app.messageBus;
export const getWorkspaceManager = (app: AgentScopeServiceApp) => app.workspaceManager;
export const getDownloadSecret = (app: AgentScopeServiceApp) => app.downloadSecret;
export const getExtraAgentMiddlewares = (app: AgentScopeServiceApp) => app.extraAgentMiddlewares;
export const getExtraAgentTools = (app: AgentScopeServiceApp) => app.extraAgentTools;
export const getChannelClients = (app: AgentScopeServiceApp) => app.channelClients;
export const getResourceAccessService = (app: AgentScopeServiceApp) => app.services.resourceAccess;
export const getChatService = (app: AgentScopeServiceApp) => app.services.chat;
export const getSessionService = (app: AgentScopeServiceApp) => app.services.session;
export const getWorkspaceService = (app: AgentScopeServiceApp) => app.services.workspace;
export const getChatRunRegistry = (app: AgentScopeServiceApp) => app.managers.chatRuns;
export const getSchedulerManager = (app: AgentScopeServiceApp) => app.managers.scheduler;
export const getBackgroundTaskManager = (app: AgentScopeServiceApp) => app.managers.backgroundTasks;

export function getKnowledgeBaseManager(app: AgentScopeServiceApp) {
    if (!app.knowledgeBaseManager) {
        throw new ServiceDependencyError(
            503,
            'Knowledge base feature is disabled — pass a knowledgeBaseManager to createApp() to enable it.'
        );
    }
    return app.knowledgeBaseManager;
}

export function getBlobStore(app: AgentScopeServiceApp) {
    if (!app.blobStore) {
        throw new ServiceDependencyError(
            503,
            'Blob store is not configured — pass a knowledgeBaseManager (and optionally a blobStore) to createApp() to enable knowledge base features.'
        );
    }
    return app.blobStore;
}

export function getKnowledgeBaseService(app: AgentScopeServiceApp) {
    const service = app.services.knowledgeBase;
    if (!service) {
        throw new ServiceDependencyError(
            503,
            'Knowledge base feature is disabled — pass a knowledgeBaseManager to createApp() to enable it.'
        );
    }
    return service;
}

export function getKnowledgeParsers(app: AgentScopeServiceApp) {
    if (!app.knowledgeParsers) {
        throw new ServiceDependencyError(
            503,
            'Knowledge base feature is disabled — pass a knowledgeBaseManager to createApp() to enable it.'
        );
    }
    return app.knowledgeParsers;
}

export function getKnowledgeChunkers(app: AgentScopeServiceApp) {
    if (!app.knowledgeChunkers) {
        throw new ServiceDependencyError(
            503,
            'Knowledge base feature is disabled — pass a knowledgeBaseManager to createApp() to enable it.'
        );
    }
    return app.knowledgeChunkers;
}
