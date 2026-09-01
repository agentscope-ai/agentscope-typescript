/* eslint-disable jsdoc/require-jsdoc */

import { BackendBase, ExecResult } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { SkillUploadError, WorkspaceService, WorkspaceServiceError } from '../src/service';
import { AgentRecordSchema, InMemoryStorage, SessionConfigSchema } from '../src/storage';
import type { WorkspaceManagerBase } from '../src/workspace-manager';

const trailer = 'N... 100644 100644 100644 1111111 2222222';
const records = (...values: string[]): Buffer => Buffer.from(`${values.join('\0')}\0`);

class MemoryPart {
    private offset = 0;

    constructor(
        private readonly value: Buffer,
        private readonly chunkSize = 3
    ) {}

    async read(size: number): Promise<Uint8Array> {
        const end = Math.min(this.value.length, this.offset + Math.min(size, this.chunkSize));
        const chunk = this.value.subarray(this.offset, end);
        this.offset = end;
        return chunk;
    }
}

class GitBackend extends BackendBase {
    readonly commands: string[][] = [];

    constructor(private readonly results: ExecResult[]) {
        super();
    }

    async execShell(command: string[]): Promise<ExecResult> {
        this.commands.push(command);
        return this.results.shift() ?? new ExecResult({ exitCode: 1 });
    }

    async readFile(): Promise<Buffer> {
        throw new Error('unused');
    }

    async writeFile(): Promise<void> {}
}

describe('WorkspaceService upload contracts', () => {
    test('validates one safe skill root and all upload ceilings', () => {
        expect(
            WorkspaceService.validateManifest(
                {
                    entries: [
                        { path: 'pack/SKILL.md', size: 1 },
                        { path: 'pack/lib/run.py', size: 2 },
                    ],
                },
                2
            )
        ).toBe('pack');
        for (const manifest of [
            { entries: [] },
            { entries: [{ path: 'pack/../SKILL.md', size: 1 }] },
            { entries: [{ path: '/pack/SKILL.md', size: 1 }] },
            { entries: [{ path: 'pack/readme.md', size: 1 }] },
            {
                entries: [
                    { path: 'a/SKILL.md', size: 1 },
                    { path: 'b/run.py', size: 1 },
                ],
            },
        ]) {
            expect(() =>
                WorkspaceService.validateManifest(manifest, manifest.entries.length)
            ).toThrow(SkillUploadError);
        }
        expect(() =>
            WorkspaceService.validateManifest({ entries: [{ path: 'pack/SKILL.md', size: 1 }] }, 2)
        ).toThrow('The manifest lists 1 files but 2 were sent.');
    });

    test('streams a deterministic tar and verifies declared part sizes', async () => {
        const files = [Buffer.from('skill'), Buffer.from("print('hi')")];
        const manifest = {
            entries: [
                { path: 'pack/SKILL.md', size: files[0].length },
                { path: 'pack/lib/run.py', size: files[1].length },
            ],
        };
        const archive = Buffer.concat(
            await collect(
                WorkspaceService.tarStream(
                    manifest,
                    files.map(value => new MemoryPart(value))
                )
            )
        );
        expect(readTar(archive)).toEqual([
            ['pack/SKILL.md', Buffer.from('skill')],
            ['pack/lib/run.py', Buffer.from("print('hi')")],
        ]);
        expect(archive.length % 512).toBe(0);

        const oversized = WorkspaceService.tarStream(
            { entries: [{ path: 'pack/SKILL.md', size: 2 }] },
            [new MemoryPart(Buffer.from('too long'))]
        );
        await expect(collect(oversized)).rejects.toThrow(
            "'pack/SKILL.md' is larger than its declared 2 bytes."
        );
    });
});

