import { join } from 'path';

import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';

import { registerConfigHandlers } from './config';
import { shutdownScheduler } from './scheduler';
import { registerChatHandlers } from './services/chatService';
import { registerDocumentHandlers } from './services/documentService';
import { registerMcpHandlers } from './services/mcpHandlers';
import { mcpShutdownAll } from './services/mcpService';
import { registerScheduleHandlers } from './services/scheduleService';
import { registerSkillHandlers } from './services/skillHandlers';
import { ensureDirectories } from './storage';
import icon from '../../resources/icon.png?asset';

interface AppWithQuitting extends Electron.App {
    isQuitting: boolean;
}

(app as AppWithQuitting).isQuitting = false;

let tray: Tray | null = null;

/**
 * Create system tray icon with menu for the application
 *
 * @param mainWindow - The main browser window instance
 */
function createTray(mainWindow: BrowserWindow): void {
    const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 });
    trayIcon.setTemplateImage(true);

    tray = new Tray(trayIcon);
    tray.setToolTip('Friday');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Settings',
            click: () => {
                mainWindow.show();
                mainWindow.focus();
                mainWindow.webContents.send('navigate', '/setting');
            },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => app.quit(),
        },
    ]);

    tray.on('click', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    tray.setContextMenu(contextMenu);
}

/**
 * Create and configure the main browser window
 *
 * @returns The created browser window instance
 */
function createWindow(): BrowserWindow {
    // Create the browser window.
    const mainWindow = new BrowserWindow({
        width: 900,
        height: 670,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 20, y: 12 },
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
        },
    });

    mainWindow.on('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
    });

    // Hide to tray instead of quitting when window is closed
    mainWindow.on('close', e => {
        if (!(app as AppWithQuitting).isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    // mainWindow.webContents.on('did-finish-load', () => {
    //     mainWindow.webContents.setZoomFactor(1)
    // })

    mainWindow.webContents.setWindowOpenHandler(details => {
        shell.openExternal(details.url);
        return { action: 'deny' };
    });

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return mainWindow;
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.electron');

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window);
    });

    ipcMain.on('ping', () => console.log('pong'));
    ipcMain.on('app:quit', () => app.quit());

    ipcMain.handle('dialog:openFile', async (_, options?: Electron.OpenDialogOptions) => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'], ...options });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:openDirectory', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });

    // Ensure storage directories exist
    ensureDirectories();

    // Register IPC handlers for each module (except those needing webContents)
    registerConfigHandlers(ipcMain);
    registerMcpHandlers(ipcMain);
    registerSkillHandlers(ipcMain);

    const mainWindow = createWindow();

    // Register handlers that need webContents
    registerDocumentHandlers(ipcMain, mainWindow.webContents);
    registerChatHandlers(ipcMain, mainWindow.webContents);
    await registerScheduleHandlers(ipcMain, mainWindow.webContents);

    createTray(mainWindow);

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

app.on('before-quit', async () => {
    (app as AppWithQuitting).isQuitting = true;
    await Promise.allSettled([shutdownScheduler(), mcpShutdownAll()]);
});

// Don't quit when all windows are closed (hidden to tray)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
