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
      '@jrc/ui': resolve(rootDirectory, 'packages/ui/src/index.ts'),
    },
  },
  test: {
    // Initial lazy imports/PDF checks share resources with local and CI builds.
    testTimeout: 15000,
    exclude: [
      'tests/compiled-workspace-resolution.test.mjs',
      'tests/compiled-entrypoint.test.mjs',
      '**/node_modules/**',
      '**/.git/**',
    ],
    include: [
      'tests/**/*.test.{js,mjs,ts}',
      'apps/**/src/**/*.test.{ts,tsx}',
      'apps/**/tests/unit/**/*.test.ts',
      'apps/**/tests/http/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
    setupFiles: ['apps/web/src/test/setup.ts'],
  },
});
