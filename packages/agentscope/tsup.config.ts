import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'type/index': 'src/type/index.ts',
        'exception/index': 'src/exception/index.ts',
        'utils/index': 'src/_utils/index.ts',
        'logger/index': 'src/logger/index.ts',
        version: 'src/version.ts',
        'message/index': 'src/message/index.ts',
        'model/index': 'src/model/index.ts',
        'tool/index': 'src/tool/index.ts',
        'agent/index': 'src/agent/index.ts',
        'formatter/index': 'src/formatter/index.ts',
        'event/index': 'src/event/index.ts',
        'mcp/index': 'src/mcp/index.ts',
        'storage/index': 'src/storage/index.ts',
        'state/index': 'src/state/index.ts',
        'permission/index': 'src/permission/index.ts',
        'skill/index': 'src/skill/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    clean: true,
    outDir: 'dist',
    sourcemap: true,
});
