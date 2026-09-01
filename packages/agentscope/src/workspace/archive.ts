/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import extractZip from 'extract-zip';
import * as tar from 'tar';

import type { BackendBase } from '../tool';

export type SkillArchiveFormat = 'zip' | 'tar' | 'tar.gz';

function assertSafeArchivePath(name: string): void {
    const normalized = name.replaceAll('\\', '/');
    if (
        normalized.startsWith('/') ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.split('/').includes('..')
    ) {
        throw new Error(`Unsafe archive member: ${name}`);
    }
}

/** Extract an archive locally after validating paths and expanded size. */
export async function extractLocalArchive(options: {
    archivePath: string;
    destination: string;
    format: SkillArchiveFormat;
    maxExtractedBytes: number;
}): Promise<void> {
    const destination = path.resolve(options.destination);
    await fs.mkdir(destination, { recursive: true });
    let extractedBytes = 0;
    const account = (name: string, size: number): void => {
        assertSafeArchivePath(name);
        extractedBytes += Math.max(0, size);
        if (extractedBytes > options.maxExtractedBytes) {
            throw new Error(
                `Archive expands to ${extractedBytes} bytes, limit is ${options.maxExtractedBytes}`
            );
        }
    };

    if (options.format === 'zip') {
        await extractZip(options.archivePath, {
            dir: destination,
            onEntry(entry) {
                account(entry.fileName, entry.uncompressedSize);
            },
        });
        return;
    }

    await tar.x({
        file: options.archivePath,
        cwd: destination,
        gzip: options.format === 'tar.gz',
        strict: true,
        onentry(entry) {
            account(entry.path, entry.size);
            if (entry.linkpath) assertSafeArchivePath(entry.linkpath);
        },
    });
}

/** Locate a flat or singly wrapped skill root on a workspace backend. */
export async function findSkillRoot(backend: BackendBase, staging: string): Promise<string> {
    if (await backend.fileExists(backend.joinPath(staging, 'SKILL.md'))) return staging;
    const roots: string[] = [];
    for (const entry of await backend.listDirectory(staging)) {
        const candidate = backend.joinPath(staging, entry);
        if (await backend.fileExists(backend.joinPath(candidate, 'SKILL.md'))) {
            roots.push(candidate);
        }
    }
    if (roots.length === 1) return roots[0];
    if (roots.length > 1) throw new Error('The skill archive contains multiple skill roots');
    throw new Error('The skill archive contains no SKILL.md');
}
