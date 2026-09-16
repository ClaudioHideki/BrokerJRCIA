import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import type { ChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import type { InstanceService } from '../../src/modules/instances/service.js';
import type { ChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import type { OnboardingService } from '../../src/modules/integrations/chatwoot-onboarding.js';
const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182', keyId = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const secret = 'synthetic-control-jwt-secret-at-least-32';
const apps: ReturnType<typeof buildApp>[] = [];
function harness(enabled = true) {
  const context = vi.fn().mockResolvedValue({ organizationId: org, accountId: 1, destinationRevision: 1,
    chatwootOrigin: 'https://customer.example.com', capabilities: { signatures: 'UNVERIFIED' } });
  const authenticateApiKey = async (raw: string) => raw === 'synthetic-control' ? { organizationId: org, apiKeyId: keyId, scopes: ['chatwoot:read'] } : null;
  const service = enabled ? { enabled: true, context } as unknown as ChatwootControlAuth : createChatwootControlAuth({ enabled: false, hmacSecret: secret, transact: vi.fn(), resolveCurrentRole: vi.fn() });
  const authorize = vi.fn().mockResolvedValue({ organizationId: org, accountId: 1, destinationRevision: 1 });
  if (enabled) service.authorize = authorize;
  const operation = { operationId: '721d4277-c925-4873-85d6-0ce516873b62', state: 'PENDING', stage: 'INSTANCE', instanceId: null, integrationId: null, inboxId: null, lastError: null };
  const start = vi.fn().mockResolvedValue(operation), get = vi.fn().mockResolvedValue(operation), recover = vi.fn().mockResolvedValue(operation);
  const instance = vi.fn();
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    chatwootControl: { jwtSecret: secret, authenticateApiKey, service, onboarding: { start, get, recover } as unknown as OnboardingService },
    integrations: { jwtSecret: secret, authenticateApiKey, resolveCurrentRole: async () => null, service: new Proxy({}, { get: () => instance }) as ChatwootService },
    instances: { jwtSecret: secret, authenticateApiKey, service: new Proxy({}, { get: () => instance }) as InstanceService } });
  apps.push(app);
  return { app, context, instance, authorize, start, get, recover, operation, headers: { 'x-jrc-api-key': 'synthetic-control' } };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
it('accepts a separately scoped key only on the control facade and strips secrets', async () => {
  const h = harness();
  const r = await h.app.inject({ method: 'GET', url: '/v1/integrations/chatwoot/control/context', headers: h.headers });
  expect(r.statusCode).toBe(200); expect(r.body).not.toContain('must-not-leak');
  expect(h.context).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, kind: 'API_KEY', apiKeyId: keyId }));
  h.context.mockResolvedValueOnce({ organizationId: org, accountId: 1, destinationRevision: 1,
    chatwootOrigin: 'https://customer.example.com', capabilities: {}, secret: 'must-not-leak' });
  const unexpected = await h.app.inject({ method: 'GET', url: '/v1/integrations/chatwoot/control/context', headers: h.headers });
  expect(unexpected.statusCode).toBe(503); expect(unexpected.body).not.toContain('must-not-leak');
  expect((await h.app.inject({ method: 'GET', url: '/v1/instances', headers: h.headers })).statusCode).toBe(403);
  expect((await h.app.inject({ method: 'GET', url: '/v1/integrations/chatwoot', headers: h.headers })).statusCode).toBe(403);
  expect(h.instance).not.toHaveBeenCalled();
  expect((await h.app.inject({ method: 'GET', url: '/v1/integrations/chatwoot/control/context?organizationId=other', headers: h.headers })).statusCode).toBe(400);
});
it('rejects no credential, a Chatwoot token, key-based issuance and disabled feature', async () => {
  const h = harness();
  const url = '/v1/integrations/chatwoot/control/context';
  expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  expect((await h.app.inject({ method: 'GET', url, headers: { 'x-jrc-api-key': 'chatwoot-application-token' } })).statusCode).toBe(401);
  expect((await h.app.inject({ method: 'POST', url: '/v1/integrations/chatwoot/control-credentials', headers: { ...h.headers, 'idempotency-key': 'issue-synthetic' }, payload: { name: 'Rails', scopes: ['chatwoot:read'] } })).statusCode).toBe(403);
  const disabled = harness(false);
  expect((await disabled.app.inject({ method: 'GET', url, headers: disabled.headers })).statusCode).toBe(404);
});
it('requires idempotency, validates onboarding input, attributes the service actor and returns a no-store operation', async () => {
  const h = harness(), url = '/v1/integrations/chatwoot/control/onboarding';
  const payload = { name: 'Fixture', source: { kind: 'EXISTING', instanceId: '69a26b44-9315-445f-9c46-c76d7ed12f83' }, agentIds: [], replaceExistingWebhook: false };
  expect((await h.app.inject({ method: 'POST', url, payload, headers: h.headers })).statusCode).toBe(400);
  const headers = { ...h.headers, 'idempotency-key': 'synthetic-onboarding', 'x-jrc-external-actor': '42' };
  expect((await h.app.inject({ method: 'POST', url, payload: { ...payload, accountId: 99 }, headers })).statusCode).toBe(400);
  const response = await h.app.inject({ method: 'POST', url, payload, headers });
  expect(response.statusCode).toBe(202); expect(response.headers['cache-control']).toBe('no-store'); expect(response.json()).toEqual(h.operation);
  expect(h.authorize).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'API_KEY', organizationId: org }), 'chatwoot:manage', undefined, '42');
  expect(h.start).toHaveBeenCalledTimes(1);
  expect((await h.app.inject({ method: 'GET', url: `${url}/${h.operation.operationId}`, headers: h.headers })).statusCode).toBe(200);
  expect((await h.app.inject({ method: 'POST', url: `${url}/${h.operation.operationId}/recover`, headers, payload: { action: 'RECONCILE' } })).statusCode).toBe(202);
  expect(h.recover).toHaveBeenCalledWith(expect.anything(), h.operation.operationId, 'RECONCILE', 'synthetic-onboarding');
});
