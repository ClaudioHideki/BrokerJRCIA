import { expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { welcomeFlow } from '@jrc/contracts';
import { buildApp } from '../../src/app.js';

const organizationId = '11111111-1111-4111-8111-111111111111', userId = '22222222-2222-4222-8222-222222222222';
const secret = 'package-http-synthetic-auth-32-characters';
const payload = { format: 'jrc-broker-package/1', rootKey: 'root', flows: [{ key: 'root', name: 'Robot', graph: welcomeFlow() }] };
it('previews and imports only for the authenticated tenant and never activates', async () => {
  const preview = vi.fn(async () => ({ createdAsDraft: false })), importPackage = vi.fn(async () => ({ state: 'DRAFT' }));
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
    automationPackages: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OWNER',
      service: { preview, import: importPackage } },
  } as never);
  const authorization = 'Bearer ' + await issueAccessToken({ userId, organizationId, role: 'OWNER' }, secret);
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/automation-packages/preview', headers: { authorization }, payload });
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(preview).toHaveBeenCalledWith(organizationId, payload);
    const imported = await app.inject({ method: 'POST', url: '/v1/automation-packages', headers: { authorization, 'idempotency-key': 'package-import-1' }, payload });
    expect(imported.statusCode).toBe(201); expect(importPackage).toHaveBeenCalledWith(organizationId, payload, 'package-import-1');
    const foreign = await app.inject({ method: 'POST', url: '/v1/automation-packages', headers: { authorization, 'idempotency-key': 'foreign-package-1' }, payload: { ...payload, organizationId } });
    expect(foreign.statusCode).toBe(400); expect(importPackage).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it('rechecks current administrator role before reading or importing a package', async () => {
  const preview = vi.fn();
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
    automationPackages: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OPERATOR', service: { preview } },
  } as never);
  const authorization = 'Bearer ' + await issueAccessToken({ userId, organizationId, role: 'OWNER' }, secret);
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/automation-packages/preview', headers: { authorization }, payload });
    expect(result.statusCode).toBe(403); expect(preview).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
