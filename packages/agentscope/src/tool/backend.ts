/* eslint-disable jsdoc/require-jsdoc */

import { spawn } from 'child_process';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Default chunk size for streamed file reads. */
export const DEFAULT_READ_CHUNK_SIZE = 1024 * 1024;

/** Result returned by a backend process invocation. */
export class ExecResult {
    readonly exitCode: number;
    readonly stdout: Buffer;
    readonly stderr: Buffer;

    constructor(config: { exitCode: number; stdout?: Uint8Array; stderr?: Uint8Array }) {
        this.exitCode = config.exitCode;
        this.stdout = Buffer.from(config.stdout ?? []);
        this.stderr = Buffer.from(config.stderr ?? []);
    }

    /** Return whether the command exited successfully. */
    ok(): boolean {
        return this.exitCode === 0;
    }
}

/** Metadata for one directory entry. */
export interface DirEntry {
    name: string;
    isDir: boolean;
    sizeBytes: number | null;
    mtime: number | null;
}

/**
 * Normalize Windows and old-Mac line endings.
 * @param text
 */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/** Filesystem and process contract consumed by builtin tools. */
export abstract class BackendBase {
    readonly osName: 'posix' | 'nt' = 'posix';

    /** Execute an argument vector without an implicit shell. */
    abstract execShell(
        command: string[],
        options?: { cwd?: string; timeout?: number; signal?: AbortSignal }
    ): Promise<ExecResult>;

    /** Read a file as bytes. */
    abstract readFile(filePath: string): Promise<Buffer>;

    /** Write bytes and create missing parent directories. */
    abstract writeFile(filePath: string, data: Uint8Array): Promise<void>;

    /**
     * Join path components using this backend's path semantics.
     * @param first
     * @param {...any} rest
     */
    joinPath(first: string, ...rest: string[]): string {
        return path.posix.join(first, ...rest);
    }

    /**
     * Return the directory component of a path.
     * @param filePath
     */
    dirname(filePath: string): string {
        return path.posix.dirname(filePath);
    }

    /**
     * Return the final component of a path.
     * @param filePath
     */
    basename(filePath: string): string {
        return path.posix.basename(filePath);
    }

    /**
     * Return whether a path is absolute.
     * @param filePath
     */
    isAbsolute(filePath: string): boolean {
        return path.posix.isAbsolute(filePath);
    }

    /**
     * Normalize a path without touching the filesystem.
     * @param filePath
     */
    normalizePath(filePath: string): string {
        return path.posix.normalize(filePath);
    }

    /**
     * Resolve a path against an explicit backend working directory.
     * @param filePath
     * @param cwd
     */
    absolutePath(filePath: string, cwd: string): string {
        return this.normalizePath(
            this.isAbsolute(filePath) ? filePath : this.joinPath(cwd, filePath)
        );
    }

    /**
     * Write an async byte stream.
     * @param filePath
     * @param stream
     */
    async writeStream(filePath: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        await this.writeFile(filePath, Buffer.concat(chunks));
    }

    /**
     * Read a file as an async byte stream.
     * @param filePath
     * @param chunkSize
     */
    async *readStream(
        filePath: string,
        chunkSize = DEFAULT_READ_CHUNK_SIZE
    ): AsyncGenerator<Buffer> {
        const data = await this.readFile(filePath);
        for (let offset = 0; offset < data.length; offset += chunkSize) {
            yield data.subarray(offset, offset + chunkSize);
        }
    }

    /** Return the backend working directory. */
    async getCwd(): Promise<string> {
        const result = await this.execShell(['pwd']);
        return result.stdout.toString('utf8').trim();
    }

    /**
     * Expand the current backend user's home directory.
     * @param filePath
     */
    async expandUser(filePath: string): Promise<string> {
        if (filePath !== '~' && !filePath.startsWith('~/')) return filePath;
        const result = await this.execShell(['printenv', 'HOME']);
        const home = result.stdout.toString('utf8').trim();
        return home ? `${home}${filePath.slice(1)}` : filePath;
    }

    /**
     * Return whether a path exists.
     * @param filePath
     */
    async fileExists(filePath: string): Promise<boolean> {
        return (await this.execShell(['test', '-e', filePath])).ok();
    }

    /**
     * Return whether a path is a directory.
     * @param filePath
     */
    async isDirectory(filePath: string): Promise<boolean> {
        return (await this.execShell(['test', '-d', filePath])).ok();
    }

