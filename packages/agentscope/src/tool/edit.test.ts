import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { AgentState } from '../state';
import { Edit, EditTool } from './edit';
import { Read } from './read';
import type { ToolChunk } from './response';

describe('Edit', () => {
    let directory: string;
    let edit: EditTool;

    beforeEach(async () => {
        edit = Edit();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-test-'));
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    const text = (chunk: ToolChunk): string =>
        chunk.content[0].type === 'text' ? chunk.content[0].text : '';

    test('replaces a unique string and emits diff metadata', async () => {
        const filePath = path.join(directory, 'test.ts');
        await fs.writeFile(filePath, 'const x = 1;\nconst y = 2;');
        const result = await edit.call({
            file_path: filePath,
            old_string: 'const x = 1;',
            new_string: 'const x = 42;',
        });
        expect(await fs.readFile(filePath, 'utf8')).toBe('const x = 42;\nconst y = 2;');
        expect(result.metadata).toMatchObject({ file_path: filePath, occurrences: 1 });
        expect(String(result.metadata.diff)).toContain(`--- a/${filePath}`);
    });

    test('handles missing, duplicate, identical, relative, and absent inputs', async () => {
        const filePath = path.join(directory, 'test.ts');
        await fs.writeFile(filePath, 'foo foo foo');
        expect(
            text(
                await edit.call({
                    file_path: filePath,
                    old_string: 'missing',
                    new_string: 'x',
                })
            )
        ).toContain('not found');
        expect(
            text(
                await edit.call({
                    file_path: filePath,
                    old_string: 'foo',
                    new_string: 'bar',
                })
            )
        ).toContain('appears 3 times');
        expect(
            text(
                await edit.call({
                    file_path: filePath,
                    old_string: 'foo',
                    new_string: 'foo',
                })
            )
        ).toContain('identical');
        expect(
            text(
                await edit.call({
                    file_path: 'relative.ts',
                    old_string: 'a',
                    new_string: 'b',
                })
            )
        ).toContain('absolute path');
        expect(
            text(
                await edit.call({
                    file_path: path.join(directory, 'absent.ts'),
                    old_string: 'a',
                    new_string: 'b',
                })
            )
        ).toContain('File not found');
    });

    test('replaces every occurrence', async () => {
        const filePath = path.join(directory, 'test.ts');
        await fs.writeFile(filePath, 'foo foo foo');
        const result = await edit.call({
            file_path: filePath,
            old_string: 'foo',
            new_string: 'bar',
            replace_all: true,
        });
        expect(await fs.readFile(filePath, 'utf8')).toBe('bar bar bar');
        expect(result.metadata.occurrences).toBe(3);
    });

    test('requires a cached read when state is injected', async () => {
        const filePath = path.join(directory, 'test.ts');
        await fs.writeFile(filePath, 'old');
        const state = new AgentState();
        expect(
            text(
                await edit.call({
                    file_path: filePath,
                    old_string: 'old',
                    new_string: 'new',
                    _agent_state: state,
                })
            )
        ).toContain('must first read');
        await Read().call({ file_path: filePath, _agent_state: state });
        expect(
            (
                await edit.call({
                    file_path: filePath,
                    old_string: 'old',
                    new_string: 'new',
                    _agent_state: state,
                })
            ).state
        ).toBe('running');
    });

    test('normalizes Windows line endings before matching', async () => {
        const filePath = path.join(directory, 'windows.txt');
        await fs.writeFile(filePath, 'a\r\nb\r\n');
        await edit.call({ file_path: filePath, old_string: 'a\nb', new_string: 'x' });
        expect(await fs.readFile(filePath, 'utf8')).toBe('x\n');
    });
});
