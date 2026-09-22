import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import type { ChannelFacade } from '../../src/modules/channels/facade.js';
import { buildApp } from '../../src/app.js';

const secret = 'channels-test-secret-with-at-least-32-bytes';
const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const user = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const account = 'd8caa763-c0b0-40bd-94c5-dbb558a48729';
const timestamp = '2030-01-01T12:00:00.000Z';
const channel = { schemaVersion: 1 as const, id, organizationId: org, provider: 'QR' as const,
  identity: { displayName: 'Atendimento', maskedAddress: null },
  providerReference: { providerAccountId: account, instanceId: id }, transportStatus: 'CONNECTED' as const,
  providerStatus: 'READY' as const, automationStatus: 'UNBOUND' as const, humanStatus: 'UNBOUND' as const,
  revision: 1, createdAt: timestamp, updatedAt: timestamp };

describe('canonical channel routes', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

  it('lists channels and applies current tenant role on writes', async () => {
    let role: 'OWNER' | 'VIEWER' = 'OWNER';
    const service = { list: vi.fn().mockResolvedValue({ data: [channel] }), get: vi.fn().mockResolvedValue(channel),
      create: vi.fn().mockResolvedValue({ provider: 'QR', channel, operationId: null, replayed: false, pending: false, reconciliationRequired: false }),
      pair: vi.fn(), bindDestination: vi.fn().mockResolvedValue({ ...channel, humanStatus: 'READY' }) } as unknown as ChannelFacade;
    const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
      channels: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => role, service } });
    apps.push(app);
    const authorization = `Bearer ${await issueAccessToken({ userId: user, organizationId: org, role: 'OWNER' }, secret)}`;
    const listed = await app.inject({ method: 'GET', url: '/v1/channels', headers: { authorization } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0]).toMatchObject({ id, transportStatus: 'CONNECTED' });
    const created = await app.inject({ method: 'POST', url: '/v1/channels', headers: { authorization, 'idempotency-key': 'create-channel' },
      payload: { provider: 'QR', name: 'Atendimento', providerAccountId: account } });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalled();
    role = 'VIEWER';
    expect((await app.inject({ method: 'PUT', url: `/v1/channels/${id}/destination`, headers: { authorization },
      payload: { name: 'Caixa suporte' } })).statusCode).toBe(403);
  });

  it('returns no-store challenges and requires an idempotency key', async () => {
    const service = { pair: vi.fn().mockResolvedValue({ provider: 'QR', channel, operationId: null, replayed: false, pending: true,
      reconciliationRequired: false, action: { type: 'QR_CODE', encoding: 'DATA_URL', value: 'data:image/png;base64,abc', expiresAt: timestamp } }) } as unknown as ChannelFacade;
    const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
      channels: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OWNER', service } });
    apps.push(app);
    const authorization = `Bearer ${await issueAccessToken({ userId: user, organizationId: org, role: 'OWNER' }, secret)}`;
    expect((await app.inject({ method: 'POST', url: `/v1/channels/${id}/pair`, headers: { authorization }, payload: {} })).statusCode).toBe(400);
    const paired = await app.inject({ method: 'POST', url: `/v1/channels/${id}/pair`,
      headers: { authorization, 'idempotency-key': 'pair-channel' }, payload: {} });
    expect(paired.statusCode).toBe(200);
    expect(paired.headers['cache-control']).toBe('no-store');
    expect(paired.headers.pragma).toBe('no-cache');
  });
});
