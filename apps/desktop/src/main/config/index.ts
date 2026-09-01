import type { Config } from '@shared/types/config';
import type { IpcMain } from 'electron';

import { loadConfig, saveConfig } from './storage';

let configCache: Config | null = null;

/**
 * Initialize the configuration cache by loading config from storage
 */
export function initConfig(): void {
    configCache = loadConfig();
}

/**
 * Get the current configuration, loading from storage if not cached
 *
 * @returns The current configuration object
 */
export function getConfig(): Config {
    if (!configCache) {
        configCache = loadConfig();
    }
    return configCache;
}

/**
 * Update the configuration with partial updates and persist to storage
 *
 * @param updates - Partial configuration updates to apply
 * @returns The updated configuration object
 */
export function setConfig(updates: Partial<Config>): Config {
    const current = getConfig();

    // Deep merge configuration
    const updated: Config = {
        onboardingCompleted: updates.onboardingCompleted ?? current.onboardingCompleted,
        tourCompleted: updates.tourCompleted ?? current.tourCompleted,
        username: updates.username ?? current.username,
        language: updates.language ?? current.language,
        models: updates.models ?? current.models,
        agents: updates.agents ?? current.agents,
        chat: {
            ...current.chat,
            ...(updates.chat || {}),
        },
        editor: {
            ...current.editor,
            ...(updates.editor || {}),
        },
        skills: {
            ...current.skills,
            ...(updates.skills || {}),
        },
        telemetry: {
            ...current.telemetry,
            ...(updates.telemetry || {}),
        },
    };

    configCache = updated;
    saveConfig(updated);
    return updated;
}

/**
 * Register IPC handlers for configuration management
 *
 * @param ipcMain - The Electron IPC main instance
 * @param onChange - Optional callback after configuration persistence
 */
export function registerConfigHandlers(
    ipcMain: IpcMain,
    onChange?: (config: Config) => Promise<void>
): void {
    initConfig();

    ipcMain.handle('config:get', () => {
        return getConfig();
    });

    ipcMain.handle('config:set', async (_event, updates: Partial<Config>) => {
        const config = setConfig(updates);
        await onChange?.(config);
        return config;
    });
}
