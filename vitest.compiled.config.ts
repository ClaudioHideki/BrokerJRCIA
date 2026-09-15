import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/compiled-workspace-resolution.test.mjs',
      'tests/compiled-entrypoint.test.mjs',
    ],
  },
});
