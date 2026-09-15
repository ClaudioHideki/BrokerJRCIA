import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

const VALID_RUNTIME_ENVIRONMENT = {
  DATABASE_URL: 'postgresql://jrc_app@127.0.0.1:5432/jrc',
  AUTH_DATABASE_URL: 'postgresql://jrc_auth@127.0.0.1:5432/jrc',
  REDIS_URL: 'redis://127.0.0.1:6379',
  EVOLUTION_BASE_URL: 'http://127.0.0.1:8080',
  EVOLUTION_API_KEY: 'runtime-evolution-secret-value-000001',
  JWT_SECRET: 'runtime-jwt-secret-value-000000000002',
  REFRESH_TOKEN_HASH_SECRET: 'runtime-refresh-secret-value-00000003',
  API_KEY_HMAC_SECRET: 'runtime-api-key-secret-value-000000004',
  IP_RATE_LIMIT_HMAC_SECRET: 'runtime-ip-rate-secret-value-00000005',
  IDENTITY_RATE_LIMIT_HMAC_SECRET: 'runtime-identity-secret-value-000006',
  CHALLENGE_ENCRYPTION_KEY: 'runtime-challenge-secret-value-0000007',
  BROWSER_CSRF_SECRET: 'runtime-browser-csrf-secret-value-000008',
  CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example',
  CONSOLE_COOKIE_SECURE: 'true',
} as const;

describe('buildApp', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('responde health sem iniciar socket', async () => {
    const app = buildApp({ nodeEnv: 'test' });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('impede o startup quando a inicialização do verificador fictício falha', async () => {
    const app = buildApp({
      nodeEnv: 'test',
      passwordVerifierInitializer: async () => {
        throw new Error('dummy hash initialization failed');
      },
    });
    apps.push(app);

    const startupResult = await app.ready().then(
      () => 'started',
      (error: unknown) => error instanceof Error ? error.message : 'unknown startup error',
    );

    expect(startupResult).toBe('dummy hash initialization failed');
  });

  it('valida configuração e segredos fora de test mesmo com todas as rotas injetadas', () => {
    expect(() => buildApp({
      nodeEnv: 'development',
      environment: {},
      auth: {} as never,
      apiKeys: {} as never,
    })).toThrow();
  });

  it('rejeita dependências de autenticação injetadas fora de test mesmo com configuração válida', () => {
    expect(() => buildApp({
      nodeEnv: 'development',
      environment: VALID_RUNTIME_ENVIRONMENT,
      auth: { jwtSecret: 'predictable-injected-jwt' } as never,
      apiKeys: { jwtSecret: 'predictable-injected-api-key-jwt' } as never,
    })).toThrow('Runtime authentication dependency injection is forbidden');
  });

  it('rejeita inicializador de senha injetado fora de test para preservar Argon2id', () => {
    expect(() => buildApp({
      nodeEnv: 'production',
      environment: VALID_RUNTIME_ENVIRONMENT,
      passwordVerifierInitializer: async () => ({
        async verifyPasswordOrDummy() { return true; },
      }),
    })).toThrow('Runtime password verifier dependency injection is forbidden');
  });
});
