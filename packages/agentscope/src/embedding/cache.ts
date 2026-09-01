/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';

import type { Embedding, JSONSerializableObject } from '../type';

export interface EmbeddingCacheBase {
    store(
        embeddings: Embedding[],
        identifier: JSONSerializableObject,
        overwrite?: boolean
    ): Promise<void>;
    retrieve(identifier: JSONSerializableObject): Promise<Embedding[] | null>;
    remove(identifier: JSONSerializableObject): Promise<void>;
    clear(): Promise<void>;
}

/** Cross-platform file cache with deterministic identifiers. */
export class FileEmbeddingCache implements EmbeddingCacheBase {
    readonly cacheDir: string;
    readonly maxFileNumber: number | null;
    readonly maxCacheSize: number | null;

    constructor(
        options: {
            cacheDir?: string;
            maxFileNumber?: number | null;
            maxCacheSize?: number | null;
        } = {}
    ) {
        this.cacheDir = path.resolve(options.cacheDir ?? './.cache/embeddings');
        this.maxFileNumber = options.maxFileNumber ?? null;
        this.maxCacheSize = options.maxCacheSize ?? null;
    }

    async store(
        embeddings: Embedding[],
        identifier: JSONSerializableObject,
        overwrite = false
    ): Promise<void> {
        await mkdir(this.cacheDir, { recursive: true });
        const file = this.filePath(identifier);
        try {
            await stat(file);
            if (!overwrite) return;
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
        await writeFile(file, JSON.stringify(embeddings), 'utf8');
        await this.maintain();
    }

    async retrieve(identifier: JSONSerializableObject): Promise<Embedding[] | null> {
        try {
            return JSON.parse(await readFile(this.filePath(identifier), 'utf8')) as Embedding[];
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    async remove(identifier: JSONSerializableObject): Promise<void> {
        await rm(this.filePath(identifier));
    }

    async clear(): Promise<void> {
        await mkdir(this.cacheDir, { recursive: true });
        const files = await readdir(this.cacheDir);
        await Promise.all(
            files
                .filter(file => file.endsWith('.embedding'))
                .map(file => rm(path.join(this.cacheDir, file)))
        );
    }

    private filePath(identifier: JSONSerializableObject): string {
        const hash = createHash('sha256').update(JSON.stringify(identifier)).digest('hex');
        return path.join(this.cacheDir, `${hash}.embedding`);
    }

    private async maintain(): Promise<void> {
        let files = await this.files();
        if (this.maxFileNumber && files.length > this.maxFileNumber) {
            const remove = files.slice(0, files.length - this.maxFileNumber);
            await Promise.all(remove.map(file => rm(file.path)));
            files = files.slice(files.length - this.maxFileNumber);
        }
        if (this.maxCacheSize != null) {
            let bytes = files.reduce((sum, file) => sum + file.size, 0);
            const limit = this.maxCacheSize * 1024 * 1024;
            for (const file of files) {
                if (bytes <= limit) break;
                await rm(file.path);
                bytes -= file.size;
            }
        }
    }

    private async files(): Promise<Array<{ path: string; size: number; modified: number }>> {
        await mkdir(this.cacheDir, { recursive: true });
        const names = (await readdir(this.cacheDir)).filter(file => file.endsWith('.embedding'));
        const files = await Promise.all(
            names.map(async name => {
                const filePath = path.join(this.cacheDir, name);
                const info = await stat(filePath);
                return { path: filePath, size: info.size, modified: info.mtimeMs };
            })
        );
        return files.sort((left, right) => left.modified - right.modified);
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}
