import { afterEach, describe, expect, it } from 'vitest';

import type { Page, ProviderAccount } from '@jrc/contracts';
import { issueAccessToken } from '@jrc/security';

import { buildApp } from '../../src/app.js';

const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const ORGANIZATION_ID = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const USER_ID = 'd8caa763-c0b0-40bd-94c5-dbb558a48729';
const ACCOUNT_ID = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const REQUEST_ID = '85a17103-9f0d-4d86-b55d-4184597e17a8';

async function token(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER') {
  return issueAccessToken({ userId: USER_ID, organizationId: ORGANIZATION_ID, role }, JWT_SECRET);
}

function createHarness() {
  const calls: unknown[] = [];
  const page: Page<ProviderAccount> = {
    data: [{
      id: ACCOUNT_ID,
      name: 'Baileys principal',
      provider: 'BAILEYS',
      createdAt: '2030-01-01T00:00:00.000Z',
    }],
    pageInfo: { hasNextPage: false, nextCursor: null },
  };
  const app = buildApp({
    nodeEnv: 'test',
    passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    providerAccounts: {
      jwtSecret: JWT_SECRET,
      async authenticateApiKey(rawApiKey) {
        return rawApiKey === 'valid-read-key'
          ? { apiKeyId: ACCOUNT_ID, organizationId: ORGANIZATION_ID, scopes: ['instances:read'] }
          : null;
      },
      service: {
        async listProviderAccounts(organizationId, input) {
          calls.push({ organizationId, input });
          return page;
        },
      },
    },
  });
  return { app, calls };
}

describe('GET /v1/provider-accounts', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it.each(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as const)(
    'lista metadados para %s sem aceitar organization_id do cliente',
    async (role) => {
      const test = createHarness();
      apps.push(test.app);
      const response = await test.app.inject({
        method: 'GET',
        url: '/v1/provider-accounts?provider=BAILEYS&limit=20',
        headers: {
          authorization: `Bearer ${await token(role)}`,
          'x-request-id': REQUEST_ID,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-request-id']).toBe(REQUEST_ID);
      expect(response.json()).toMatchObject({ data: [{ id: ACCOUNT_ID, provider: 'BAILEYS' }] });
      expect(response.body).not.toMatch(/credential|externalReference|organizationId|secret/i);
      expect(test.calls).toEqual([{
        organizationId: ORGANIZATION_ID,
        input: { provider: 'BAILEYS', limit: 20 },
      }]);
    },
  );

  it('aceita API key apenas com instances:read e rejeita credenciais ausentes', async () => {
    const test = createHarness();
    apps.push(test.app);
    const allowed = await test.app.inject({
      method: 'GET',
      url: '/v1/provider-accounts',
      headers: { 'x-jrc-api-key': 'valid-read-key' },
    });
    const denied = await test.app.inject({ method: 'GET', url: '/v1/provider-accounts' });

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(401);
    expect(test.calls).toHaveLength(1);
  });

  it('rejeita parâmetros extras e limites inválidos antes do serviço', async () => {
    const test = createHarness();
    apps.push(test.app);
    const authorization = `Bearer ${await token('OWNER')}`;
    const extra = await test.app.inject({
      method: 'GET',
      url: `/v1/provider-accounts?organization_id=${ORGANIZATION_ID}`,
      headers: { authorization },
    });
    const limit = await test.app.inject({
      method: 'GET',
      url: '/v1/provider-accounts?limit=101',
      headers: { authorization },
    });

    expect(extra.statusCode).toBe(400);
    expect(limit.statusCode).toBe(400);
    expect(test.calls).toEqual([]);
  });
});