    /**
     * List immediate names or recursive file paths.
     * @param filePath
     * @param recursive
     */
    async listDirectory(filePath: string, recursive = false): Promise<string[]> {
        const command = recursive
            ? ['find', filePath, '-type', 'f', '-print0']
            : ['find', filePath, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0'];
        const result = await this.execShell(command);
        if (!result.ok()) return [];
        return result.stdout.toString('utf8').split('\0').filter(Boolean);
    }

    /**
     * List one level together with metadata.
     * @param filePath
     */
    async scanDirectory(filePath: string): Promise<DirEntry[]> {
        const names = await this.listDirectory(filePath);
        const entries = await Promise.all(
            names.map(name => this.stat(this.joinPath(filePath, name)))
        );
        return entries.filter((entry): entry is DirEntry => entry !== null);
    }

    /**
     * Read metadata for one path.
     * @param filePath
     */
    async stat(filePath: string): Promise<DirEntry | null> {
        const result = await this.execShell([
            'find',
            filePath,
            '-maxdepth',
            '0',
            '-printf',
            '%Y\\t%s\\t%T@\\t%f\\0',
        ]);
        if (!result.ok()) return null;
        const [kind, rawSize, rawMtime, name] = result.stdout
            .toString('utf8')
            .replace(/\0$/, '')
            .split('\t', 4);
        if (!name || ['N', 'L', '?'].includes(kind)) return null;
        const isDir = kind === 'd';
        return {
            name,
            isDir,
            sizeBytes: isDir ? null : Number(rawSize),
            mtime: Number(rawMtime),
        };
    }

    /**
     * Return the modification time as seconds since the epoch.
     * @param filePath
     */
    async statMtime(filePath: string): Promise<number | null> {
        return (await this.stat(filePath))?.mtime ?? null;
    }

    /**
     * Delete a path recursively.
     * @param filePath
     */
    async deletePath(filePath: string): Promise<void> {
        await this.execShell(['rm', '-rf', filePath]);
    }
}

/** Host-local backend implementation. */
export class LocalBackend extends BackendBase {
    override readonly osName = process.platform === 'win32' ? 'nt' : 'posix';

    override joinPath(first: string, ...rest: string[]): string {
        return path.join(first, ...rest);
    }

    override dirname(filePath: string): string {
        return path.dirname(filePath);
    }

    override basename(filePath: string): string {
        return path.basename(filePath);
    }

    override isAbsolute(filePath: string): boolean {
        return path.isAbsolute(filePath);
    }

    override normalizePath(filePath: string): string {
        return path.normalize(filePath);
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        if (command.length === 0) {
            return new ExecResult({ exitCode: 127, stderr: Buffer.from('empty command') });
        }
        return await new Promise(resolve => {
            const child = spawn(command[0], command.slice(1), {
                cwd: options.cwd,
                shell: false,
                windowsHide: true,
                signal: options.signal,
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let settled = false;
            const finish = (result: ExecResult): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(result);
            };
            const timer = options.timeout
                ? setTimeout(() => {
                      child.kill('SIGKILL');
                      finish(
                          new ExecResult({
                              exitCode: -1,
                              stderr: Buffer.from('timed out'),
                          })
                      );
                  }, options.timeout * 1000)
                : undefined;
            child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
            child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
            child.on('error', error =>
                finish(
                    new ExecResult({
                        exitCode: 127,
                        stderr: Buffer.from(error.message),
                    })
                )
            );
            child.on('close', code =>
                finish(
                    new ExecResult({
                        exitCode: code ?? 0,
                        stdout: Buffer.concat(stdout),
                        stderr: Buffer.concat(stderr),
                    })
                )
            );
        });
    }

    async readFile(filePath: string): Promise<Buffer> {
        return await fs.readFile(filePath);
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.dirname(filePath);
        if (parent) await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(filePath, data);
    }

    override async *readStream(
        filePath: string,
        chunkSize = DEFAULT_READ_CHUNK_SIZE
    ): AsyncGenerator<Buffer> {
        const handle = await fs.open(filePath, constants.O_RDONLY);
        try {
            let position = 0;
            while (true) {
                const buffer = Buffer.allocUnsafe(chunkSize);
                const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
                if (bytesRead === 0) break;
                position += bytesRead;
                yield buffer.subarray(0, bytesRead);
            }
        } finally {
            await handle.close();
        }
    }

    override async getCwd(): Promise<string> {
        return process.cwd();
    }

    override async expandUser(filePath: string): Promise<string> {
        if (
            filePath !== '~' &&
            !filePath.startsWith(`~${path.sep}`) &&
            !filePath.startsWith('~/')
        ) {
            return filePath;
        }
        const home = process.env.HOME ?? process.env.USERPROFILE;
        return home ? path.join(home, filePath.slice(2)) : filePath;
    }

    override async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    override async isDirectory(filePath: string): Promise<boolean> {
        try {
            return (await fs.stat(filePath)).isDirectory();
        } catch {
            return false;
        }
    }

    override async listDirectory(filePath: string, recursive = false): Promise<string[]> {
        if (!recursive) return await fs.readdir(filePath);
        const result: string[] = [];
        const visit = async (directory: string): Promise<void> => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) await visit(fullPath);
                else if (entry.isFile()) result.push(fullPath);
            }
        };
        await visit(filePath);
        return result;
    }

    override async scanDirectory(filePath: string): Promise<DirEntry[]> {
        try {
            const entries = await fs.readdir(filePath, { withFileTypes: true });
            return await Promise.all(
                entries.map(async entry => {
                    try {
                        const info = await fs.stat(path.join(filePath, entry.name));
                        const isDir = info.isDirectory();
                        return {
                            name: entry.name,
                            isDir,
                            sizeBytes: isDir ? null : info.size,
                            mtime: info.mtimeMs / 1000,
                        };
                    } catch {
                        return {
                            name: entry.name,
                            isDir: false,
                            sizeBytes: null,
                            mtime: null,
                        };
                    }
                })
            );
        } catch {
            return [];
        }
    }

    override async stat(filePath: string): Promise<DirEntry | null> {
        try {
            const info = await fs.stat(filePath);
            const isDir = info.isDirectory();
            return {
                name: path.basename(filePath),
                isDir,
                sizeBytes: isDir ? null : info.size,
                mtime: info.mtimeMs / 1000,
            };
        } catch {
            return null;
        }
    }

    override async deletePath(filePath: string): Promise<void> {
        await fs.rm(filePath, { recursive: true, force: true });
    }
}
