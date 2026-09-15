import { afterEach, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import type { ChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182', id = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0', secret = 'integration-test-secret-at-least-32-bytes';
const apps: ReturnType<typeof buildApp>[] = [];
async function harness(role: 'OWNER'|'VIEWER' = 'OWNER') {
  const status = vi.fn().mockResolvedValue({ configured: true, baseUrl: 'https://conversas.test', provisioningAvailable: false, account: null, connections: [], jobs: {}, encrypted_token: 'secret-must-not-leak' });
  const bindAccount = vi.fn().mockImplementation(() => status());
  const service = { status, bindAccount } as unknown as ChatwootService;
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }),
    integrations: { service, jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => role } });
  apps.push(app);
  return { app, status, bindAccount, headers: { authorization: 'Bearer ' + await issueAccessToken({ userId: id, organizationId: org, role }, secret) } };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
it('isola organização pelo JWT e não retorna segredos internos', async () => {
  const h = await harness();
  const response = await h.app.inject({ url: '/v1/integrations/chatwoot', headers: h.headers });
  expect(response.statusCode).toBe(200);
  expect(h.status).toHaveBeenCalledWith(org);
  expect(response.body).not.toContain('secret-must-not-leak');
  expect((await h.app.inject({ url: '/v1/integrations/chatwoot?organizationId=forged', headers: h.headers })).statusCode).toBe(400);
});
it('recusa anônimo, VIEWER e empresa forjada no cadastro', async () => {
  const h = await harness('VIEWER');
  expect((await h.app.inject({ url: '/v1/integrations/chatwoot' })).statusCode).toBe(401);
  const payload = { accountId: 1, token: 'private-token' };
  expect((await h.app.inject({ method: 'PUT', url: '/v1/integrations/chatwoot/account', headers: h.headers, payload })).statusCode).toBe(403);
  expect(h.bindAccount).not.toHaveBeenCalled();
});
