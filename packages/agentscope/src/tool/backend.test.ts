/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { BackendBase, ExecResult, LocalBackend, normalizeNewlines } from './backend';

class MemoryBackend extends BackendBase {
    commands: string[][] = [];
    files = new Map<string, Buffer>();

    async execShell(command: string[]): Promise<ExecResult> {
        this.commands.push(command);
        if (command[0] === 'pwd') {
            return new ExecResult({ exitCode: 0, stdout: Buffer.from('/workspace\n') });
        }
        return new ExecResult({ exitCode: 0 });
    }

    async readFile(filePath: string): Promise<Buffer> {
        return this.files.get(filePath) ?? Buffer.alloc(0);
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        this.files.set(filePath, Buffer.from(data));
    }
}

describe('builtin tool backends', () => {
    test('provides remote-safe POSIX path and stream defaults', async () => {
        const backend = new MemoryBackend();
        expect(backend.absolutePath('../file', '/workspace/subdir')).toBe('/workspace/file');
        expect(await backend.getCwd()).toBe('/workspace');
        async function* source(): AsyncGenerator<Buffer> {
            yield Buffer.from('abc');
            yield Buffer.from('def');
        }
        await backend.writeStream('/file', source());
        const chunks: string[] = [];
        for await (const chunk of backend.readStream('/file', 2)) {
            chunks.push(chunk.toString());
        }
        expect(chunks).toEqual(['ab', 'cd', 'ef']);
    });

    test('executes and manages local files', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-backend-'));
        const backend = new LocalBackend();
        try {
            const filePath = path.join(directory, 'nested', 'file.txt');
            await backend.writeFile(filePath, Buffer.from('hello'));
            expect(await backend.readFile(filePath)).toEqual(Buffer.from('hello'));
            expect(await backend.fileExists(filePath)).toBe(true);
            expect(await backend.isDirectory(path.dirname(filePath))).toBe(true);
            expect(await backend.listDirectory(directory, true)).toEqual([filePath]);
            expect(await backend.stat(filePath)).toMatchObject({
                name: 'file.txt',
                isDir: false,
                sizeBytes: 5,
            });
            const result = await backend.execShell([
                process.execPath,
                '-e',
                "process.stdout.write('ok')",
            ]);
            expect(result).toMatchObject({ exitCode: 0, stdout: Buffer.from('ok') });
        } finally {
            await backend.deletePath(directory);
        }
    });

    test('normalizes all common line endings', () => {
        expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    });
});
