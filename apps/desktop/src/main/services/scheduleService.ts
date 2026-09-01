import type { Schedule } from '@shared/types/schedule';
import type { IpcMain, WebContents } from 'electron';

import type { DesktopServiceRuntime } from '../runtime';

/**
 * Register transport-only schedule IPC handlers over the shared scheduler.
 * @param ipcMain
 * @param webContents
 * @param runtime
 */
export function registerScheduleHandlers(
    ipcMain: IpcMain,
    webContents: WebContents,
    runtime: DesktopServiceRuntime
): void {
    runtime.onScheduleEvent(event => {
        webContents.send(`agent:event:schedule:${event.scheduleId}`, event.agentEvent);
        if (event.executionStarted) {
            webContents.send('schedule:execution:started', event.executionStarted);
        }
        if (event.executionFinished) {
            webContents.send('schedule:execution:finished', event.executionFinished);
        }
    });

    ipcMain.handle('schedule:create', (_event, params: Omit<Schedule, 'id'>) => {
        return runtime.createSchedule(params);
    });

    ipcMain.handle('schedule:delete', (_event, id: string) => {
        return runtime.deleteSchedule(id);
    });

    ipcMain.handle('schedule:get', (_event, id: string) => {
        return runtime.getSchedule(id);
    });

    ipcMain.handle('schedule:list', () => {
        return runtime.listSchedules();
    });

    ipcMain.handle(
        'schedule:update',
        (_event, id: string, patch: Partial<Omit<Schedule, 'id'>>) => {
            return runtime.updateSchedule(id, patch);
        }
    );

    ipcMain.handle('schedule:getExecutions', (_event, scheduleId: string) => {
        return runtime.getScheduleExecutions(scheduleId);
    });

    ipcMain.handle(
        'schedule:getExecutionMessages',
        (_event, scheduleId: string, executionId: string) => {
            return runtime.getScheduleExecutionMessages(scheduleId, executionId);
        }
    );
}
