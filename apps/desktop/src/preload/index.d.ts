import type {
    AgentEvent,
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import type { Msg } from '@agentscope-ai/agentscope/message';
import { ElectronAPI } from '@electron-toolkit/preload';
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
import type {
    SkillConfig,
    WatchDir,
    SkillImportResult,
    WatchDirAddResult,
} from '@shared/types/skill';

declare global {
    interface Window {
        electron: ElectronAPI;
        api: {
            config: {
                get: () => Promise<Config>;
                set: (updates: Partial<Config>) => Promise<Config>;
            };
            chat: {
                getSessions: (query: GetSessionsQuery) => Promise<GetSessionsResult>;
                createSession: (name?: string) => Promise<Session>;
                renameSession: (id: string, name: string) => Promise<Session>;
                pinSession: (id: string, pinned: boolean) => Promise<Session>;
                deleteSession: (id: string) => Promise<void>;
                getMessages: (sessionId: string) => Promise<Msg[]>;
                addMessage: (sessionId: string, message: Msg) => Promise<Msg>;
                sendMessage: (
                    sessionId: string,
                    modelKey: string,
                    message?: Msg,
                    event?: ExternalExecutionResultEvent | UserConfirmResultEvent
                ) => Promise<void>;
                isRunning: (sessionId: string) => Promise<boolean>;
            };
            editor: {
                getDocuments: () => Promise<Document[]>;
                createDocument: (name?: string) => Promise<Document>;
                renameDocument: (id: string, name: string) => Promise<Document>;
                pinDocument: (id: string) => Promise<Document>;
                deleteDocument: (id: string) => Promise<void>;
                getContent: (id: string) => Promise<string>;
                saveContent: (id: string, content: string) => Promise<void>;
                getMessages: (docId: string) => Promise<Msg[]>;
                isRunning: (docId: string) => Promise<boolean>;
                sendMessage: (
                    docId: string,
                    agentKey: string,
                    msg?: Msg,
                    event?: ExternalExecutionResultEvent | UserConfirmResultEvent
                ) => Promise<void>;
                subscribeAgentEvents: (
                    docId: string,
                    callback: (event: AgentEvent) => void
                ) => () => void;
            };
            agent: {
                subscribe: (sessionId: string, callback: (event: AgentEvent) => void) => () => void;
            };
            schedule: {
                list: () => Promise<ScheduleWithStatus[]>;
                create: (data: Omit<Schedule, 'id'>) => Promise<Schedule>;
                update: (id: string, data: Partial<Schedule>) => Promise<Schedule>;
                delete: (id: string) => Promise<void>;
                getExecutions: (scheduleId: string) => Promise<ScheduleExecution[]>;
                subscribeExecutionStarted: (
                    callback: (event: ExecutionStartedEvent) => void
                ) => () => void;
                subscribeExecutionFinished: (
                    callback: (event: ExecutionFinishedEvent) => void
                ) => () => void;
                getExecutionMessages: (scheduleId: string, executionId: string) => Promise<Msg[]>;
                subscribeAgentEvents: (
                    scheduleId: string,
                    callback: (event: AgentEvent) => void
                ) => () => void;
            };
            mcp: {
                getAll: () => Promise<MCPServerState[]>;
                add: (config: Omit<MCPServerConfig, 'id' | 'createdAt'>) => Promise<MCPServerState>;
                remove: (id: string) => Promise<void>;
                connect: (id: string) => Promise<MCPServerState>;
                disconnect: (id: string) => Promise<MCPServerState>;
                listTools: (id: string) => Promise<string[]>;
            };
            dialog: {
                openFile: (options?: Electron.OpenDialogOptions) => Promise<string | null>;
                openDirectory: () => Promise<string | null>;
            };
            skill: {
                getAll: () => Promise<SkillConfig[]>;
                setActive: (name: string, isActive: boolean) => Promise<SkillConfig>;
                remove: (name: string) => Promise<void>;
                import: (srcPath: string) => Promise<SkillImportResult>;
                getWatchDirs: () => Promise<WatchDir[]>;
                addWatchDir: (path: string) => Promise<WatchDirAddResult>;
                removeWatchDir: (id: string) => Promise<void>;
            };
        };
    }
}
