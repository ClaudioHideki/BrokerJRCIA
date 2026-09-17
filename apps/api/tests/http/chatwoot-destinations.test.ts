import { afterEach, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import { createChatwootDestinationService } from '../../src/modules/integrations/chatwoot-destination.js';
import type { ChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182', user = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const secret = 'synthetic-integration-test-secret-at-least-32';
const apps: ReturnType<typeof buildApp>[] = [];
async function harness(role: 'OWNER' | 'VIEWER', enabled = true) {
  const dto = { organizationId: org, baseUrl: 'https://support.example.com', mode: 'EXTERNAL', approvalStatus: 'PENDING', mediaOrigins: [], revision: 1 };
  const request = vi.fn().mockResolvedValue({ ...dto, token: 'must-not-leak' });
  const destinations = enabled ? { enabled, request, get: vi.fn().mockResolvedValue(dto) }
    : createChatwootDestinationService({ enabled: false, transact: vi.fn() });
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    integrations: { service: { destinations } as unknown as ChatwootService, jwtSecret: secret,
      authenticateApiKey: async () => null, resolveCurrentRole: async () => role } });
  apps.push(app);
  return { app, request, headers: { authorization: 'Bearer ' + await issueAccessToken({ userId: user, organizationId: org, role }, secret) } };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
it('takes the tenant only from authentication and exposes no credentials', async () => {
  const h = await harness('OWNER');
  const input = { baseUrl: 'https://support.example.com', mode: 'EXTERNAL' };
  const r = await h.app.inject({ method: 'PUT', url: '/v1/integrations/chatwoot/destination', headers: h.headers, payload: input });
  expect(r.statusCode).toBe(200);
  expect(h.request).toHaveBeenCalledWith(org, input);
  expect(r.body).not.toContain('must-not-leak');
  for (const extra of [{ organizationId: user }, { token: 'synthetic' }, { approvalStatus: 'APPROVED' }]) {
    expect((await h.app.inject({ method: 'PUT', url: '/v1/integrations/chatwoot/destination', headers: h.headers, payload: { ...input, ...extra } })).statusCode).toBe(400);
  }
  expect(h.request).toHaveBeenCalledTimes(1);
});
it('denies anonymous users, viewers and a disabled feature before mutation', async () => {
  const h = await harness('VIEWER');
  const input = { method: 'PUT' as const, url: '/v1/integrations/chatwoot/destination', payload: { baseUrl: 'https://support.example.com', mode: 'EXTERNAL' } };
  expect((await h.app.inject(input)).statusCode).toBe(401);
  expect((await h.app.inject({ ...input, headers: h.headers })).statusCode).toBe(403);
  expect(h.request).not.toHaveBeenCalled();
  const disabled = await harness('OWNER', false);
  expect((await disabled.app.inject({ ...input, headers: disabled.headers })).statusCode).toBe(404);
});
