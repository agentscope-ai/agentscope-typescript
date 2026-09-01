import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PermissionBehavior, PermissionMode, createPermissionContext } from '../permission';
import { AgentState } from '../state';
import { Read } from './read';
import type { ToolChunk } from './response';
import { Write, WriteTool } from './write';

describe('Write', () => {
    let temporaryDirectory: string;
    let write: WriteTool;

    beforeEach(async () => {
        write = Write();
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'write-test-'));
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    const text = (chunk: ToolChunk): string =>
        chunk.content[0].type === 'text' ? chunk.content[0].text : '';

    test('writes, overwrites, creates directories, and reports line count', async () => {
        const filePath = path.join(temporaryDirectory, 'a', 'b', 'file.txt');
        const created = await write.call({ file_path: filePath, content: 'one\ntwo' });
        expect(await fs.readFile(filePath, 'utf8')).toBe('one\ntwo');
        expect(text(created)).toContain('(2 lines)');
        expect(created.metadata).toMatchObject({ file_path: filePath, occurrences: 1 });
        expect(String(created.metadata.diff)).toContain('--- /dev/null');

        const overwritten = await write.call({ file_path: filePath, content: 'new' });
        expect(await fs.readFile(filePath, 'utf8')).toBe('new');
        expect(String(overwritten.metadata.diff)).toContain(`--- a/${filePath}`);
    });

    test('returns an error for relative paths', async () => {
        const result = await write.call({ file_path: 'relative.txt', content: 'x' });
        expect(result.state).toBe('error');
        expect(text(result)).toContain('file_path must be an absolute path');
    });

    test('requires a state-injected existing file to be read first', async () => {
        const filePath = path.join(temporaryDirectory, 'existing.txt');
        await fs.writeFile(filePath, 'old');
        const state = new AgentState();
        const denied = await write.call({
            file_path: filePath,
            content: 'new',
            _agent_state: state,
        });
        expect(text(denied)).toContain('has not been read yet');
        expect(await fs.readFile(filePath, 'utf8')).toBe('old');

        await Read().call({ file_path: filePath, _agent_state: state });
        expect(
            (
                await write.call({
                    file_path: filePath,
                    content: 'new',
                    _agent_state: state,
                })
            ).state
        ).toBe('running');
    });

    test('implements dangerous path and accepted-edit permission behavior', async () => {
        const dangerous = await write.checkPermissions(
            { file_path: path.join(temporaryDirectory, '.env') },
            createPermissionContext(PermissionMode.BYPASS)
        );
        expect(dangerous).toMatchObject({
            behavior: PermissionBehavior.ASK,
            bypass_immune: true,
        });

        const context = createPermissionContext(PermissionMode.ACCEPT_EDITS);
        context.working_directories[temporaryDirectory] = {
            path: temporaryDirectory,
            source: 'test',
        };
        expect(
            (
                await write.checkPermissions(
                    { file_path: path.join(temporaryDirectory, 'file.txt') },
                    context
                )
            ).behavior
        ).toBe(PermissionBehavior.ALLOW);
        expect(
            await write.matchRule(`${temporaryDirectory}/**`, {
                file_path: path.join(temporaryDirectory, 'file.txt'),
            })
        ).toBe(true);
    });
});
