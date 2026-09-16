import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/tests/e2e', testMatch: 'chatwoot-embed.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 30_000,
  expect: { timeout: 8_000 }, reporter: [['line']],
  use: { ...devices['Desktop Chrome'], channel: 'chrome', trace: 'off', screenshot: 'off', video: 'off' },
});
