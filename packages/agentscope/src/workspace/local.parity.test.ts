/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as tar from 'tar';

import { HttpMCPConfig, MCPClient } from '../mcp';
import {
    Base64Source,
    DataBlock,
    TextBlock,
    ToolResultBlock,
    URLSource,
    UserMsg,
} from '../message';
import { WorkspaceBase } from './base';
import { LocalWorkspace } from './local';

const ZIP_SKILL = Buffer.from(
    'UEsDBBQAAAAAACecIV0Gzcz6NgAAADYAAAAQAAAAd3JhcHBlZC9TS0lMTC5tZC0tLQpuYW1lOiB6aXAtc2tpbGwKZGVzY3JpcHRpb246IFppcCBza2lsbAotLS0KCiMgWmlwClBLAwQUAAAAAAAnnCFdR93ceQIAAAACAAAAEAAAAHdyYXBwZWQvdG9vbC50eHRva1BLAQIUAxQAAAAAACecIV0Gzcz6NgAAADYAAAAQAAAAAAAAAAAAAACAAQAAAAB3cmFwcGVkL1NLSUxMLm1kUEsBAhQDFAAAAAAAJ5whXUfd3HkCAAAAAgAAABAAAAAAAAAAAAAAAIABZAAAAHdyYXBwZWQvdG9vbC50eHRQSwUGAAAAAAIAAgB8AAAAlAAAAAAA',
    'base64'
);
const ZIP_TRAVERSAL = Buffer.from(
    'UEsDBBQAAAAAAGCcIV37OSuCAwAAAAMAAAALAAAALi4vZXZpbC50eHRiYWRQSwECFAMUAAAAAABgnCFd+zkrggMAAAADAAAACwAAAAAAAAAAAAAAgAEAAAAALi4vZXZpbC50eHRQSwUGAAAAAAEAAQA5AAAALAAAAAAA',
    'base64'
);
const ZIP_WITHOUT_SKILL = Buffer.from(
    'UEsDBBQAAAAAAGCcIV3PAJB/BAAAAAQAAAAOAAAAcGFjay9yZWFkbWUubWRub25lUEsBAhQDFAAAAAAAYJwhXc8AkH8EAAAABAAAAA4AAAAAAAAAAAAAAIABAAAAAHBhY2svcmVhZG1lLm1kUEsFBgAAAAABAAEAPAAAADAAAAAAAA==',
    'base64'
);

