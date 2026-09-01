import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'access/index': 'src/access/index.ts',
        index: 'src/index.ts',
        'manager/index': 'src/manager/index.ts',
        'middleware/index': 'src/middleware/index.ts',
        'message-bus/index': 'src/message-bus/index.ts',
        'rag/index': 'src/rag/index.ts',
        'rag/index-worker-cli': 'src/rag/index-worker-cli.ts',
        'service/index': 'src/service/index.ts',
        'storage/index': 'src/storage/index.ts',
        'tool/index': 'src/tool/index.ts',
        'workspace-manager/index': 'src/workspace-manager/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['better-sqlite3', 'redis'],
});
