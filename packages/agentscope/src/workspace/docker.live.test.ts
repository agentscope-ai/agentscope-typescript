import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPClient, StdioMCPConfig } from '../mcp';
import { UserMsg } from '../message';
import { DockerBackend, DockerWorkspace } from './docker';

/* eslint-disable jsdoc/require-jsdoc */

const live = process.env.AGENTSCOPE_DOCKER_INTEGRATION_TEST === '1' && process.platform !== 'win32';
const describeDocker = live ? describe : describe.skip;

jest.setTimeout(20 * 60 * 1000);

describeDocker('DockerWorkspace live contract', () => {
    let hostWorkdir: string;
    let workspace: DockerWorkspace;

    beforeAll(async () => {
        hostWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-docker-live-'));
        workspace = new DockerWorkspace({
            workspaceId: `live-${Date.now()}`,
            hostWorkdir,
        });
        await workspace.initialize();
    });

    afterAll(async () => {
        await workspace?.close();
        if (hostWorkdir) await fs.rm(hostWorkdir, { recursive: true, force: true });
    });

    test('executes argv and round-trips binary files through Docker archives', async () => {
        const backend = workspace.getBackend();
        expect(backend).toBeInstanceOf(DockerBackend);
        await expect(backend.execShell(['echo', 'hello world'])).resolves.toEqual(
            expect.objectContaining({ exitCode: 0, stdout: Buffer.from('hello world\n') })
        );
        const payload = Buffer.from([0, 1, 2, 255]);
        await backend.writeFile('/workspace/deep/file.bin', payload);
        await expect(backend.readFile('/workspace/deep/file.bin')).resolves.toEqual(payload);
    });

    test('offloads persistent state and exposes the six builtin tools', async () => {
        await expect(
            workspace.offloadContext('session', [UserMsg({ name: 'user', content: 'hello' })])
        ).resolves.toBe('/workspace/sessions/session/context.jsonl');
        expect(
            await fs.readFile(path.join(hostWorkdir, 'sessions/session/context.jsonl'), 'utf8')
        ).toContain('hello');
        expect((await workspace.listTools()).map(tool => tool.name)).toEqual([
            'Bash',
            'Edit',
            'Glob',
            'Grep',
            'Read',
            'Write',
        ]);
    });

    test('isolates gateway MCP registrations by agent and session', async () => {
        await workspace.addMcp(minimalMcp('server'), {
            agentId: 'agent-a',
            sessionId: 'session-a',
        });

        expect(
            (await workspace.listMcps({ agentId: 'agent-a', sessionId: 'session-a' })).map(
                client => client.name
            )
        ).toEqual(['server']);
        expect(await workspace.listMcps({ agentId: 'agent-a', sessionId: 'session-b' })).toEqual(
            []
        );
    });
});

function minimalMcp(name: string): MCPClient {
    const script = [
        'import json,sys',
        'def send(x): print(json.dumps(x),flush=True)',
        'for line in sys.stdin:',
        ' r=json.loads(line); i=r.get("id"); m=r.get("method","")',
        ' if m=="initialize": send({"jsonrpc":"2.0","id":i,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"test","version":"1"}}})',
        ' elif m=="tools/list": send({"jsonrpc":"2.0","id":i,"result":{"tools":[]}})',
    ].join('\n');
    return new MCPClient({
        name,
        isStateful: true,
        mcpConfig: new StdioMCPConfig({ command: 'python3', args: ['-c', script] }),
    });
}
