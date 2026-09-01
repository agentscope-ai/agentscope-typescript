import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { FileEmbeddingCache } from './cache';

describe('FileEmbeddingCache parity', () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await mkdtemp(path.join(tmpdir(), 'agentscope-embedding-'));
    });

    afterEach(async () => {
        await rm(cacheDir, { recursive: true, force: true });
    });

    test('stores, retrieves, preserves by default, overwrites, removes, and clears', async () => {
        const cache = new FileEmbeddingCache({ cacheDir });
        await cache.store([[1, 2]], { key: '一' });
        await expect(cache.retrieve({ key: '一' })).resolves.toEqual([[1, 2]]);
        await cache.store([[3, 4]], { key: '一' });
        await expect(cache.retrieve({ key: '一' })).resolves.toEqual([[1, 2]]);
        await cache.store([[3, 4]], { key: '一' }, true);
        await expect(cache.retrieve({ key: '一' })).resolves.toEqual([[3, 4]]);
        await cache.remove({ key: '一' });
        await expect(cache.retrieve({ key: '一' })).resolves.toBeNull();
        await expect(cache.remove({ key: '一' })).rejects.toMatchObject({ code: 'ENOENT' });

        await cache.store([[1]], 'a');
        await cache.store([[2]], 'b');
        await cache.clear();
        await expect(readdir(cacheDir)).resolves.toEqual([]);
    });

    test('evicts oldest entries by file count', async () => {
        const cache = new FileEmbeddingCache({ cacheDir, maxFileNumber: 2 });
        await cache.store([[1]], 'first');
        await new Promise(resolve => setTimeout(resolve, 5));
        await cache.store([[2]], 'second');
        await new Promise(resolve => setTimeout(resolve, 5));
        await cache.store([[3]], 'third');
        await expect(cache.retrieve('first')).resolves.toBeNull();
        await expect(cache.retrieve('second')).resolves.toEqual([[2]]);
        await expect(cache.retrieve('third')).resolves.toEqual([[3]]);
    });

    test('evicts entries when the configured size is exceeded', async () => {
        const cache = new FileEmbeddingCache({ cacheDir, maxCacheSize: 0 });
        await cache.store([[1, 2, 3]], 'large');
        await expect(cache.retrieve('large')).resolves.toBeNull();
    });
});
