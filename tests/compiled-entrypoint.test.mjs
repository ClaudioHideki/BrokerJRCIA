import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_ADMIN_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  ?? (ADMIN_DATABASE_URL ? roleUrl(ADMIN_DATABASE_URL, 'jrc_app') : undefined);
const AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL
  ?? (ADMIN_DATABASE_URL ? roleUrl(ADMIN_DATABASE_URL, 'jrc_auth') : undefined);
const describeRuntime = APP_DATABASE_URL && AUTH_DATABASE_URL && REDIS_URL ? describe : describe.skip;

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function becomesUnavailable(port, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  if (!child.pid) throw new Error('Compiled entrypoint process has no PID');

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const [status] = await once(killer, 'exit');
    if (status !== 0 && child.exitCode === null) throw new Error('Could not terminate compiled entrypoint process tree');
  } else {
    process.kill(-child.pid, 'SIGTERM');
  }

  if (child.exitCode !== null) return;

  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) {
    if (process.platform === 'win32') {
      throw new Error('Compiled entrypoint process tree did not exit');
    }
    process.kill(-child.pid, 'SIGKILL');
    await once(child, 'exit');
  }
}

function roleUrl(connectionString, role) {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

describeRuntime('compiled API entrypoint', () => {
  it('starts the real dist entrypoint, serves health, and shuts down', async () => {
    const port = await availablePort();
    const secret = (purpose) => `${purpose}-${randomBytes(32).toString('hex')}`;
    const command = process.platform === 'win32'
      ? { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm start'] }
      : { executable: 'npm', args: ['start'] };
    const child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        DATABASE_URL: APP_DATABASE_URL,
        AUTH_DATABASE_URL,
        REDIS_URL,
        EVOLUTION_BASE_URL: 'http://127.0.0.1:8080',
        EVOLUTION_API_KEY: secret('evolution'),
        JWT_SECRET: secret('jwt'),
        REFRESH_TOKEN_HASH_SECRET: secret('refresh'),
        API_KEY_HMAC_SECRET: secret('api-key'),
        IP_RATE_LIMIT_HMAC_SECRET: secret('ip-rate'),
        IDENTITY_RATE_LIMIT_HMAC_SECRET: secret('identity-rate'),
        CHALLENGE_ENCRYPTION_KEY: secret('challenge'),
        BROWSER_CSRF_SECRET: secret('browser-csrf'),
        CONSOLE_ALLOWED_ORIGINS: 'https://console.example.test',
        CONSOLE_COOKIE_SECURE: 'true',
      },
      stdio: 'pipe',
    });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));

    try {
      const deadline = Date.now() + 15_000;
      let response;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      expect(child.exitCode, output.join('')).toBeNull();
      expect(response?.status, output.join('')).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await terminateProcessTree(child);
    }
    expect(await becomesUnavailable(port)).toBe(true);
  }, 25_000);
});
