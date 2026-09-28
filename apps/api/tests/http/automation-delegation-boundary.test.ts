import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AutomationService, createExecutionService } from '../../src/modules/automations/service.js';

const secret = 'automation-delegation-test-secret-32-bytes';
const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const automationId = '33333333-3333-4333-8333-333333333333';
const graph = {
  nodes: [
    { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
    { id: 'end', type: 'end', label: 'Fim', position: { x: 1, y: 1 }, data: {} },
  ],
  edges: [{ id: 'edge', source: 'start', target: 'end', port: 'next' }],
};

describe('automation boundary for QR control credentials', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

  it('denies reading and editing Flow with either Account control key, including after a key is revoked', async () => {
    const list = vi.fn(), get = vi.fn(), create = vi.fn(), save = vi.fn(), publish = vi.fn();
    const service = { list, get, create, save, publish } as unknown as AutomationService;
    const currentRole = vi.fn().mockResolvedValue('OWNER');
    let revoked = false;
    const authenticateApiKey = vi.fn(async (raw: string) => {
      if (revoked) return null;
      if (raw === 'account-a-control') return { apiKeyId: automationId, organizationId: orgA, scopes: ['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair'] };
      if (raw === 'account-b-control') return { apiKeyId: automationId, organizationId: orgB, scopes: ['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair'] };
      return null;
    });
    const app = buildApp({
      nodeEnv: 'test',
      passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
      automations: { jwtSecret: secret, authenticateApiKey, resolveCurrentRole: currentRole,
        service, executions: {} as ReturnType<typeof createExecutionService> },
    });
    apps.push(app);

    for (const raw of ['account-a-control', 'account-b-control']) {
      const headers = { 'x-jrc-api-key': raw, 'idempotency-key': `flow-${raw}` };
      for (const request of [
        { method: 'GET' as const, url: '/v1/automations' },
        { method: 'GET' as const, url: `/v1/automations/${automationId}` },
        { method: 'POST' as const, url: '/v1/automations', payload: { name: 'Draft', graph } },
        { method: 'PUT' as const, url: `/v1/automations/${automationId}`, payload: { name: 'Draft', graph, revision: 1 } },
        { method: 'POST' as const, url: `/v1/automations/${automationId}/publish`, payload: { revision: 1 } },
      ]) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
      }
    }

    revoked = true;
    const revokedResponse = await app.inject({ method: 'GET', url: '/v1/automations', headers: { 'x-jrc-api-key': 'account-a-control' } });
    expect(revokedResponse.statusCode).toBe(401);
    expect(currentRole).not.toHaveBeenCalled();
    expect([list, get, create, save, publish].every(operation => operation.mock.calls.length === 0)).toBe(true);
  });
});
