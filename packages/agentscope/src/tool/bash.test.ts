/* eslint-disable jsdoc/require-jsdoc */

import * as os from 'os';
import * as path from 'path';

import { PermissionBehavior, PermissionMode, createPermissionContext } from '../permission';
import { BackendBase, ExecResult } from './backend';
import { Bash, BashTool } from './bash';
import type { ToolChunk } from './response';

class ScriptedBackend extends BackendBase {
    override readonly osName: 'posix' | 'nt';
    calls: Array<{ command: string[]; options?: { cwd?: string; timeout?: number } }> = [];
    results: ExecResult[] = [];

    constructor(osName: 'posix' | 'nt' = 'posix') {
        super();
        this.osName = osName;
    }

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

    override async getCwd(): Promise<string> {
        return '/workspace';
    }

    override async expandUser(filePath: string): Promise<string> {
        return filePath === '~' ? '/home/user' : filePath.replace(/^~\//, '/home/user/');
    }
}

async function one(tool: BashTool, input: Record<string, unknown>): Promise<ToolChunk> {
    const stream = await tool.call(input);
    const chunks: ToolChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks[0];
}

describe('Bash', () => {
    test('executes with the backend-native shell, cwd, and timeout', async () => {
        const backend = new ScriptedBackend();
        backend.results.push(new ExecResult({ exitCode: 0, stdout: Buffer.from('ok\r\n') }));
        const result = await one(Bash({ cwd: '/workspace', backend }), {
            command: 'echo ok',
            timeout: 700000,
        });
        expect(result).toMatchObject({ state: 'running' });
        expect(result.content[0]).toMatchObject({ text: 'ok\n' });
        expect(backend.calls[0]).toEqual({
            command: ['/bin/sh', '-c', 'echo ok'],
            options: { cwd: '/workspace', timeout: 600 },
        });

        const windows = new ScriptedBackend('nt');
        await one(Bash({ backend: windows }), { command: 'echo ok' });
        expect(windows.calls[0].command).toEqual(['cmd', '/c', 'echo ok']);
    });

    test('reports errors, timeouts, and truncates output', async () => {
        const failedBackend = new ScriptedBackend();
        failedBackend.results.push(
            new ExecResult({
                exitCode: 2,
                stdout: Buffer.from('partial'),
                stderr: Buffer.from('bad'),
            })
        );
        expect(
            (await one(Bash({ backend: failedBackend }), { command: 'bad' })).content[0]
        ).toMatchObject({
            text: 'Command failed: bad\n\nStdout:\npartial\nStderr:\nbad',
        });
        const timeoutBackend = new ScriptedBackend();
        timeoutBackend.results.push(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') })
        );
        expect(
            (await one(Bash({ backend: timeoutBackend }), { command: 'sleep', timeout: 100 }))
                .content[0]
        ).toMatchObject({ text: 'Command timed out after 100ms: sleep' });
        const largeBackend = new ScriptedBackend();
        largeBackend.results.push(
            new ExecResult({ exitCode: 0, stdout: Buffer.alloc(30001, 'x') })
        );
        const large = await one(Bash({ backend: largeBackend }), { command: 'large' });
        expect(
            large.content[0].type === 'text' &&
                large.content[0].text.endsWith('... (output truncated)')
        ).toBe(true);
    });

    test('auto-allows read-only commands and asks for injection or danger', async () => {
        const tool = Bash();
        const context = createPermissionContext();
        expect((await tool.checkPermissions({ command: 'git status' }, context)).behavior).toBe(
            PermissionBehavior.ALLOW
        );
        expect(await tool.checkPermissions({ command: 'ls $(rm -rf /)' }, context)).toMatchObject({
            behavior: PermissionBehavior.ASK,
            bypass_immune: true,
        });
        expect(await tool.checkPermissions({ command: 'chmod 777 file' }, context)).toMatchObject({
            behavior: PermissionBehavior.ASK,
            bypass_immune: true,
        });
    });

    test('protects dangerous paths and destructive removal targets', async () => {
        const tool = Bash({ backend: new ScriptedBackend() });
        const context = createPermissionContext();
        expect((await tool.checkPermissions({ command: 'rm .env' }, context)).behavior).toBe(
            PermissionBehavior.ASK
        );
        for (const command of ['rm /', 'rm -rf /usr', 'rmdir ~', 'rm *']) {
            expect(await tool.checkPermissions({ command }, context)).toMatchObject({
                behavior: PermissionBehavior.ASK,
                bypass_immune: true,
            });
        }
        expect(
            (await tool.checkPermissions({ command: 'rm /workspace/file' }, context)).behavior
        ).toBe(PermissionBehavior.PASSTHROUGH);
    });

    test('auto-allows accepted edits only when every target is in scope', async () => {
        const context = createPermissionContext(PermissionMode.ACCEPT_EDITS);
        const directory = path.join(os.tmpdir(), 'agentscope-working');
        context.working_directories[directory] = { path: directory, source: 'test' };
        const tool = Bash();
        expect(
            (await tool.checkPermissions({ command: `cp ${directory}/a ${directory}/b` }, context))
                .behavior
        ).toBe(PermissionBehavior.ALLOW);
        expect(
            (await tool.checkPermissions({ command: `cp /etc/hosts ${directory}/b` }, context))
                .behavior
        ).toBe(PermissionBehavior.PASSTHROUGH);
    });

    test('matches wildcard rules and generates compound suggestions', async () => {
        const tool = Bash();
        expect(await tool.matchRule('git *', { command: 'git status' })).toBe(true);
        expect(await tool.matchRule('git *', { command: 'git' })).toBe(true);
        expect(await tool.matchRule('git:*', { command: 'github' })).toBe(false);
        expect(await tool.matchRule('file\\*.txt', { command: 'file*.txt' })).toBe(true);
        expect(await tool.generateSuggestions({ command: 'git add . && git commit -m x' })).toEqual(
            [
                {
                    tool_name: 'Bash',
                    rule_content: 'git add:*',
                    behavior: PermissionBehavior.ALLOW,
                    source: 'suggested',
                },
                {
                    tool_name: 'Bash',
                    rule_content: 'git commit:*',
                    behavior: PermissionBehavior.ALLOW,
                    source: 'suggested',
                },
            ]
        );
    });
});
