import { resolve } from 'path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
    main: {
        resolve: {
            alias: {
                '@shared': resolve('src/shared'),
            },
        },
        build: {
            rollupOptions: {
                external: [
                    '@agentscope-ai/agentscope',
                    /^@agentscope-ai\/agentscope\/.*/,
                    '@agentscope-ai/agentscope-service',
                    /^@agentscope-ai\/agentscope-service\/.*/,
                ],
            },
        },
    },
    preload: {
        resolve: {
            alias: {
                '@shared': resolve('src/shared'),
            },
        },
    },
    renderer: {
        resolve: {
            alias: {
                '@': resolve('src/renderer/src'),
                '@renderer': resolve('src/renderer/src'),
                '@shared': resolve('src/shared'),
            },
        },
        plugins: [react(), tailwindcss()],
    },
});
