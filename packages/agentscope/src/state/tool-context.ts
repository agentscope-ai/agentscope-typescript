export interface ReadCacheEntry {
    lines: string[];
    updated_at: number;
    bytes: number;
    file_path: string;
}

export interface ToolContextWire {
    max_cache_files: number;
    max_cache_bytes: number;
    read_file_cache: ReadCacheEntry[];
    activated_groups: string[];
}

export interface ToolContextOptions {
    maxCacheFiles?: number;
    maxCacheBytes?: number;
    readFileCache?: ReadCacheEntry[];
    activatedGroups?: string[];
}

/**
 * Read a host-file modification timestamp.
 * @param filePath
 * @returns POSIX modification time, or `null` when unavailable.
 */
async function getFileMtime(filePath: string): Promise<number | null> {
    try {
        const { stat } = await import('node:fs/promises');
        return (await stat(filePath)).mtimeMs / 1000;
    } catch {
        return null;
    }
}

/** LRU cache and activated-tool-group state used by file tools. */
export class ToolContext {
    maxCacheFiles: number;
    maxCacheBytes: number;
    readFileCache: ReadCacheEntry[];
    activatedGroups: string[];

    /**
     * Create tool context state.
     * @param options Optional cache limits and restored values.
     */
    constructor(options: ToolContextOptions = {}) {
        const maxCacheFiles = options.maxCacheFiles ?? 100;
        const maxCacheBytes = options.maxCacheBytes ?? 25_000;
        if (maxCacheFiles <= 1) throw new Error('maxCacheFiles must be greater than 1.');
        if (maxCacheBytes <= 10_000) {
            throw new Error('maxCacheBytes must be greater than 10000.');
        }
        this.maxCacheFiles = maxCacheFiles;
        this.maxCacheBytes = maxCacheBytes;
        this.readFileCache = options.readFileCache ?? [];
        this.activatedGroups = options.activatedGroups ?? [];
    }

    /**
     * Return a valid cached file and refresh its LRU recency.
     * @param options Cache lookup fields.
     * @param options.filePath
     * @param options.mtime
     * @returns The cache entry, or `null` when absent or stale.
     */
    async getCache(options: {
        filePath: string;
        mtime?: number | null;
    }): Promise<ReadCacheEntry | null> {
        const entry = this.readFileCache.find(value => value.file_path === options.filePath);
        if (!entry) return null;

        const mtime = options.mtime ?? (await getFileMtime(options.filePath));
        const currentIndex = this.readFileCache.indexOf(entry);
        if (currentIndex === -1) return null;

        this.readFileCache.splice(currentIndex, 1);
        if (mtime !== entry.updated_at) return null;
        this.readFileCache.push(entry);
        return entry;
    }

    /**
     * Cache file lines and enforce Python's LRU limits.
     * @param options File content and optional backend mtime.
     * @param options.filePath
     * @param options.lines
     * @param options.mtime
     */
    async cacheFile(options: {
        filePath: string;
        lines: string[];
        mtime?: number | null;
    }): Promise<void> {
        const mtime = options.mtime ?? (await getFileMtime(options.filePath));
        if (mtime == null) return;

        const encoder = new TextEncoder();
        const bytes =
            options.lines.reduce((total, line) => total + encoder.encode(line).byteLength, 0) /
            1024;
        this.readFileCache = this.readFileCache.filter(
            entry => entry.file_path !== options.filePath
        );

        while (this.readFileCache.length >= this.maxCacheFiles) {
            this.readFileCache.shift();
        }

        let currentSize = this.readFileCache.reduce((total, entry) => total + entry.bytes, 0);
        while (this.readFileCache.length > 0 && currentSize + bytes > this.maxCacheBytes) {
            currentSize -= this.readFileCache.shift()!.bytes;
        }

        this.readFileCache.push({
            lines: options.lines,
            updated_at: mtime,
            bytes,
            file_path: options.filePath,
        });
    }

    /**
     * Drop file caches that no longer appear in context.
     * @param options Reserved file paths.
     * @param options.reservedFilePaths
     */
    async cleanFileCache(options: { reservedFilePaths?: Set<string> } = {}): Promise<void> {
        const reserved = options.reservedFilePaths ?? new Set<string>();
        this.readFileCache = this.readFileCache.filter(entry => reserved.has(entry.file_path));
    }

    /**
     * Serialize tool context.
     * @returns The Python-compatible persisted representation.
     */
    toJSON(): ToolContextWire {
        return {
            max_cache_files: this.maxCacheFiles,
            max_cache_bytes: this.maxCacheBytes,
            read_file_cache: this.readFileCache,
            activated_groups: this.activatedGroups,
        };
    }

    /**
     * Restore a tool context from Python-compatible state.
     * @param value Persisted tool context.
     * @returns A tool context instance.
     */
    static fromJSON(value: Partial<ToolContextWire> = {}): ToolContext {
        return new ToolContext({
            maxCacheFiles: value.max_cache_files,
            maxCacheBytes: value.max_cache_bytes,
            readFileCache: value.read_file_cache,
            activatedGroups: value.activated_groups,
        });
    }
}
