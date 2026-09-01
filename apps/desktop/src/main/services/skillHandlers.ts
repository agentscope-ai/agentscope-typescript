import type { IpcMain } from 'electron';

import type { DesktopServiceRuntime } from '../runtime';

/**
 * Register transport-only skill IPC handlers over shared loaders and records.
 * @param ipcMain
 * @param runtime
 */
export function registerSkillHandlers(ipcMain: IpcMain, runtime: DesktopServiceRuntime): void {
    ipcMain.handle('skill:getAll', () => runtime.listSkills());
    ipcMain.handle('skill:setActive', (_event, name: string, isActive: boolean) =>
        runtime.setSkillActive(name, isActive)
    );
    ipcMain.handle('skill:remove', (_event, name: string) => runtime.removeSkill(name));
    ipcMain.handle('skill:import', (_event, sourcePath: string) => runtime.importSkill(sourcePath));
    ipcMain.handle('skill:getWatchDirs', () => runtime.getSkillWatchDirs());
    ipcMain.handle('skill:addWatchDir', (_event, directory: string) =>
        runtime.addSkillWatchDir(directory)
    );
    ipcMain.handle('skill:removeWatchDir', (_event, id: string) => runtime.removeSkillWatchDir(id));
}
