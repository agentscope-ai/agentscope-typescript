import { ToolContext } from './tool-context';

describe('ToolContext read cache', () => {
    test('validates Python cache limits', () => {
        expect(() => new ToolContext({ maxCacheFiles: 1 })).toThrow();
        expect(() => new ToolContext({ maxCacheBytes: 10_000 })).toThrow();
    });

    test('caches UTF-8 byte sizes and refreshes LRU recency', async () => {
        const context = new ToolContext({ maxCacheFiles: 3 });
        await context.cacheFile({ filePath: 'a', lines: ['你好\n'], mtime: 1 });
        await context.cacheFile({ filePath: 'b', lines: ['b'], mtime: 1 });
        await context.cacheFile({ filePath: 'c', lines: ['c'], mtime: 1 });

        expect(context.readFileCache[0].bytes).toBe(Buffer.byteLength('你好\n') / 1024);
        expect(await context.getCache({ filePath: 'a', mtime: 1 })).toBe(
            context.readFileCache.at(-1)
        );

        await context.cacheFile({ filePath: 'd', lines: ['d'], mtime: 1 });
        expect(context.readFileCache.map(entry => entry.file_path)).toEqual(['c', 'a', 'd']);
    });

    test('invalidates stale entries and replaces duplicate paths', async () => {
        const context = new ToolContext();
        await context.cacheFile({ filePath: 'a', lines: ['old'], mtime: 1 });
        await context.cacheFile({ filePath: 'a', lines: ['new'], mtime: 2 });
        expect(context.readFileCache).toHaveLength(1);
        expect(await context.getCache({ filePath: 'a', mtime: 1 })).toBeNull();
        expect(context.readFileCache).toEqual([]);
    });

    test('evicts by accumulated KiB size and cleans unreserved paths', async () => {
        const context = new ToolContext({ maxCacheBytes: 10_001 });
        const sixMiB = 'x'.repeat(6 * 1024 * 1024);
        await context.cacheFile({ filePath: 'a', lines: [sixMiB], mtime: 1 });
        await context.cacheFile({ filePath: 'b', lines: [sixMiB], mtime: 1 });
        expect(context.readFileCache.map(entry => entry.file_path)).toEqual(['b']);

        await context.cacheFile({ filePath: 'c', lines: ['c'], mtime: 1 });
        await context.cleanFileCache({ reservedFilePaths: new Set(['c']) });
        expect(context.readFileCache.map(entry => entry.file_path)).toEqual(['c']);
    });

    test('round-trips the Python snake_case wire shape', async () => {
        const context = new ToolContext({ activatedGroups: ['filesystem'] });
        await context.cacheFile({ filePath: '/tmp/a', lines: ['a'], mtime: 1 });
        const wire = context.toJSON();
        expect(ToolContext.fromJSON(wire).toJSON()).toEqual(wire);
    });
});