describe('WorkspaceService Git parsing', () => {
    test('parses branch divergence and every porcelain-v2 file state', () => {
        expect(
            WorkspaceService.parsePorcelainV2(
                records(
                    '# branch.oid abc123',
                    '# branch.head main',
                    '# branch.ab +2 -3',
                    `1 MM ${trailer} both.py`,
                    `2 R. ${trailer} R100 new.py`,
                    '? old.py',
                    'u UU N... 100644 100644 100644 100644 a b c conflict.py',
                    '? scratch/'
                )
            )
        ).toEqual({
            branch: 'main',
            head: 'abc123',
            ahead: 2,
            behind: 3,
            insertions: 0,
            deletions: 0,
            staged: 2,
            unstaged: 1,
            untracked: 1,
            conflicted: 1,
        });
    });

    test('distinguishes detached/unborn/no-upstream and parses shortstat variants', () => {
        expect(
            WorkspaceService.parsePorcelainV2(
                records('# branch.oid deadbeef', '# branch.head (detached)')
            )
        ).toMatchObject({ branch: null, head: 'deadbeef', ahead: null, behind: null });
        expect(
            WorkspaceService.parsePorcelainV2(
                records('# branch.oid (initial)', '# branch.head main')
            )
        ).toMatchObject({ branch: 'main', head: null });
        expect(
            WorkspaceService.parseShortstat(
                Buffer.from(' 20 files changed, 621 insertions(+), 182 deletions(-)\n')
            )
        ).toEqual([621, 182]);
        expect(
            WorkspaceService.parseShortstat(Buffer.from(' 1 file changed, 1 deletion(-)\n'))
        ).toEqual([0, 1]);
        expect(WorkspaceService.parseShortstat(Buffer.from('fatal'))).toEqual([0, 0]);
    });
});

describe('WorkspaceService session resolution', () => {
    test('resolves stored cwd and combines status with shortstat using argv execution', async () => {
        const storage = new InMemoryStorage();
        const agent = AgentRecordSchema.parse({
            id: 'agent',
            user_id: 'user',
            data: { name: 'Agent', context_config: {}, react_config: {} },
        });
        await storage.upsertAgent('user', agent);
        await storage.upsertSession({
            userId: 'user',
            agentId: 'agent',
            sessionId: 'session',
            config: SessionConfigSchema.parse({
                workspace_id: 'workspace',
                cwd: 'project',
            }),
        });
        const backend = new GitBackend([
            new ExecResult({
                exitCode: 0,
                stdout: records('# branch.oid abc', '# branch.head feature'),
            }),
            new ExecResult({
                exitCode: 0,
                stdout: Buffer.from(' 1 file changed, 3 insertions(+), 1 deletion(-)\n'),
            }),
        ]);
        const workspace = {
            workdir: '/workspace',
            getBackend: () => backend,
        } as unknown as WorkspaceBase;
        const manager = {
            getWorkspace: async () => workspace,
        } as unknown as WorkspaceManagerBase;
        const service = new WorkspaceService(storage, manager, 'secret');

        expect(await service.readStatus('user', 'agent', 'session')).toEqual({
            workdir: '/workspace',
            cwd: '/workspace/project',
            git: expect.objectContaining({
                branch: 'feature',
                insertions: 3,
                deletions: 1,
            }),
        });
        expect(backend.commands).toEqual([
            expect.arrayContaining(['status', '--porcelain=v2', '-z']),
            ['git', '--no-optional-locks', 'diff', '--shortstat', 'HEAD'],
        ]);
        await expect(service.resolve('user', 'agent', 'missing')).rejects.toEqual(
            new WorkspaceServiceError(404, "Session 'missing' not found.")
        );
    });
});

function readTar(archive: Buffer): Array<[string, Buffer]> {
    const entries: Array<[string, Buffer]> = [];
    let offset = 0;
    while (archive.subarray(offset, offset + 512).some(byte => byte !== 0)) {
        const header = archive.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const size = Number.parseInt(
            header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0',
            8
        );
        offset += 512;
        entries.push([
            prefix ? `${prefix}/${name}` : name,
            archive.subarray(offset, offset + size),
        ]);
        offset += Math.ceil(size / 512) * 512;
    }
    return entries;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
    const chunks: Buffer[] = [];
    for await (const value of stream) chunks.push(Buffer.from(value));
    return chunks;
}