describe('LocalWorkspace Python parity', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-workspace-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test('initializes idempotently and binds the six platform tools', async () => {
        const workspace = new LocalWorkspace({ workdir: path.join(root, 'space') });
        await workspace.initialize();
        await workspace.initialize();

        expect(workspace.isAlive).toBe(true);
        expect(await workspace.getInstructions()).toContain(workspace.workdir);
        expect((await workspace.listTools()).map(tool => tool.name)).toEqual([
            process.platform === 'win32' ? 'PowerShell' : 'Bash',
            'Edit',
            'Glob',
            'Grep',
            'Read',
            'Write',
        ]);

        await workspace.close();
        expect(workspace.isAlive).toBe(false);
        expect(WorkspaceBase.pathToFileUri('/workspace/file.txt')).toBe(
            'file:///workspace/file.txt'
        );
        expect(WorkspaceBase.pathToFileUri('C:\\Users\\agent\\file.txt')).toBe(
            'file:///C:/Users/agent/file.txt'
        );
    });

    test('appends complete JSONL messages without mutating inline data', async () => {
        const workspace = new LocalWorkspace({ workdir: root });
        const inline = DataBlock({
            id: 'data-1',
            created_at: '2026-01-01T00:00:00.000Z',
            source: Base64Source({
                data: Buffer.from('image').toString('base64'),
                media_type: 'image/png',
            }),
            name: 'image',
        });
        const first = UserMsg({
            id: 'msg-1',
            created_at: '2026-01-01T00:00:00.000Z',
            name: 'user',
            content: [
                TextBlock({ id: 'text-1', created_at: '2026-01-01T00:00:00.000Z', text: 'look' }),
                inline,
            ],
        });
        const second = UserMsg({
            id: 'msg-2',
            created_at: '2026-01-01T00:00:01.000Z',
            name: 'user',
            content: 'again',
        });

        const outputPath = await workspace.offloadContext('session', [first]);
        await workspace.offloadContext('session', [second]);
        const lines = (await fs.readFile(outputPath, 'utf8'))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(lines).toHaveLength(2);
        expect(lines[0]).toEqual({
            ...first,
            content: [
                first.content[0],
                {
                    ...inline,
                    source: {
                        type: 'url',
                        url: expect.stringMatching(/^workspace:\/\/\/data\/[a-f0-9]{64}\.png$/),
                        media_type: 'image/png',
                    },
                },
            ],
        });
        expect(lines[1]).toEqual(second);
        expect(inline.source.type).toBe('base64');
    });

    test('deduplicates inline data and leaves URL data unchanged', async () => {
        const workspace = new LocalWorkspace({ workdir: root });
        const source = Base64Source({
            data: Buffer.from('same').toString('base64'),
            media_type: 'text/plain',
        });
        const one = await workspace.offloadDataBlock(DataBlock({ source, name: 'one' }));
        const two = await workspace.offloadDataBlock(DataBlock({ source, name: 'two' }));
        const remote = DataBlock({
            source: URLSource({ url: 'https://example.com/a.png', media_type: 'image/png' }),
            name: 'remote',
        });

        expect(one.source).toEqual(two.source);
        expect(await fs.readdir(path.join(root, 'data'))).toHaveLength(1);
        expect(await workspace.offloadDataBlock(remote)).toBe(remote);
    });

    test('offloads mixed tool results and never overwrites a collision', async () => {
        const workspace = new LocalWorkspace({ workdir: root });
        const result = ToolResultBlock({
            id: 'call',
            name: 'Read',
            state: 'success',
            output: [
                TextBlock({ text: 'saved: ' }),
                DataBlock({
                    source: Base64Source({
                        data: Buffer.from('body').toString('base64'),
                        media_type: 'text/plain',
                    }),
                    name: 'file.txt',
                }),
            ],
        });

        const first = await workspace.offloadToolResult('session', result);
        const second = await workspace.offloadToolResult('session', result);

        expect(path.basename(first)).toBe('tool_result-call.txt');
        expect(path.basename(second)).toBe('tool_result-call(1).txt');
        expect(await fs.readFile(first, 'utf8')).toMatch(
            /^saved: <data url='workspace:\/\/\/data\/[a-f0-9]{64}\.txt' name='file.txt' media_type='text\/plain'\/>$/
        );
    });

    test('seeds independent skill partitions and keeps deletions isolated', async () => {
        const source = await createSkill(root, 'source', 'seed', 'Seed description');
        const workspace = new LocalWorkspace({
            workdir: path.join(root, 'workspace'),
            skillPaths: [source],
        });
        await workspace.initialize();

        expect(
            (await workspace.listSkills({ agentId: 'alice' })).map(skill => skill.toJSON())
        ).toEqual([expect.objectContaining({ name: 'seed', description: 'Seed description' })]);
        expect((await workspace.listSkills({ agentId: 'bob' })).map(skill => skill.name)).toEqual([
            'seed',
        ]);

        await workspace.removeSkill('seed', { agentId: 'alice' });
        expect(await workspace.listSkills({ agentId: 'alice' })).toEqual([]);
        expect((await workspace.listSkills({ agentId: 'bob' })).map(skill => skill.name)).toEqual([
            'seed',
        ]);
        expect((await workspace.listSkills()).map(skill => skill.name)).toEqual(['seed']);
        await expect(workspace.listSkills({ agentId: '../escape' })).rejects.toThrow('not usable');
    });

    test('deduplicates skills by content and resolves name and directory conflicts', async () => {
        const workspace = new LocalWorkspace({ workdir: path.join(root, 'workspace') });
        await workspace.initialize();
        const first = await createSkill(root, 'first', 'same name', 'First');
        const duplicate = path.join(root, 'duplicate');
        await fs.cp(first, duplicate, { recursive: true });
        const conflict = await createSkill(root, 'second', 'same name', 'Second');

        await workspace.addSkill(first, { agentId: 'agent' });
        await workspace.addSkill(duplicate, { agentId: 'agent' });
        await workspace.addSkill(conflict, { agentId: 'agent' });

        expect(
            (await workspace.listSkills({ agentId: 'agent' })).map(skill => skill.name).sort()
        ).toEqual(['same name', 'same name (1)']);
        expect((await fs.readdir(path.join(root, 'workspace', 'skills', 'agent'))).sort()).toEqual([
            '.index',
            'same_name',
            'same_name_1',
        ]);
    });

    test('installs wrapped zip and tar archives and cleans staging files', async () => {
        const workspace = new LocalWorkspace({ workdir: path.join(root, 'workspace') });
        await workspace.initialize();
        await workspace.addSkillArchive(bytes(ZIP_SKILL), 'zip', 'ignored', 1024 * 1024, {
            agentId: 'agent',
        });
        const tarSource = await createSkill(root, 'tar-source/wrapped', 'tar-skill', 'Tar skill');
        const tarPath = path.join(root, 'skill.tar');
        await tar.c({ cwd: path.dirname(tarSource), file: tarPath }, [path.basename(tarSource)]);
        await workspace.addSkillArchive(
            bytes(await fs.readFile(tarPath)),
            'tar',
            'ignored',
            1024 * 1024,
            { agentId: 'agent' }
        );

        expect(
            (await workspace.listSkills({ agentId: 'agent' })).map(skill => skill.name).sort()
        ).toEqual(['tar-skill', 'zip-skill']);
        expect(
            (await fs.readdir(workspace.workdir)).filter(name => name.startsWith('.skill-staging-'))
        ).toEqual([]);
    });

    test('rejects traversing, oversized, and skill-less archives without residue', async () => {
        const workspace = new LocalWorkspace({ workdir: path.join(root, 'workspace') });
        await workspace.initialize();

        await expect(
            workspace.addSkillArchive(bytes(ZIP_TRAVERSAL), 'zip', 'pack')
        ).rejects.toThrow();
        await expect(workspace.addSkillArchive(bytes(ZIP_SKILL), 'zip', 'pack', 1)).rejects.toThrow(
            'limit'
        );
        await expect(
            workspace.addSkillArchive(bytes(ZIP_WITHOUT_SKILL), 'zip', 'pack')
        ).rejects.toThrow('no SKILL.md');

        expect(await fs.stat(path.join(root, 'evil.txt')).catch(() => null)).toBeNull();
        expect(
            (await fs.readdir(workspace.workdir)).filter(name => name.startsWith('.skill-staging-'))
        ).toEqual([]);
    });

    test('isolates MCP declarations by agent and session and persists empty scopes', async () => {
        const defaults = [httpMcp('default')];
        const workspace = new LocalWorkspace({
            workdir: path.join(root, 'workspace'),
            defaultMcps: defaults,
        });
        await workspace.initialize();

        const aliceDefault = await workspace.listMcps({ agentId: 'alice', sessionId: 'one' });
        const bobDefault = await workspace.listMcps({ agentId: 'bob', sessionId: 'one' });
        expect(aliceDefault.map(client => client.name)).toEqual(['default']);
        expect(bobDefault.map(client => client.name)).toEqual(['default']);
        expect(aliceDefault[0]).not.toBe(bobDefault[0]);

        await workspace.addMcp(httpMcp('extra'), { agentId: 'alice', sessionId: 'one' });
        await workspace.removeMcp('default', { agentId: 'alice', sessionId: 'one' });
        await workspace.removeMcp('extra', { agentId: 'alice', sessionId: 'one' });
        expect(await workspace.listMcps({ agentId: 'alice', sessionId: 'one' })).toEqual([]);
        expect(
            (await workspace.listMcps({ agentId: 'bob', sessionId: 'one' })).map(item => item.name)
        ).toEqual(['default']);

        const persisted = JSON.parse(
            await fs.readFile(path.join(root, 'workspace', '.mcp'), 'utf8')
        );
        expect(persisted).toEqual({ version: 2, mcps: { alice: { one: [] } } });

        await workspace.close();
        const restored = new LocalWorkspace({ workdir: workspace.workdir, defaultMcps: defaults });
        await restored.initialize();
        expect(await restored.listMcps({ agentId: 'alice', sessionId: 'one' })).toEqual([]);
    });

    test('restores a legacy MCP list while skipping only invalid entries', async () => {
        const workdir = path.join(root, 'workspace');
        await fs.mkdir(workdir, { recursive: true });
        await fs.writeFile(
            path.join(workdir, '.mcp'),
            JSON.stringify([
                {
                    name: 'bad',
                    is_stateful: false,
                    mcp_config: { type: 'stdio_mcp', command: 'invalid' },
                    enable_tools: null,
                    disable_tools: null,
                    execution_timeout: null,
                },
                {
                    name: 'good',
                    is_stateful: false,
                    mcp_config: {
                        type: 'http_mcp',
                        url: 'https://example.com/mcp',
                        headers: null,
                        timeout: 30,
                    },
                    enable_tools: null,
                    disable_tools: null,
                    execution_timeout: null,
                },
            ])
        );
        const workspace = new LocalWorkspace({ workdir });
        await workspace.initialize();

        expect((await workspace.listMcps()).map(client => client.name)).toEqual(['good']);
    });

    test('purges session state and reset restores constructor defaults', async () => {
        const workspace = new LocalWorkspace({
            workdir: path.join(root, 'workspace'),
            defaultMcps: [httpMcp('default')],
        });
        await workspace.initialize();
        await workspace.removeMcp('default', { agentId: 'agent', sessionId: 'session' });
        await workspace.offloadContext('session', [UserMsg({ name: 'user', content: 'text' })]);

        await workspace.purgeSession({ agentId: 'agent', sessionId: 'session' });
        expect(
            await fs.stat(path.join(workspace.workdir, 'sessions', 'session')).catch(() => null)
        ).toBeNull();
        expect(
            (await workspace.listMcps({ agentId: 'agent', sessionId: 'session' })).map(
                item => item.name
            )
        ).toEqual(['default']);

        await workspace.removeMcp('default', { agentId: 'agent', sessionId: 'session' });
        await workspace.reset();
        expect(
            (await workspace.listMcps({ agentId: 'agent', sessionId: 'session' })).map(
                item => item.name
            )
        ).toEqual(['default']);
    });
});

/** Create a minimal skill fixture. */
async function createSkill(
    root: string,
    directory: string,
    name: string,
    description: string
): Promise<string> {
    const skillPath = path.join(root, directory);
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
    );
    return skillPath;
}

/** Create a stateless HTTP MCP fixture. */
function httpMcp(name: string): MCPClient {
    return new MCPClient({
        name,
        isStateful: false,
        mcpConfig: new HttpMCPConfig({ url: `https://example.com/${name}` }),
    });
}

/** Yield one byte chunk. */
async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
    yield value;
}
