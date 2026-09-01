/* eslint-disable jsdoc/require-jsdoc */

import { PermissionBehavior } from '../permission';
import { BackendBase, ExecResult } from './backend';
import { PowerShell } from './powershell';

class ScriptedBackend extends BackendBase {
    calls: Array<{ command: string[]; options?: { cwd?: string; timeout?: number } }> = [];
    results: ExecResult[] = [];

    async execShell(
        command: string[],
        options?: { cwd?: string; timeout?: number }
    ): Promise<ExecResult> {
        this.calls.push({ command, options });
        return this.results.shift() ?? new ExecResult({ exitCode: 0 });
    }

    async readFile(): Promise<Buffer> {
        return Buffer.alloc(0);
    }

    async writeFile(): Promise<void> {}
}

describe('PowerShell', () => {
    test('encodes commands, probes once, normalizes output, and uses cwd', async () => {
        const backend = new ScriptedBackend();
        backend.results.push(
            new ExecResult({ exitCode: 0 }),
            new ExecResult({ exitCode: 0, stdout: Buffer.from('你好\r\nok\r') }),
            new ExecResult({ exitCode: 0, stdout: Buffer.from('cached') })
        );
        const tool = PowerShell({ cwd: 'workspace', backend });
        const first = await tool.call({ command: 'Get-Location' });
        await tool.call({ command: 'Get-Date' });
        expect(first.content[0]).toMatchObject({ text: '你好\nok\n' });
        expect(backend.calls).toHaveLength(3);
        expect(backend.calls[1].command.slice(0, -1)).toEqual([
            'pwsh',
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
        ]);
        const script = Buffer.from(backend.calls[1].command.at(-1)!, 'base64').toString('utf16le');
        expect(script).toContain('[ScriptBlock]::Create');
        expect(backend.calls[1].options).toEqual({ cwd: 'workspace', timeout: 120 });
    });

    test('falls back, reports failures/timeouts, and truncates', async () => {
        const backend = new ScriptedBackend();
        backend.results.push(
            new ExecResult({ exitCode: 127 }),
            new ExecResult({ exitCode: 0 }),
            new ExecResult({
                exitCode: 3,
                stdout: Buffer.from('partial'),
                stderr: Buffer.from('bad'),
            })
        );
        const tool = PowerShell({ backend });
        const failed = await tool.call({ command: 'exit 3' });
        expect(backend.calls[2].command[0]).toBe('powershell.exe');
        expect(failed.state).toBe('error');
        expect(failed.content[0]).toMatchObject({
            text: 'Command failed: exit 3\n\nStdout:\npartial\nStderr:\nbad',
        });

        const timeoutBackend = new ScriptedBackend();
        timeoutBackend.results.push(
            new ExecResult({ exitCode: 0 }),
            new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') })
        );
        const timeout = await PowerShell({ backend: timeoutBackend }).call({
            command: 'sleep',
            timeout: 100,
        });
        expect(timeout.content[0]).toMatchObject({ text: 'Command timed out after 100ms: sleep' });
    });

    test('always asks and never suggests a broad rule', async () => {
        const tool = PowerShell();
        expect((await tool.checkPermissions()).behavior).toBe(PermissionBehavior.ASK);
        expect(await tool.generateSuggestions()).toEqual([]);
    });
});
