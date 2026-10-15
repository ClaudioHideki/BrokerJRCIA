import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';

const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182', integration = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const requestId = '721d4277-c925-4873-85d6-0ce516873b62';
const snapshot = { organizationId: org, integrationId: integration, channelId: integration, conversationId: integration,
  accountId: 7, inboxId: 9, remoteConversationId: 11, remoteContactId: 13, ownerRevision: 1, attendanceRevision: 2, controlRevision: 3,
  destinationRevision: 1, credentialRevision: 1, mode: 'HUMAN' };
const operation = { ...snapshot, id: requestId, requestId, fingerprint: 'a'.repeat(64), state: 'PAUSED' };
const body = { requestId, fingerprint: 'a'.repeat(64), expectedOwnerRevision: 1, expectedAttendanceRevision: 2,
  expectedControlRevision: 3, expectedDestinationRevision: 1, expectedCredentialRevision: 1 };
const apps: ReturnType<typeof buildApp>[] = [];
function harness() {
  const principal = { organizationId: org, accountId: 7, destinationRevision: 1 };
  const authorize = vi.fn().mockResolvedValue(principal);
  const takeovers = { attendance: vi.fn().mockResolvedValue(snapshot), start: vi.fn().mockResolvedValue(operation),
    get: vi.fn().mockResolvedValue(operation), complete: vi.fn().mockResolvedValue({ ...operation, state: 'COMPLETED' }),
    cancel: vi.fn().mockResolvedValue({ ...operation, state: 'CANCELED' }) };
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    chatwootControl: { jwtSecret: 'synthetic-control-jwt-secret-at-least-32',
      authenticateApiKey: async raw => raw === 'synthetic-key' ? { organizationId: org, apiKeyId: integration, scopes: ['chatwoot:manage'] } : null,
      service: { enabled: true, authorize } as unknown as ChatwootControlAuth, takeovers } as never });
  apps.push(app);
  return { app, takeovers, authorize, headers: { 'x-jrc-api-key': 'synthetic-key', 'x-jrc-external-actor': '42' },
    url: `/v1/integrations/chatwoot/control/connections/${integration}/conversations/11` };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
it('exposes a no-store scoped snapshot and requires attributed service authority', async () => {
  const h = harness();
  const result = await h.app.inject({ method: 'GET', url: `${h.url}/attendance`, headers: h.headers });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual(snapshot);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(h.authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'API_KEY' }), 'chatwoot:manage', integration, '42');
  for (const actor of [undefined, '0', '-1', 'user:42', '042']) {
    const headers = { 'x-jrc-api-key': 'synthetic-key', ...(actor ? { 'x-jrc-external-actor': actor } : {}) };
    expect((await h.app.inject({ method: 'GET', url: `${h.url}/attendance`, headers })).statusCode).toBe(400);
  }
  expect((await h.app.inject({ method: 'GET', url: `${h.url}/attendance?accountId=99`, headers: h.headers })).statusCode).toBe(400);
});
it('requires matching UUID idempotency and rejects payload scope overrides', async () => {
  const h = harness(), headers = { ...h.headers, 'idempotency-key': requestId };
  const result = await h.app.inject({ method: 'POST', url: `${h.url}/takeovers`, headers, payload: body });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual(operation);
  expect((await h.app.inject({ method: 'POST', url: `${h.url}/takeovers`, headers: h.headers, payload: body })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'POST', url: `${h.url}/takeovers`, headers, payload: { ...body, accountId: 99 } })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'POST', url: `${h.url}/takeovers`, headers, payload: { ...body, requestId: integration } })).statusCode).toBe(400);
});
it('reads and completes the same operation without a send endpoint or content payload', async () => {
  const h = harness();
  expect((await h.app.inject({ method: 'GET', url: `${h.url}/takeovers/${requestId}`, headers: h.headers })).json()).toEqual(operation);
  const result = await h.app.inject({ method: 'POST', url: `${h.url}/takeovers/${requestId}/complete`, headers: h.headers, payload: { messageId: 23 } });
  expect(result.statusCode).toBe(200);
  expect(result.json().state).toBe('COMPLETED');
  expect((await h.app.inject({ method: 'POST', url: `${h.url}/takeovers/${requestId}/complete`, headers: h.headers,
    payload: { messageId: 23, content: 'Not accepted here' } })).statusCode).toBe(400);
});
it('cancels an unknown takeover by durable request identity, without extra content or idempotency headers', async () => {
  const h = harness(), payload = { requestId, fingerprint: body.fingerprint };
  const result = await h.app.inject({ method: 'POST', url: `${h.url}/takeovers/cancel`, headers: h.headers, payload });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ state: 'CANCELED', remoteContactId: 13, mode: 'HUMAN' });
  expect(h.takeovers.cancel).toHaveBeenCalledWith(expect.anything(), integration, 11, payload);
  expect((await h.app.inject({ method: 'POST', url: `${h.url}/takeovers/cancel`, headers: h.headers,
    payload: { ...payload, messageId: 23 } })).statusCode).toBe(400);
});
