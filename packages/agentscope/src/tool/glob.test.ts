import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PermissionBehavior } from '../permission';
import { Glob, GlobTool } from './glob';
import type { ToolChunk } from './response';

describe('Glob', () => {
    let directory: string;
    let glob: GlobTool;

    beforeEach(async () => {
        glob = Glob();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-test-'));
        await fs.mkdir(path.join(directory, 'subdir'));
        await Promise.all([
            fs.writeFile(path.join(directory, 'test1.py'), ''),
            fs.writeFile(path.join(directory, 'test2.py'), ''),
            fs.writeFile(path.join(directory, 'test.txt'), ''),
            fs.writeFile(path.join(directory, 'subdir', 'test3.py'), ''),
        ]);
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    const text = (chunk: ToolChunk): string =>
        chunk.content[0].type === 'text' ? chunk.content[0].text : '';

    test('matches simple, recursive, and Windows-separator patterns', async () => {
        const simple = text(await glob.call({ pattern: '*.py', path: directory }));
        expect(simple).toContain('test1.py');
        expect(simple).not.toContain('test3.py');
        const recursive = text(await glob.call({ pattern: '**/*.py', path: directory }));
        expect(recursive).toContain('test3.py');
        expect(text(await glob.call({ pattern: 'subdir\\*.py', path: directory }))).toBe(
            path.join(directory, 'subdir', 'test3.py')
        );
    });

    test('reports no matches and absent directories', async () => {
        expect(text(await glob.call({ pattern: '*.rs', path: directory }))).toContain(
            'No files found'
        );
        const missing = path.join(directory, 'missing');
        const result = await glob.call({ pattern: '*', path: missing });
        expect(result.state).toBe('error');
        expect(text(result)).toBe(`Directory not found: ${missing}`);
    });

    test('implements permission matching and suggestions', async () => {
        expect((await glob.checkPermissions()).behavior).toBe(PermissionBehavior.PASSTHROUGH);
        expect(await glob.matchRule(`${path.dirname(directory)}/**`, { path: directory })).toBe(
            true
        );
        expect(await glob.matchRule('**/*.py', { pattern: 'src/**/*.py' })).toBe(true);
        expect(await glob.generateSuggestions({ path: directory })).toEqual([
            {
                tool_name: 'Glob',
                rule_content: `${directory}/**`,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ]);
    });
});
