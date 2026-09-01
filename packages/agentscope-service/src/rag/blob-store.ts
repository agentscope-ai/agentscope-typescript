/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SyncReadable {
    read(size: number): Uint8Array | null;
}

export interface AsyncBlobReader extends AsyncDisposable {
    read(size?: number): Promise<Uint8Array>;
    close(): Promise<void>;
}

/** Durable byte storage used by knowledge-document uploads and index workers. */
export abstract class BlobStoreBase {
    async openStore(): Promise<this> {
        return this;
    }

    async closeStore(): Promise<void> {}

    abstract writeStream(key: string, stream: SyncReadable): Promise<string>;
    abstract open(uri: string): Promise<AsyncBlobReader>;
    abstract delete(uri: string): Promise<void>;
    abstract exists(uri: string): Promise<boolean>;

    async size(_uri: string): Promise<number | null> {
        return null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.closeStore();
    }
}

/** Local filesystem blob store with traversal-safe keys and chunked IO. */
export class LocalBlobStore extends BlobStoreBase {
    private readonly root: string;

    constructor(rootDirectory: string) {
        super();
        this.root = path.resolve(rootDirectory);
    }

    override async openStore(): Promise<this> {
        await fs.mkdir(this.root, { recursive: true });
        return this;
    }

    async writeStream(key: string, stream: SyncReadable): Promise<string> {
        const destination = this.pathFor(key);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const file = await fs.open(destination, 'w');
        try {
            while (true) {
                const chunk = stream.read(1 << 20);
                if (!chunk || chunk.byteLength === 0) break;
                await file.write(chunk);
            }
        } finally {
            await file.close();
        }
        return `local://${key}`;
    }

    async open(uri: string): Promise<AsyncBlobReader> {
        const file = await fs.open(this.pathFor(this.keyFromUri(uri)), 'r');
        let position = 0;
        let closed = false;
        const close = async (): Promise<void> => {
            if (closed) return;
            closed = true;
            await file.close();
        };
        return {
            async read(size = -1): Promise<Uint8Array> {
                if (closed) throw new Error('Blob reader is closed.');
                if (size < 0) {
                    const result = await file.readFile();
                    position += result.byteLength;
                    return result;
                }
                const buffer = Buffer.alloc(size);
                const { bytesRead } = await file.read(buffer, 0, size, position);
                position += bytesRead;
                return buffer.subarray(0, bytesRead);
            },
            close,
            [Symbol.asyncDispose]: close,
        };
    }

    override async size(uri: string): Promise<number | null> {
        try {
            return (await fs.stat(this.pathFor(this.keyFromUri(uri)))).size;
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    async delete(uri: string): Promise<void> {
        const target = this.pathFor(this.keyFromUri(uri));
        try {
            await fs.unlink(target);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
        let parent = path.dirname(target);
        while (parent !== this.root && insideRoot(this.root, parent)) {
            try {
                await fs.rmdir(parent);
            } catch {
                break;
            }
            parent = path.dirname(parent);
        }
    }

    async exists(uri: string): Promise<boolean> {
        try {
            return (await fs.stat(this.pathFor(this.keyFromUri(uri)))).isFile();
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }

    private pathFor(key: string): string {
        if (!key || path.isAbsolute(key) || key.split(/[\\/]/).includes('..')) {
            throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
        }
        const destination = path.resolve(this.root, ...key.split('/'));
        if (!insideRoot(this.root, destination)) {
            throw new Error(`Blob key ${JSON.stringify(key)} escapes the root directory.`);
        }
        return destination;
    }

    private keyFromUri(uri: string): string {
        if (!uri.startsWith('local://')) {
            throw new Error(`Not a local blob URI: ${JSON.stringify(uri)}`);
        }
        return uri.slice('local://'.length);
    }
}

function insideRoot(root: string, destination: string): boolean {
    const relative = path.relative(root, destination);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
}
