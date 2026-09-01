import type { MCPServerCreateConfig } from '@shared/types/mcp';
import type { IpcMain } from 'electron';

import type { DesktopServiceRuntime } from '../runtime';

/**
 * Register transport-only MCP IPC handlers over shared records and clients.
 * @param ipcMain
 * @param runtime
 */
export function registerMcpHandlers(ipcMain: IpcMain, runtime: DesktopServiceRuntime): void {
    ipcMain.handle('mcp:getAll', () => runtime.listMCPs());
    ipcMain.handle('mcp:add', (_event, config: MCPServerCreateConfig) => runtime.addMCP(config));
    ipcMain.handle('mcp:remove', (_event, id: string) => runtime.removeMCP(id));
    ipcMain.handle('mcp:connect', (_event, id: string) => runtime.connectMCP(id));
    ipcMain.handle('mcp:disconnect', (_event, id: string) => runtime.disconnectMCP(id));
    ipcMain.handle('mcp:listTools', (_event, id: string) => runtime.listMCPTools(id));
}
