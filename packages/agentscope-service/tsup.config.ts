import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'access/index': 'src/access/index.ts',
        index: 'src/index.ts',
        'message-bus/index': 'src/message-bus/index.ts',
        'storage/index': 'src/storage/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    outDir: 'dist',
    sourcemap: true,
    external: ['better-sqlite3', 'redis'],
});
