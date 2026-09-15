import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, resolveContentSecurityPolicy } from '../../src/app.js';
import { loadAppConfig } from '../../src/config/env.js';
import { resolveListenHost } from '../../src/server.js';

const VALID_PRODUCTION_ENVIRONMENT = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://jrc_app@postgres:5432/jrc',
  AUTH_DATABASE_URL: 'postgresql://jrc_auth@postgres:5432/jrc',
  REDIS_URL: 'redis://redis:6379',
  EVOLUTION_BASE_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: 'production-evolution-secret-000000001',
  JWT_SECRET: 'production-jwt-secret-000000000000002',
  REFRESH_TOKEN_HASH_SECRET: 'production-refresh-secret-00000000003',
  API_KEY_HMAC_SECRET: 'production-api-key-secret-000000000004',
  IP_RATE_LIMIT_HMAC_SECRET: 'production-ip-rate-secret-00000000005',
  IDENTITY_RATE_LIMIT_HMAC_SECRET: 'production-identity-secret-000000006',
  CHALLENGE_ENCRYPTION_KEY: 'production-challenge-secret-0000000007',
  BROWSER_CSRF_SECRET: 'production-browser-csrf-secret-00000008',
  CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example',
} as const;

describe('fronteiras de segurança HTTP e runtime', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('envia headers defensivos também no health check', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
  });

  it('rejeita Swagger em production sem opt-in e bind interno explícitos', () => {
    expect(() => loadAppConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SWAGGER_UI_ENABLED: 'true',
    })).toThrow('Swagger UI in production requires an explicit internal bind');
  });

  it('restringe o listener ao bind loopback quando Swagger é habilitado', () => {
    const config = loadAppConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SWAGGER_UI_ENABLED: 'true',
      SWAGGER_UI_INTERNAL_BIND: '127.0.0.1',
    });

    expect(resolveListenHost(config)).toBe('127.0.0.1');
    expect(() => loadAppConfig({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SWAGGER_UI_ENABLED: 'true',
      SWAGGER_UI_INTERNAL_BIND: '0.0.0.0',
    })).toThrow();
  });

  it('permite assets somente na Swagger UI interna e mantém a API bloqueada', () => {
    expect(resolveContentSecurityPolicy('/v1/instances', true))
      .toBe("default-src 'none'; frame-ancestors 'none'");
    expect(resolveContentSecurityPolicy('/documentation/static/index.js', true)).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  it('fixa imagem Node por tag e digest, usuário não-root e entrypoint compilado', async () => {
    const dockerfile = await readFile(resolve('infra/app/Dockerfile'), 'utf8');
    const lock = await readFile(resolve('infra/app/node-image.lock'), 'utf8');
    const digest = lock.match(/^digest=(sha256:[a-f0-9]{64})$/m)?.[1];

    expect(dockerfile).toMatch(/^FROM node:24\.19\.0-bookworm-slim@sha256:[a-f0-9]{64} AS build$/m);
    expect(dockerfile).toMatch(/^FROM node:24\.19\.0-bookworm-slim@sha256:[a-f0-9]{64} AS runtime$/m);
    expect(dockerfile).toContain('COPY --chown=node:node');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "apps/api/dist/server.js"]');
    expect(digest).toBeDefined();
    expect(dockerfile.match(new RegExp(`node:24\\.19\\.0-bookworm-slim@${digest}`, 'g')))
      .toHaveLength(3);
    expect(dockerfile).toMatch(/^FROM node:24\.19\.0-bookworm-slim@sha256:[a-f0-9]{64} AS web$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "server.mjs"]');
    expect(dockerfile).toMatch(/^FROM runtime AS default$/m);
    expect(dockerfile).toContain('COPY apps/web/package.json apps/web/package.json');
    expect(dockerfile).toContain('COPY packages/ui/package.json packages/ui/package.json');
    expect(dockerfile).toContain('COPY apps/web/src apps/web/src');
    expect(dockerfile).toContain('COPY packages/ui/src packages/ui/src');
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain(
      'COPY --chown=node:node --from=build /app/packages/security/node_modules ./packages/security/node_modules',
    );
  });

  it('mantém Evolution privada e conectada ao PostgreSQL e Redis no compose', async () => {
    const compose = await readFile(resolve('infra/app/compose.yaml'), 'utf8');
    const evolutionService = compose.split('\n  evolution:\n')[1]?.split('\nnetworks:')[0] ?? '';

    expect(evolutionService).toContain('DATABASE_PROVIDER: postgresql');
    expect(evolutionService).toContain('DATABASE_CONNECTION_URI:');
    expect(evolutionService).toContain('CACHE_REDIS_URI:');
    expect(evolutionService).toContain('expose: ["8080"]');
    expect(evolutionService).not.toContain('\n    ports:');
    expect(compose).toContain('BROWSER_CSRF_SECRET: "${BROWSER_CSRF_SECRET:?required}"');
    expect(compose).toContain('CONSOLE_ALLOWED_ORIGINS: "${CONSOLE_ALLOWED_ORIGINS:?required}"');
    expect(compose).toContain('CONSOLE_COOKIE_SECURE: "true"');
  });

  it('inicia o container de teste com a configuração segura da console', async () => {
    const compose = await readFile(resolve('infra/app/compose.test.yaml'), 'utf8');

    expect(compose).toContain('BROWSER_CSRF_SECRET: container-test-browser-csrf-secret-000008');
    expect(compose).toContain('CONSOLE_ALLOWED_ORIGINS: https://console.example.test');
    expect(compose).toContain('CONSOLE_COOKIE_SECURE: "true"');
  });
});
