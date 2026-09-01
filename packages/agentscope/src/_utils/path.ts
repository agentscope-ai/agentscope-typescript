import os from 'node:os';
import path from 'node:path';

/**
 * Expand home-directory shorthand and return an absolute path.
 *
 * @param value Local path.
 * @returns Normalized absolute path.
 */
export function _normalizeLocalPath(value: string): string {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.resolve(os.homedir(), value.slice(2));
    }
    return path.resolve(value);
}
