import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PermissionBehavior } from '../permission';
import { Grep, GrepTool } from './grep';
import type { ToolChunk } from './response';

describe('Grep', () => {
    let directory: string;
    let grep: GrepTool;

    beforeEach(async () => {
        grep = Grep();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
        await fs.mkdir(path.join(directory, 'subdir'));
        await Promise.all([
            fs.writeFile(path.join(directory, 'test1.py'), "def hello():\n    print('Hello')\n"),
            fs.writeFile(path.join(directory, 'test2.py'), 'def goodbye():\n'),
            fs.writeFile(path.join(directory, 'test.txt'), 'Hello from text\n'),
            fs.writeFile(path.join(directory, 'subdir', 'nested.py'), 'def nested():\n'),
        ]);
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    const text = (chunk: ToolChunk): string =>
        chunk.content[0].type === 'text' ? chunk.content[0].text : '';

    test('supports all output modes and filters', async () => {
        const files = text(
            await grep.call({
                pattern: 'Hello',
                path: directory,
                output_mode: 'files_with_matches',
            })
        );
        expect(files).toContain('test1.py');
        expect(files).toContain('test.txt');
        const content = text(
            await grep.call({ pattern: 'def', path: directory, output_mode: 'content', type: 'py' })
        );
        expect(content).toContain('def hello');
        expect(content).toContain('def nested');
        const counts = text(
            await grep.call({
                pattern: 'def',
                path: directory,
                output_mode: 'count',
                glob: '**/*.py',
            })
        );
        expect(counts).not.toContain('test.txt');
    });

    test('supports case-insensitive and no-match searches', async () => {
        expect(
            text(
                await grep.call({
                    pattern: 'HELLO',
                    path: directory,
                    case_insensitive: true,
                })
            )
        ).toContain('test1.py');
        expect(text(await grep.call({ pattern: 'absent', path: directory }))).toBe(
            'No matches found for pattern: absent'
        );
    });

    test('reports invalid regex and pagination validation', async () => {
        expect(text(await grep.call({ pattern: '[invalid', path: directory }))).toContain(
            'regex parse error'
        );
        expect(text(await grep.call({ pattern: 'x', head_limit: -1 }))).toBe(
            'Error: head_limit must be non-negative.'
        );
        expect(text(await grep.call({ pattern: 'x', offset: -1 }))).toBe(
            'Error: offset must be non-negative.'
        );
    });

    test('paginates output and renders the truncation suffix', async () => {
        const result = text(
            await grep.call({
                pattern: 'def',
                path: directory,
                output_mode: 'content',
                head_limit: 1,
                offset: 1,
            })
        );
        expect(result).toContain('[Showing results with pagination = limit: 1, offset: 1]');
    });

    test('implements permission matching and suggestions', async () => {
        expect((await grep.checkPermissions()).behavior).toBe(PermissionBehavior.PASSTHROUGH);
        expect(await grep.matchRule(`${path.dirname(directory)}/**`, { path: directory })).toBe(
            true
        );
        expect(await grep.generateSuggestions({ path: directory })).toEqual([
            {
                tool_name: 'Grep',
                rule_content: `${directory}/**`,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ]);
    });
});
