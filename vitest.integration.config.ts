import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jrc/contracts': resolve(rootDirectory, 'packages/contracts/src/index.ts'),
      '@jrc/providers': resolve(rootDirectory, 'packages/providers/src/index.ts'),
      '@jrc/security': resolve(rootDirectory, 'packages/security/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/tests/integration/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
