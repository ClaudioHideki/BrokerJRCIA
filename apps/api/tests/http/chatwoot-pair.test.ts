import { afterEach, it, expect, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import type { ChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
const org = '701c3ae6-5b19-4257-ae4f-5528b61b7fa6', id = 'ca93ad35-0a3f-48dc-9032-c47780498804';
let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => app?.close());
it('uses the existing ephemeral connection contract, requires the scoped action and never pairs on GET', async () => {
  const authorize = vi.fn().mockResolvedValue({ organizationId: org }), pair = vi.fn().mockResolvedValue({
    instance: { id, organizationId: org, providerAccountId: id, provider: 'BAILEYS', name: 'Fixture', status: 'AWAITING_ACTION', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    operationId: id, pending: false, replayed: false, reconciliationRequired: false,
    action: { type: 'QR_CODE', encoding: 'BASE64', value: 'synthetic-ephemeral-qr', expiresAt: new Date(Date.now() + 60000).toISOString() },
  });
  const status = vi.fn().mockResolvedValue({ integrationId: id, inboxId: 31, instanceId: id, integrationStatus: 'READY', instanceStatus: 'DISCONNECTED',
    callbackVerifiedAt: null, lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null, transportStatus: 'UNVERIFIED', checkedAt: new Date().toISOString(), lastError: null,
    allowedActions: ['status', 'pair'], identityStatus: 'CONFIRMED', identityRevision: 1, observedNumberSuffix: '0100' });
  app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
    chatwootControl: { jwtSecret: 'synthetic-at-least-32-characters-jwt', authenticateApiKey: async () => ({ apiKeyId: id, organizationId: org, scopes: ['chatwoot:pair', 'chatwoot:read'] }),
      service: { enabled: true, authorize } as unknown as ChatwootControlAuth, facade: { pair, status } as unknown as ChatwootControlService } });
  const headers = { 'x-jrc-api-key': 'synthetic-only', 'idempotency-key': 'synthetic-pairing-001' }, url = `/v1/integrations/chatwoot/control/connections/${id}`;
  const read = await app.inject({ method: 'GET', url: `${url}/status`, headers });
  expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('no-store'); expect(pair).not.toHaveBeenCalled();
  expect(read.body).not.toContain('synthetic-ephemeral-qr');
  expect((await app.inject({ method: 'POST', url: `${url}/pair`, headers, payload: { accountId: 99 } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url: `${url}/pair`, headers, payload: {} });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(response.json().action.type).toBe('QR_CODE');
  expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: org, kind: 'API_KEY' }), 'chatwoot:pair', id, undefined);
  expect((await app.inject({ method: 'GET', url: `${url}/pair`, headers })).statusCode).toBe(404);
});
