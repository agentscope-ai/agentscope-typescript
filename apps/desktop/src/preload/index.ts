import type {
    AgentEvent,
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import { Msg } from '@agentscope-ai/agentscope/message';
import { electronAPI } from '@electron-toolkit/preload';
import type { GetSessionsQuery, GetSessionsResult, Session } from '@shared/types/chat';
import type { Config } from '@shared/types/config';
import type { Document } from '@shared/types/document';
import type { MCPServerConfig, MCPServerState } from '@shared/types/mcp';
import type {
    Schedule,
    ScheduleWithStatus,
    ScheduleExecution,
    ExecutionStartedEvent,
    ExecutionFinishedEvent,
} from '@shared/types/schedule';
import type { SkillConfig, WatchDir } from '@shared/types/skill';
import { contextBridge, ipcRenderer } from 'electron';

// Custom APIs for renderer
const api = {
    config: {
        get: (): Promise<Config> => ipcRenderer.invoke('config:get'),
        set: (updates: Partial<Config>): Promise<Config> =>
            ipcRenderer.invoke('config:set', updates),
    },
    chat: {
        getSessions: (query: GetSessionsQuery): Promise<GetSessionsResult> =>
            ipcRenderer.invoke('chat:getSessions', query),
        createSession: (name?: string): Promise<Session> =>
            ipcRenderer.invoke('chat:createSession', name),
        renameSession: (id: string, name: string): Promise<Session> =>
            ipcRenderer.invoke('chat:renameSession', id, name),
        pinSession: (id: string, pinned: boolean): Promise<Session> =>
            ipcRenderer.invoke('chat:pinSession', id, pinned),
        deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('chat:deleteSession', id),
        getMessages: (sessionId: string): Promise<Msg[]> =>
            ipcRenderer.invoke('chat:getMessages', sessionId),
        addMessage: (sessionId: string, message: Msg): Promise<Msg> =>
            ipcRenderer.invoke('chat:addMessage', sessionId, message),
        sendMessage: (
            sessionId: string,
            modelKey: string,
            message?: Msg,
            event?: UserConfirmResultEvent | ExternalExecutionResultEvent
        ): Promise<void> =>
            ipcRenderer.invoke('chat:sendMessage', sessionId, modelKey, message, event),
        isRunning: (sessionId: string): Promise<boolean> =>
            ipcRenderer.invoke('chat:isRunning', sessionId),
    },
    agent: {
        subscribe: (sessionId: string, callback: (event: AgentEvent) => void): (() => void) => {
            const channel = `agent:event:${sessionId}`;
            const handler = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    },
    editor: {
        getDocuments: (): Promise<Document[]> => ipcRenderer.invoke('document:getDocuments'),
        createDocument: (name?: string): Promise<Document> =>
            ipcRenderer.invoke('document:createDocument', name),
        renameDocument: (id: string, name: string): Promise<Document> =>
            ipcRenderer.invoke('document:renameDocument', id, name),
        pinDocument: (id: string): Promise<Document> =>
            ipcRenderer.invoke('document:pinDocument', id),
        deleteDocument: (id: string): Promise<void> =>
            ipcRenderer.invoke('document:deleteDocument', id),
        getContent: (id: string): Promise<string> => ipcRenderer.invoke('document:getContent', id),
        saveContent: (id: string, content: string): Promise<void> =>
            ipcRenderer.invoke('document:saveContent', id, content),
        getMessages: (docId: string): Promise<Msg[]> =>
            ipcRenderer.invoke('document:getMessages', docId),
        isRunning: (docId: string): Promise<boolean> =>
            ipcRenderer.invoke('document:isRunning', docId),
        sendMessage: (
            docId: string,
            agentKey: string,
            msg?: Msg,
            event?: UserConfirmResultEvent | ExternalExecutionResultEvent
        ): Promise<void> => ipcRenderer.invoke('document:sendMessage', docId, agentKey, msg, event),
        subscribeAgentEvents: (
            docId: string,
            callback: (event: AgentEvent) => void
        ): (() => void) => {
            const channel = `agent:event:document:${docId}`;
            const handler = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    },
    schedule: {
        list: (): Promise<ScheduleWithStatus[]> => ipcRenderer.invoke('schedule:list'),
        create: (data: Omit<Schedule, 'id'>): Promise<Schedule> =>
            ipcRenderer.invoke('schedule:create', data),
        update: (id: string, data: Partial<Schedule>): Promise<Schedule> =>
            ipcRenderer.invoke('schedule:update', id, data),
        delete: (id: string): Promise<void> => ipcRenderer.invoke('schedule:delete', id),
        getExecutions: (scheduleId: string): Promise<ScheduleExecution[]> =>
            ipcRenderer.invoke('schedule:getExecutions', scheduleId),
        subscribeExecutionStarted: (
            callback: (event: ExecutionStartedEvent) => void
        ): (() => void) => {
            const channel = 'schedule:execution:started';
            const handler = (_: Electron.IpcRendererEvent, event: ExecutionStartedEvent) =>
                callback(event);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
        subscribeExecutionFinished: (
            callback: (event: ExecutionFinishedEvent) => void
        ): (() => void) => {
            const channel = 'schedule:execution:finished';
            const handler = (_: Electron.IpcRendererEvent, event: ExecutionFinishedEvent) =>
                callback(event);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
        getExecutionMessages: (scheduleId: string, executionId: string): Promise<Msg[]> =>
            ipcRenderer.invoke('schedule:getExecutionMessages', scheduleId, executionId),
        subscribeAgentEvents: (
            scheduleId: string,
            callback: (event: AgentEvent) => void
        ): (() => void) => {
            const channel = `agent:event:schedule:${scheduleId}`;
            const handler = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        },
    },
    mcp: {
        getAll: (): Promise<MCPServerState[]> => ipcRenderer.invoke('mcp:getAll'),
        add: (config: Omit<MCPServerConfig, 'id' | 'createdAt'>): Promise<MCPServerState> =>
            ipcRenderer.invoke('mcp:add', config),
        remove: (id: string): Promise<void> => ipcRenderer.invoke('mcp:remove', id),
        connect: (id: string): Promise<MCPServerState> => ipcRenderer.invoke('mcp:connect', id),
        disconnect: (id: string): Promise<MCPServerState> =>
            ipcRenderer.invoke('mcp:disconnect', id),
        listTools: (id: string): Promise<string[]> => ipcRenderer.invoke('mcp:listTools', id),
    },
    dialog: {
        openFile: (options?: Electron.OpenDialogOptions): Promise<string | null> =>
            ipcRenderer.invoke('dialog:openFile', options),
        openDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
    },
    skill: {
        getAll: (): Promise<SkillConfig[]> => ipcRenderer.invoke('skill:getAll'),
        setActive: (name: string, isActive: boolean): Promise<SkillConfig> =>
            ipcRenderer.invoke('skill:setActive', name, isActive),
        remove: (name: string): Promise<void> => ipcRenderer.invoke('skill:remove', name),
        import: (srcPath: string): Promise<SkillConfig> =>
            ipcRenderer.invoke('skill:import', srcPath),
        getWatchDirs: (): Promise<WatchDir[]> => ipcRenderer.invoke('skill:getWatchDirs'),
        addWatchDir: (path: string): Promise<WatchDir> =>
            ipcRenderer.invoke('skill:addWatchDir', path),
        removeWatchDir: (id: string): Promise<void> =>
            ipcRenderer.invoke('skill:removeWatchDir', id),
    },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI);
        contextBridge.exposeInMainWorld('api', api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-expect-error (define in dts)
    window.electron = electronAPI;
    // @ts-expect-error (define in dts)
    window.api = api;
}
