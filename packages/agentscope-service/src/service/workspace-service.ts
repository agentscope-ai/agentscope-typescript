/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '@agentscope-ai/agentscope/logger';
import type { BackendBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import type { StorageBase } from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';
import {
    DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS,
    signDownloadToken,
    verifyDownloadToken,
} from './download-token';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_FILE_COUNT = 100;
export const MAX_CONCURRENT_INSTALLS = 5;

const CHUNK_SIZE = 64 * 1024;
const TAR_BLOCK = 512;
const GIT_TIMEOUT_SECONDS = 5;
const GIT_STATUS_ARGV = [
    'git',
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=all',
];
const GIT_SHORTSTAT_ARGV = ['git', '--no-optional-locks', 'diff', '--shortstat', 'HEAD'];

export interface UploadEntry {
    path: string;
    size: number;
}

export interface UploadManifest {
    entries: UploadEntry[];
}

export interface UploadPart {
    read(size: number): Promise<Uint8Array>;
}

export interface GitStatus {
    branch: string | null;
    head: string | null;
    ahead: number | null;
    behind: number | null;
    insertions: number;
    deletions: number;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
}

export interface WorkspaceStatus {
    workdir: string;
    cwd: string;
    git: GitStatus | null;
}

export class SkillUploadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SkillUploadError';
    }
}

export class WorkspaceServiceError extends Error {
    constructor(
        public readonly statusCode: 404,
        public readonly detail: string
    ) {
        super(detail);
        this.name = 'WorkspaceServiceError';
    }
}

class Semaphore {
    private available: number;
    private readonly waiters: Array<() => void> = [];

    constructor(capacity: number) {
        this.available = capacity;
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.available === 0) await new Promise<void>(resolve => this.waiters.push(resolve));
        else this.available -= 1;
        try {
            return await operation();
        } finally {
            const waiter = this.waiters.shift();
            if (waiter) waiter();
            else this.available += 1;
        }
    }
}

/** Workspace resolution, capability tokens, skill uploads and Git status. */
export class WorkspaceService {
    private readonly installSlots = new Semaphore(MAX_CONCURRENT_INSTALLS);

    constructor(
        private readonly storage: StorageBase,
        private readonly workspaceManager: WorkspaceManagerBase,
        private readonly downloadSecret: string
    ) {}

    async resolve(userId: string, agentId: string, sessionId: string): Promise<WorkspaceBase> {
        return (await this.resolveRecord(userId, agentId, sessionId))[1];
    }

    async readStatus(userId: string, agentId: string, sessionId: string): Promise<WorkspaceStatus> {
        const [record, workspace] = await this.resolveRecord(userId, agentId, sessionId);
        const backend = workspace.getBackend();
        const cwd = backend.absolutePath(record.config.cwd ?? '', workspace.workdir);
        return {
            workdir: workspace.workdir,
            cwd,
            git: await this.readGit(backend, cwd),
        };
    }

    signDownloadToken(
        userId: string,
        path: string,
        ttlSeconds = DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS
    ): { token: string; expiresAt: number } {
        return signDownloadToken(this.downloadSecret, userId, path, ttlSeconds);
    }

    verifyDownloadToken(token: string, path: string): string {
        return verifyDownloadToken(this.downloadSecret, token, path);
    }

