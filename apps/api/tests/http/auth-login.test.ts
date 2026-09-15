import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import type { AuthRepository, AuthSessionRepository } from '../../src/modules/auth/repository.js';

const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';

function createAuthApp(options: { identityExists?: boolean; rateLimitUnavailable?: boolean } = {}) {
  const calls: string[] = [];
  let selectionConsumed = false;
  const repository: AuthRepository & AuthSessionRepository = {
    async findLoginIdentity() {
      calls.push('database');
      return options.identityExists === false ? null : {
        id: USER_ID,
        passwordHash: 'known-hash',
        status: 'ACTIVE',
        organizations: [{
          id: ORGANIZATION_ID,
          name: 'JRC',
          slug: 'jrc',
          role: 'OWNER',
        }],
      };
    },
    async createSelectionSession() { return undefined; },
    async consumeSelection() {
      if (selectionConsumed) return { outcome: 'REUSED' };
      selectionConsumed = true;
      return { outcome: 'SELECTED', userId: USER_ID, organizationId: ORGANIZATION_ID, role: 'OWNER' };
    },
    async rotateRefreshToken() { return { outcome: 'INVALID' }; },
    async revokeRefreshFamily() { return { outcome: 'INVALID' }; },
  };
  const store = options.rateLimitUnavailable
    ? { kind: 'redis' as const, async consume() { throw new Error('redis down canary'); } }
    : new MemoryRateLimitStore();
  const app = buildApp({
    nodeEnv: 'test',
    passwordVerifierInitializer: async () => ({
      async verifyPasswordOrDummy(candidate, hash) {
        calls.push('password');
        return candidate === 'correct-password' && hash === 'known-hash';
      },
    }),
    auth: {
      repository,
      rateLimitStore: store,
      ipRateLimitHmacSecret: 'ip-rate-limit-secret-with-at-least-32-bytes',
      identityRateLimitHmacSecret: 'identity-rate-secret-with-at-least-32-bytes',
      jwtSecret: 'jwt-secret-with-at-least-thirty-two-bytes',
      refreshTokenHashSecret: 'refresh-hash-secret-with-at-least-32-bytes',
      trustedProxyCidrs: ['10.0.0.0/24'],
      now: () => new Date('2030-01-01T12:00:00.000Z'),
      randomBytes: (size) => Buffer.alloc(size, 5),
      randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      sleeper: async () => undefined,
      writeSecurityAudit: async () => undefined,
      writeOrganizationSelectedAudit: async () => undefined,
    },
  });
  return { app, calls };
}

describe('rotas de autenticação', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('faz login e seleciona organização com contratos estritos e headers sensíveis', async () => {
    const harness = createAuthApp();
    apps.push(harness.app);

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '198.51.100.25',
        'x-request-id': REQUEST_ID,
      },
      payload: { email: ' Owner@Example.TEST ', password: 'correct-password' },
    });

    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.headers['x-request-id']).toBe(REQUEST_ID);
    expect(login.json()).toMatchObject({
      organizations: [{ id: ORGANIZATION_ID, name: 'JRC', slug: 'jrc', role: 'OWNER' }],
      expiresAt: '2030-01-01T12:05:00.000Z',
    });

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/select-organization',
      headers: { 'x-request-id': REQUEST_ID },
      payload: {
        organizationId: ORGANIZATION_ID,
        selectionToken: login.json().selectionToken,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.headers['cache-control']).toBe('no-store');
    expect(selected.headers['x-request-id']).toBe(REQUEST_ID);
    expect(selected.json()).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/select-organization',
      payload: {
        organizationId: ORGANIZATION_ID,
        selectionToken: login.json().selectionToken,
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it.each([
    ['usuário desconhecido', false, 'correct-password'],
    ['senha incorreta', true, 'wrong-password'],
  ])('não permite enumerar %s', async (_label, identityExists, password) => {
    const harness = createAuthApp({ identityExists });
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.test', password },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      title: 'Authentication failed',
    });
  });

  it('rejeita payload extra e mantém no-store e request id', async () => {
    const harness = createAuthApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'owner@example.test',
        password: 'correct-password',
        organizationId: ORGANIZATION_ID,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json()).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      title: 'Invalid request',
    });
    expect(JSON.stringify(response.json())).not.toContain('FST_ERR');
  });

  it('retorna 503 e Retry-After sem tocar banco ou Argon2 se Redis falhar', async () => {
    const harness = createAuthApp({ rateLimitUnavailable: true });
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.test', password: 'correct-password' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'AUTH_TEMPORARILY_UNAVAILABLE' });
    expect(harness.calls).toEqual([]);
  });

  it('protege seleção de organização e falha fechado antes do banco quando Redis falhar', async () => {
    const harness = createAuthApp({ rateLimitUnavailable: true });
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/select-organization',
      payload: {
        organizationId: ORGANIZATION_ID,
        selectionToken: 'A'.repeat(43),
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'AUTH_TEMPORARILY_UNAVAILABLE' });
    expect(harness.calls).toEqual([]);
  });

  it('rejeita injeção do MemoryRateLimitStore sincronamente fora de NODE_ENV=test', () => {
    expect(() => buildApp({
      nodeEnv: 'production',
      environment: {
        DATABASE_URL: 'postgresql://jrc_app@127.0.0.1:5432/jrc',
        AUTH_DATABASE_URL: 'postgresql://jrc_auth@127.0.0.1:5432/jrc',
        REDIS_URL: 'redis://127.0.0.1:6379',
        EVOLUTION_BASE_URL: 'http://127.0.0.1:8080',
        EVOLUTION_API_KEY: 'runtime-evolution-secret-value-100001',
        JWT_SECRET: 'runtime-jwt-secret-value-100000000002',
        REFRESH_TOKEN_HASH_SECRET: 'runtime-refresh-secret-value-10000003',
        API_KEY_HMAC_SECRET: 'runtime-api-key-secret-value-100000004',
        IP_RATE_LIMIT_HMAC_SECRET: 'runtime-ip-rate-secret-value-10000005',
        IDENTITY_RATE_LIMIT_HMAC_SECRET: 'runtime-identity-secret-value-100006',
        CHALLENGE_ENCRYPTION_KEY: 'runtime-challenge-secret-value-1000007',
        BROWSER_CSRF_SECRET: 'runtime-browser-csrf-secret-value-100008',
        CONSOLE_ALLOWED_ORIGINS: 'https://console.jrc.example',
      },
      auth: {
        repository: {
          async findLoginIdentity() { return null; },
          async createSelectionSession() { return undefined; },
          async consumeSelection() { return { outcome: 'INVALID' }; },
          async rotateRefreshToken() { return { outcome: 'INVALID' }; },
          async revokeRefreshFamily() { return { outcome: 'INVALID' }; },
        },
        rateLimitStore: new MemoryRateLimitStore(),
        ipRateLimitHmacSecret: 'ip-rate-limit-secret-with-at-least-32-bytes',
        identityRateLimitHmacSecret: 'identity-rate-secret-with-at-least-32-bytes',
        jwtSecret: 'jwt-secret-with-at-least-thirty-two-bytes',
        refreshTokenHashSecret: 'refresh-hash-secret-with-at-least-32-bytes',
        trustedProxyCidrs: [],
        writeSecurityAudit: async () => undefined,
        writeOrganizationSelectedAudit: async () => undefined,
      },
    })).toThrow('Runtime authentication dependency injection is forbidden');
  });
});
