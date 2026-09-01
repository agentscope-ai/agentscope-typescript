import os from 'node:os';
import path from 'node:path';

import { _normalizeLocalPath } from './path';

describe('_normalizeLocalPath', () => {
    test('expands the home directory and resolves relative paths', () => {
        expect(_normalizeLocalPath('~/skills')).toBe(path.resolve(os.homedir(), 'skills'));
        expect(_normalizeLocalPath('./skills')).toBe(path.resolve('skills'));
    });
});
