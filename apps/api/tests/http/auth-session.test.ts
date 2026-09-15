import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import type { AuthRepository, AuthSessionRepository } from '../../src/modules/auth/repository.js';

const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';
const RAW_REFRESH = 'refresh-token-boundary-canary-value-0000000';

function createSessionApp(
  rotationOutcome: 'ROTATED' | 'INVALID' | 'REUSED' = 'ROTATED',
  loggerDestination?: Writable,
) {
  const persisted: unknown[] = [];
  const audits: unknown[] = [];
  const repository: AuthRepository & AuthSessionRepository = {
    async findLoginIdentity() { return null; },
    async createSelectionSession() { return undefined; },
    async consumeSelection() { return { outcome: 'INVALID' }; },
    async rotateRefreshToken(input) {
      persisted.push(input);
      if (rotationOutcome !== 'ROTATED') return { outcome: rotationOutcome };
      return {
        outcome: 'ROTATED',
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        role: 'OWNER',
      };
    },
    async revokeRefreshFamily(input) {
      persisted.push(input);
      return { outcome: 'REVOKED' };
    },
  };
  const app = buildApp({
    nodeEnv: 'test',
    ...(loggerDestination ? { loggerDestination } : {}),
    passwordVerifierInitializer: async () => ({
      async verifyPasswordOrDummy() { return false; },
    }),
    auth: {
      repository,
      rateLimitStore: new MemoryRateLimitStore(),
      ipRateLimitHmacSecret: 'ip-rate-limit-secret-with-at-least-32-bytes',
      identityRateLimitHmacSecret: 'identity-rate-secret-with-at-least-32-bytes',
      refreshTokenHashSecret: 'refresh-hash-secret-with-at-least-32-bytes',
      jwtSecret: 'jwt-secret-with-at-least-thirty-two-bytes',
      trustedProxyCidrs: [],
      now: () => new Date('2030-01-01T12:00:00.000Z'),
      randomBytes: (size) => Buffer.alloc(size, 8),
      randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      sleeper: async () => undefined,
      writeSecurityAudit: async (event) => { audits.push(event); },
      writeOrganizationSelectedAudit: async () => undefined,
    },
  });
  return { app, audits, persisted };
}

describe('sessões HTTP de autenticação', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('rotaciona refresh com contrato estrito, no-store e request id', async () => {
    const harness = createSessionApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { refreshToken: RAW_REFRESH },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
    expect(response.json().refreshToken).not.toBe(RAW_REFRESH);
    expect(JSON.stringify({ audits: harness.audits, persisted: harness.persisted })).not.toContain(RAW_REFRESH);
  });

  it.each(['INVALID', 'REUSED'] as const)('não diferencia sessão inválida de %s', async (outcome) => {
    const harness = createSessionApp(outcome);
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { refreshToken: RAW_REFRESH },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Authentication failed',
      status: 401,
      code: 'INVALID_SESSION',
      requestId: REQUEST_ID,
    });
  });

  it.each([
    ['refresh sem token', '/v1/auth/refresh', {}],
    ['refresh com campo extra', '/v1/auth/refresh', { refreshToken: RAW_REFRESH, accessToken: 'must-not-be-accepted' }],
    ['logout com token malformado', '/v1/auth/logout', { refreshToken: 'short' }],
  ])('rejeita %s com problem details, no-store e request id', async (_label, url, payload) => {
    const harness = createSessionApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url,
      headers: { 'x-request-id': REQUEST_ID },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST', requestId: REQUEST_ID });
    expect(harness.persisted).toEqual([]);
  });

  it('faz logout idempotente sem conteúdo e sem ecoar o refresh token', async () => {
    const harness = createSessionApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { refreshToken: RAW_REFRESH },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(JSON.stringify({ audits: harness.audits, persisted: harness.persisted })).not.toContain(RAW_REFRESH);
  });

  it.each([
    ['JSON malformado', 'application/json', '{"refreshToken":', 400],
    ['media type não suportado', 'application/xml', '<refreshToken>redacted</refreshToken>', 415],
  ])('sanitiza %s como problem details 4xx', async (_label, contentType, payload, statusCode) => {
    const harness = createSessionApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': contentType, 'x-request-id': REQUEST_ID },
      payload,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'about:blank',
      title: 'Invalid request',
      status: statusCode,
      code: 'INVALID_REQUEST',
      requestId: REQUEST_ID,
    });
    expect(response.body).not.toContain('FST_ERR');
    expect(response.body).not.toContain(payload);
  });

  it('usa o mesmo request id validado na resposta, auditoria e logger Fastify', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const harness = createSessionApp('ROTATED', sink);
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { refreshToken: RAW_REFRESH },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(harness.audits).toEqual([expect.objectContaining({ requestId: REQUEST_ID })]);
    const logRecords = chunks.map((chunk) => JSON.parse(chunk) as { req?: { id?: string } });
    expect(logRecords.some(({ req }) => req?.id === REQUEST_ID)).toBe(true);
  });
});
import { Writable } from 'node:stream';
