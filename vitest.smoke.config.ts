import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/api/tests/smoke/**/*.test.ts'],
    testTimeout: 125_000,
  },
});
