import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 41_73;
const baseURL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './apps/web/tests/e2e',
  globalSetup: './apps/web/tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
