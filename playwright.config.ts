import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 41_73;
const API_PORT = 33_10;
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
  webServer: {
    command: `npm --workspace @jrc/web run preview -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      JRC_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
    },
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
