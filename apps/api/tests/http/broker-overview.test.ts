import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { issueAccessToken } from '@jrc/security';
import { registerTenantOperationsRoutes } from '../../src/http/routes/tenant-operations.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
const orgA = '11111111-1111-4111-8111-111111111111',
  orgB = '22222222-2222-4222-8222-222222222222',
  user = '44444444-4444-4444-8444-444444444444';
it('isola resumo por identidade, limita período, recusa API key e membership revogada', async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  let active = true;
  app.decorate('resolveTenantRole', async () => (active ? ('VIEWER' as const) : null));
  const queries: { org: string; values: unknown[] }[] = [];
  const jwtSecret = 'x'.repeat(48);
  await app.register(async (scope) =>
    registerTenantOperationsRoutes(scope, {
      jwtSecret,
      authenticateApiKey: async () => ({ organizationId: orgA, apiKeyId: user, scopes: ['*'] }),
      transact: async <T>(org: string, operation: (tx: TenantTransaction) => Promise<T>) =>
        operation({
          query: async (_sql: string, values: unknown[]) => {
            queries.push({ org, values });
            return {
              rows: [
                {
                  observedAt: new Date('2026-09-15T12:00:00Z'),
                  snapshot: {
                    connections: [
                      { provider: 'BAILEYS', status: 'CONNECTED', count: org === orgA ? 4 : 1 },
                    ],
                    daily: [],
                    incidents: [],
                  },
                },
              ],
            };
          },
        } as unknown as TenantTransaction),
    }),
  );
  const tokenA = await issueAccessToken(
      { userId: user, organizationId: orgA, role: 'OWNER' },
      jwtSecret,
    ),
    tokenB = await issueAccessToken(
      { userId: user, organizationId: orgB, role: 'OWNER' },
      jwtSecret,
    );
  const headers = { authorization: 'Bearer ' + tokenA };
  try {
    expect((await app.inject({ url: '/v1/organization/overview' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/v1/organization/overview', headers: { 'x-jrc-api-key': 'demo' } }))
        .statusCode,
    ).toBe(403);
    expect(queries).toHaveLength(0);
    const a = await app.inject({ url: '/v1/organization/overview?days=7', headers });
    expect(a.statusCode).toBe(200);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.json().connections.total).toBe(4);
    const b = await app.inject({
      url: '/v1/organization/overview',
      headers: { authorization: 'Bearer ' + tokenB },
    });
    expect(b.json().connections.total).toBe(1);
    expect(queries).toEqual([
      { org: orgA, values: [orgA, 7] },
      { org: orgB, values: [orgB, 30] },
    ]);
    expect(
      (await app.inject({ url: '/v1/organization/overview?days=365', headers })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/v1/organization/overview?organizationId=' + orgB, headers }))
        .statusCode,
    ).toBe(400);
    active = false;
    expect((await app.inject({ url: '/v1/organization/overview', headers })).statusCode).toBe(401);
    expect(queries).toHaveLength(2);
  } finally {
    await app.close();
  }
});
it('não expõe mensagens internas do banco ao navegador', async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const jwtSecret = 'x'.repeat(48);
  await app.register(async (scope) =>
    registerTenantOperationsRoutes(scope, {
      jwtSecret,
      authenticateApiKey: vi.fn(),
      transact: async () => {
        throw new Error('DATABASE_PRIVATE_CANARY');
      },
    }),
  );
  const token = await issueAccessToken(
    { userId: user, organizationId: orgA, role: 'OWNER' },
    jwtSecret,
  );
  try {
    const r = await app.inject({
      url: '/v1/organization/overview',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('DATABASE_PRIVATE_CANARY');
  } finally {
    await app.close();
  }
});
