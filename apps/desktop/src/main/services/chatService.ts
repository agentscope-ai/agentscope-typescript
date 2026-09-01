import type {
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import { parseMsg } from '@agentscope-ai/agentscope/message';
import type { Msg } from '@agentscope-ai/agentscope/message';
import type { GetSessionsQuery } from '@shared/types/chat';
import type { IpcMain, WebContents } from 'electron';

import type { DesktopServiceRuntime } from '../runtime';

/**
 * Register transport-only chat IPC handlers over the shared service runtime.
 * @param ipcMain
 * @param webContents
 * @param runtime
 */
export function registerChatHandlers(
    ipcMain: IpcMain,
    webContents: WebContents,
    runtime: DesktopServiceRuntime
): void {
    ipcMain.handle('chat:getSessions', (_event, query: GetSessionsQuery) => {
        return runtime.getSessions(query);
    });

    ipcMain.handle('chat:createSession', (_event, agentKey?: string, name?: string) => {
        return runtime.createSession(agentKey, name);
    });

    ipcMain.handle('chat:renameSession', (_event, id: string, name: string) => {
        return runtime.renameSession(id, name);
    });

    ipcMain.handle('chat:pinSession', (_event, id: string, pinned: boolean) => {
        return runtime.pinSession(id, pinned);
    });

    ipcMain.handle('chat:deleteSession', (_event, id: string) => {
        return runtime.deleteSession(id);
    });

    ipcMain.handle('chat:getMessages', (_event, sessionId: string) => {
        return runtime.getMessages(sessionId);
    });

    ipcMain.handle('chat:isRunning', (_event, sessionId: string) => {
        return runtime.isRunning(sessionId);
    });

    ipcMain.handle('chat:addMessage', (_event, sessionId: string, message: Msg) => {
        return runtime.addMessage(sessionId, parseMsg(message));
    });

    ipcMain.handle(
        'chat:sendMessage',
        async (
            _event,
            sessionId: string,
            _agentKey: string,
            message?: Msg,
            event?: UserConfirmResultEvent | ExternalExecutionResultEvent
        ) => {
            await runtime.sendMessage(
                sessionId,
                message ? parseMsg(message) : (event ?? null),
                agentEvent => webContents.send(`agent:event:${sessionId}`, agentEvent)
            );
        }
    );
}
