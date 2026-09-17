import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserCsrfToken, issueAccessToken, redactSensitive } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { IntegrationError } from '../../src/modules/integrations/integration-error.js';
import type { EmbedAuthorizationService } from '../../src/modules/integrations/embed/authorization.js';
import type { ChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
import type { InstanceService } from '../../src/modules/instances/service.js';
import type { MessagingService } from '../../src/http/routes/messaging.js';
import { PlatformError, type PlatformService } from '../../src/modules/platform/service.js';
const org = 'd2e5b0ac-1387-40b9-a722-743f2e061220', id = 'dc938cef-b6e6-4e0c-b9bd-47c8858a14ed', user = 'c3c028f0-f0f9-48e0-99f5-5cedb283de2d';
const secret = 'synthetic-embed-jwt-at-least-32-characters', origin = 'https://broker.example.test';
const running: ReturnType<typeof buildApp>[] = [];
const health = { integrationId: id, inboxId: 31, instanceId: id, integrationStatus: 'READY', instanceStatus: 'DISCONNECTED',
  transportStatus: 'UNVERIFIED', checkedAt: new Date().toISOString(), lastError: null, identityStatus: 'CONFIRMED', identityApproved: true,
  identityRevision: 1, observedNumberSuffix: null, callbackVerifiedAt: null, lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null, allowedActions: ['status', 'pair'] };
async function harness(enabled = true) {
  const start = vi.fn().mockResolvedValue({ requestId: id, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const approve = vi.fn().mockResolvedValue({ ok: true });
  const authorize = vi.fn(async (token: string) => { if (token !== 's'.repeat(43)) throw new IntegrationError('EMBED_AUTHORIZATION_DENIED', 403); return { organizationId: org }; });
  const status = vi.fn().mockResolvedValue(health), pair = vi.fn().mockRejectedValue(new IntegrationError('EMBED_AUTHORIZATION_DENIED', 403));
  const instance = vi.fn(), sendMessage = vi.fn(), createUser = vi.fn();
  const describe = vi.fn().mockResolvedValue({ embedId: id, title: 'JRC', url: `${origin}/embed/chatwoot/${id}`, state: 'UNCONFIGURED', remoteAppId: null });
  const install = vi.fn().mockResolvedValue({ embedId: id, title: 'JRC', url: `${origin}/embed/chatwoot/${id}`, state: 'MANUAL', remoteAppId: null });
  const service = { repository: { enabled() { if (!enabled) throw new IntegrationError('CHATWOOT_EMBED_DISABLED', 404); } }, start, approve,
    sessions: { authorize }, apps: { describe, install, policy: vi.fn().mockResolvedValue({ origin: 'https://chatwoot.example.test' }), register: vi.fn().mockResolvedValue({ embedId: id }) } } as unknown as EmbedAuthorizationService;
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    chatwootEmbed: { nodeEnv: 'test', jwtSecret: secret, authenticateApiKey: async () => ({ organizationId: org, apiKeyId: id, scopes: [] }),
      service, facade: { status, pair } as unknown as ChatwootControlService, browserCsrfSecret: secret, browserCookieSecure: true,
      consoleAllowedOrigins: [origin], trustedProxyCidrs: [] },
    instances: { jwtSecret: secret, authenticateApiKey: async () => null, service: new Proxy({}, { get: () => instance }) as InstanceService },
    messaging: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OWNER', service: new Proxy({}, { get: () => sendMessage }) as MessagingService },
    platform: { origin, secureCookies: true, service: { async session() { throw new PlatformError(401, 'PLATFORM_UNAUTHORIZED'); }, execute: createUser } as unknown as PlatformService } });
  running.push(app);
  const token = await issueAccessToken({ userId: user, organizationId: org, role: 'OWNER' }, secret), csrf = createBrowserCsrfToken(secret);
  return { app, start, approve, authorize, status, pair, instance, describe, install, sendMessage, createUser,
    headers: { authorization: `Bearer ${token}`, origin, cookie: `__Host-jrc_csrf=${csrf}`, 'x-csrf-token': csrf } };
}
afterEach(async () => { await Promise.all(running.splice(0).map(app => app.close())); });
it('keeps setup JWT-only, no-store, and refuses client-selected URL or tenant', async () => {
  const h = await harness(), url = `/v1/integrations/chatwoot/embed-apps/${id}`;
  for (const headers of [{}, { 'x-jrc-api-key': 'synthetic' }, { authorization: `Bearer ${'s'.repeat(43)}` }])
    expect([401, 403]).toContain((await h.app.inject({ method: 'POST', url: url + '/install', headers, payload: {} })).statusCode);
  expect(h.install).not.toHaveBeenCalled();
  const read = await h.app.inject({ method: 'GET', url, headers: h.headers });
  expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('no-store');
  expect((await h.app.inject({ method: 'POST', url: url + '/install', headers: h.headers, payload: { url: 'https://evil.example' } })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'POST', url: url + '/install', headers: h.headers, payload: {} })).statusCode).toBe(200);
  expect(h.install).toHaveBeenCalledOnce();
});
it('starts only a proof request, uses no-store, and rejects tenant injection', async () => {
  const h = await harness(), url = '/v1/embed/authorizations', payload = { embedId: id, challenge: 'A'.repeat(43) };
  const response = await h.app.inject({ method: 'POST', url, payload });
  expect(response.statusCode).toBe(201); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain('token');
  expect((await h.app.inject({ method: 'POST', url, payload: { ...payload, organizationId: org } })).statusCode).toBe(400);
  expect((await h.app.inject({ method: 'POST', url: url + '?origin=https://evil.example', payload })).statusCode).toBe(400);
  const off = await harness(false);
  expect((await off.app.inject({ method: 'POST', url, payload })).statusCode).toBe(404); expect(off.start).not.toHaveBeenCalled();
});
it('requires Broker JWT, exact origin and signed matching CSRF for approval', async () => {
  const h = await harness(), url = `/v1/embed/authorizations/${id}/approve`, payload = { integrationIds: [id] };
  for (const headers of [{}, { 'x-jrc-api-key': 'synthetic' }, { authorization: h.headers.authorization },
    { ...h.headers, origin: 'https://evil.example' }, { ...h.headers, 'x-csrf-token': 'wrong' }]) {
    expect([401, 403]).toContain((await h.app.inject({ method: 'POST', url, payload, headers })).statusCode);
  }
  expect(h.approve).not.toHaveBeenCalled();
  expect((await h.app.inject({ method: 'POST', url, payload, headers: h.headers })).statusCode).toBe(200);
  expect(h.approve).toHaveBeenCalledOnce();
});
it('limits bearer session to state/pair, checks it after HTTP and refuses generic instance access', async () => {
  const h = await harness(), headers = { authorization: `Bearer ${'s'.repeat(43)}` };
  const response = await h.app.inject({ method: 'GET', url: `/v1/embed/connections/${id}/status`, headers });
  expect(response.statusCode).toBe(200); expect(response.json().allowedActions).toEqual(['status', 'pair']);
  expect(h.authorize).toHaveBeenCalledTimes(2);
  expect((await h.app.inject({ method: 'POST', url: `/v1/embed/connections/${id}/disconnect`, headers, payload: {} })).statusCode).toBe(404);
  expect((await h.app.inject({ method: 'GET', url: '/v1/instances', headers })).statusCode).toBe(401); expect(h.instance).not.toHaveBeenCalled();
  expect((await h.app.inject({ method: 'POST', url: '/v1/instances', headers: { ...headers, 'idempotency-key': 'synthetic-only' }, payload: { provider: 'BAILEYS', providerAccountId: id, name: 'Synthetic' } })).statusCode).toBe(401);
  expect((await h.app.inject({ method: 'POST', url: `/v1/messaging/channels/${id}/text`, headers: { ...headers, 'idempotency-key': 'synthetic-only' }, payload: { conversationId: id, text: 'Synthetic' } })).statusCode).toBe(401);
  expect((await h.app.inject({ method: 'PUT', url: `/v1/platform/organizations/${org}/memberships`, headers: { ...headers, origin, 'x-platform-reason': 'Synthetic validation' },
    payload: { email: 'synthetic@example.test', password: 'synthetic-only-password', role: 'VIEWER', status: 'ACTIVE' } })).statusCode).toBe(401);
  expect(h.instance).not.toHaveBeenCalled(); expect(h.sendMessage).not.toHaveBeenCalled(); expect(h.createUser).not.toHaveBeenCalled();
  h.authorize.mockRejectedValueOnce(new IntegrationError('EMBED_AUTHORIZATION_DENIED', 403));
  const denied = await h.app.inject({ method: 'POST', url: `/v1/embed/connections/${id}/pair`, headers: { ...headers, 'idempotency-key': 'synthetic-pair' }, payload: {} });
  expect(denied.statusCode).toBe(403); expect(h.pair).not.toHaveBeenCalled();
});
it('redacts proof material even when passed as a diagnostic field', () => {
  expect(JSON.stringify(redactSensitive({ verifier: 'synthetic-proof-must-not-log', token: 'synthetic-token', qr: 'synthetic-qr' }))).not.toContain('synthetic');
});

it('suppresses provider output when the grant expires while the request is in flight', async () => {
  const h = await harness(), headers = { authorization: `Bearer ${'s'.repeat(43)}`, 'idempotency-key': 'synthetic-pair' };
  h.pair.mockResolvedValueOnce({ action: { type: 'QR_CODE', qr: 'synthetic-secret-qr' } });
  h.authorize.mockResolvedValueOnce({ organizationId: org }).mockRejectedValueOnce(new IntegrationError('EMBED_AUTHORIZATION_DENIED', 403));
  const response = await h.app.inject({ method: 'POST', url: `/v1/embed/connections/${id}/pair`, headers, payload: {} });
  expect(h.pair).toHaveBeenCalledOnce(); expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain('synthetic-secret-qr');
});
