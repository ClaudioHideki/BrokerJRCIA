import { fileURLToPath, URL } from 'node:url';

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

import { assertNoViteClientEnvironment } from './src/build-security.js';

const projectDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  assertNoViteClientEnvironment({
    ...loadEnv(mode, projectDirectory, ''),
    ...process.env,
  });
  return {
    plugins: [react()],
    build: { rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
    } } },
    resolve: {
      alias: {
        '@jrc/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
        '@jrc/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/v1': {
          target: process.env.JRC_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
    },
  };
});