    static validateManifest(manifest: UploadManifest, fileCount: number): string {
        const entries = manifest.entries;
        if (entries.length === 0) throw new SkillUploadError('The upload contains no files.');
        if (fileCount !== entries.length) {
            throw new SkillUploadError(
                `The manifest lists ${entries.length} files but ${fileCount} were sent.`
            );
        }
        if (entries.length > MAX_FILE_COUNT) {
            throw new SkillUploadError(
                `A skill may hold at most ${MAX_FILE_COUNT} files, got ${entries.length}.`
            );
        }

        let total = 0;
        const roots = new Set<string>();
        for (const entry of entries) {
            if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
                throw new SkillUploadError(`Invalid upload size for '${entry.path}'.`);
            }
            if (entry.size > MAX_FILE_BYTES) {
                throw new SkillUploadError(
                    `'${entry.path}' is ${entry.size} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit.`
                );
            }
            total += entry.size;
            const normalized = entry.path.replaceAll('\\', '/');
            const parts = normalized.split('/');
            if (
                parts.length < 2 ||
                parts.some(part => part === '' || part === '.' || part === '..') ||
                entry.path.startsWith('/')
            ) {
                throw new SkillUploadError(`Unsafe upload path: '${entry.path}'`);
            }
            roots.add(parts[0]);
        }
        if (total > MAX_TOTAL_BYTES) {
            throw new SkillUploadError(
                `The upload is ${total} bytes, over the ${MAX_TOTAL_BYTES}-byte limit.`
            );
        }
        if (roots.size !== 1) {
            throw new SkillUploadError(
                `A skill must be a single folder, got ${JSON.stringify([...roots].sort())}.`
            );
        }
        const root = [...roots][0];
        if (!entries.some(entry => entry.path === `${root}/SKILL.md`)) {
            throw new SkillUploadError(`No SKILL.md at the root of '${root}'.`);
        }
        return root;
    }

    async installSkill(
        workspace: WorkspaceBase,
        stream: AsyncIterable<Uint8Array>,
        archiveFormat: 'zip' | 'tar' | 'tar.gz',
        name: string,
        agentId?: string
    ): Promise<void> {
        await this.installSlots.run(() =>
            workspace.addSkillArchive(stream, archiveFormat, name, undefined, { agentId })
        );
    }

    static async *tarStream(
        manifest: UploadManifest,
        files: UploadPart[]
    ): AsyncGenerator<Uint8Array> {
        for (let index = 0; index < manifest.entries.length; index += 1) {
            const entry = manifest.entries[index];
            const upload = files[index];
            if (!upload) throw new SkillUploadError(`No upload part for '${entry.path}'.`);
            for (const header of tarHeaders(entry.path, entry.size)) yield header;

            let written = 0;
            while (true) {
                const chunk = await upload.read(CHUNK_SIZE);
                if (chunk.byteLength === 0) break;
                written += chunk.byteLength;
                if (written > entry.size) {
                    throw new SkillUploadError(
                        `'${entry.path}' is larger than its declared ${entry.size} bytes.`
                    );
                }
                yield chunk;
            }
            if (written !== entry.size) {
                throw new SkillUploadError(
                    `'${entry.path}' declared ${entry.size} bytes but sent ${written}.`
                );
            }
            const padding = (TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK;
            if (padding > 0) yield new Uint8Array(padding);
        }
        yield new Uint8Array(TAR_BLOCK * 2);
    }

    static parsePorcelainV2(stdout: Uint8Array): GitStatus {
        let branch: string | null = null;
        let head: string | null = null;
        let ahead: number | null = null;
        let behind: number | null = null;
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        let conflicted = 0;
        const chunks = Buffer.from(stdout).toString('utf8').split('\0');

        for (let index = 0; index < chunks.length; index += 1) {
            const record = chunks[index];
            if (!record) continue;
            const separator = record.indexOf(' ');
            const kind = separator < 0 ? record : record.slice(0, separator);
            const rest = separator < 0 ? '' : record.slice(separator + 1);
            if (kind === '#') {
                const headerSeparator = rest.indexOf(' ');
                const key = headerSeparator < 0 ? rest : rest.slice(0, headerSeparator);
                const value = headerSeparator < 0 ? '' : rest.slice(headerSeparator + 1);
                if (key === 'branch.oid') head = value === '(initial)' ? null : value;
                else if (key === 'branch.head') branch = value === '(detached)' ? null : value;
                else if (key === 'branch.ab') {
                    const match = /^\+(\d+) -(\d+)$/.exec(value);
                    if (match) {
                        ahead = Number(match[1]);
                        behind = Number(match[2]);
                    }
                }
                continue;
            }
            if (kind === '?') {
                untracked += 1;
                continue;
            }
            if (kind === 'u') {
                conflicted += 1;
                continue;
            }
            if (kind !== '1' && kind !== '2') continue;
            if (kind === '2') index += 1;
            const xy = rest.split(' ', 1)[0];
            if (xy.length !== 2) continue;
            if (xy[0] !== '.') staged += 1;
            if (xy[1] !== '.') unstaged += 1;
        }
        return {
            branch,
            head,
            ahead,
            behind,
            insertions: 0,
            deletions: 0,
            staged,
            unstaged,
            untracked,
            conflicted,
        };
    }

    static parseShortstat(stdout: Uint8Array): [insertions: number, deletions: number] {
        const value = Buffer.from(stdout).toString('utf8');
        return [
            Number(/(\d+) insertion/.exec(value)?.[1] ?? 0),
            Number(/(\d+) deletion/.exec(value)?.[1] ?? 0),
        ];
    }

    private async resolveRecord(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<
        [record: Awaited<ReturnType<StorageBase['getSession']>> & {}, workspace: WorkspaceBase]
    > {
        const record = await this.storage.getSession(userId, agentId, sessionId);
        if (!record) {
            throw new WorkspaceServiceError(404, `Session '${sessionId}' not found.`);
        }
        const workspace = await this.workspaceManager.getWorkspace(
            userId,
            agentId,
            sessionId,
            record.config.workspace_id
        );
        return [record, workspace];
    }

    private async readGit(backend: BackendBase, cwd: string): Promise<GitStatus | null> {
        let statusResult;
        try {
            statusResult = await backend.execShell([...GIT_STATUS_ARGV], {
                cwd,
                timeout: GIT_TIMEOUT_SECONDS,
            });
        } catch (error) {
            logger.debug('git status failed in %s: %s', cwd, String(error));
            return null;
        }
        if (!statusResult.ok()) return null;
        const summary = WorkspaceService.parsePorcelainV2(statusResult.stdout);
        if (summary.branch === null && summary.head === null) return null;

        try {
            const diffResult = await backend.execShell([...GIT_SHORTSTAT_ARGV], {
                cwd,
                timeout: GIT_TIMEOUT_SECONDS,
            });
            if (!diffResult.ok()) return summary;
            const [insertions, deletions] = WorkspaceService.parseShortstat(diffResult.stdout);
            return { ...summary, insertions, deletions };
        } catch (error) {
            logger.debug('git diff failed in %s: %s', cwd, String(error));
            return summary;
        }
    }
}

function tarHeaders(name: string, size: number): Uint8Array[] {
    const encoded = Buffer.from(name, 'utf8');
    const split = splitUstarName(name);
    if (split) return [tarHeader(split.name, size, split.prefix)];
    const longName = Buffer.concat([encoded, Buffer.from([0])]);
    const headers = [tarHeader('././@LongLink', longName.length, '', 'L'), longName];
    const padding = (TAR_BLOCK - (longName.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) headers.push(Buffer.alloc(padding));
    headers.push(tarHeader(encoded.subarray(0, 100).toString('utf8'), size));
    return headers;
}

function splitUstarName(name: string): { name: string; prefix: string } | null {
    if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
    for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
        const prefix = name.slice(0, index);
        const basename = name.slice(index + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(basename) <= 100) {
            return { name: basename, prefix };
        }
    }
    return null;
}

function tarHeader(name: string, size: number, prefix = '', type = '0'): Buffer {
    const header = Buffer.alloc(TAR_BLOCK);
    writeText(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeText(header, 156, 1, type);
    writeText(header, 257, 6, 'ustar');
    writeText(header, 263, 2, '00');
    writeText(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encoded = checksum.toString(8).padStart(6, '0');
    writeText(header, 148, 6, encoded);
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
    Buffer.from(value, 'utf8').copy(buffer, offset, 0, length);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
    const encoded = value.toString(8).padStart(length - 1, '0');
    writeText(buffer, offset, length - 1, encoded);
}
