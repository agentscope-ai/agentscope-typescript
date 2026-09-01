import { appendFileSync } from 'node:fs';
import { format } from 'node:util';

export type LogLevel = 'INFO' | 'DEBUG' | 'WARNING' | 'ERROR' | 'CRITICAL';

const LOG_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
let activeLevel: LogLevel = 'INFO';
let activeFilePath: string | undefined;

/**
 * Write a message to configured logger targets.
 *
 * @param level Message severity.
 * @param message Message template.
 * @param parameters Template parameters.
 */
function writeLog(level: LogLevel, message: unknown, parameters: unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(activeLevel)) return;

    const rendered = format(message, ...parameters);
    const line = `${new Date().toISOString()} | ${level.padEnd(7)} | ` + `agentscope - ${rendered}`;

    if (level === 'ERROR' || level === 'CRITICAL') {
        console.error(line);
    } else if (level === 'WARNING') {
        console.warn(line);
    } else {
        console.log(line);
    }

    if (activeFilePath) appendFileSync(activeFilePath, `${line}\n`, 'utf8');
}

/** Shared AgentScope logger. */
export const logger = {
    debug(message: unknown, ...parameters: unknown[]): void {
        writeLog('DEBUG', message, parameters);
    },
    info(message: unknown, ...parameters: unknown[]): void {
        writeLog('INFO', message, parameters);
    },
    warning(message: unknown, ...parameters: unknown[]): void {
        writeLog('WARNING', message, parameters);
    },
    error(message: unknown, ...parameters: unknown[]): void {
        writeLog('ERROR', message, parameters);
    },
    critical(message: unknown, ...parameters: unknown[]): void {
        writeLog('CRITICAL', message, parameters);
    },
};

/**
 * Configure the shared AgentScope logger.
 *
 * @param level Minimum severity to emit.
 * @param filePath Optional log file.
 */
export function setupLogger(level: LogLevel, filePath?: string): void {
    if (!LOG_LEVELS.includes(level)) {
        throw new RangeError(
            `Invalid logging level: ${level}. Must be one of ` +
                "'INFO', 'DEBUG', 'WARNING', 'ERROR', 'CRITICAL'."
        );
    }
    activeLevel = level;
    activeFilePath = filePath;
}
