import { expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
const org = '11111111-1111-4111-8111-111111111111', actor = '22222222-2222-4222-8222-222222222222';
const secret = 'guided-http-synthetic-auth-secret-32-characters';
it('derives setup tenant and actor from authenticated session, never from the request body', async () => {
  const start = vi.fn(async () => ({ id: org })), availability = vi.fn(async () => ({ enabled: true }));
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
    guidedSetup: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OWNER', service: { start, availability } },
  } as never);
  const authorization = 'Bearer ' + await issueAccessToken({ userId: actor, organizationId: org, role: 'OWNER' }, secret);
  try {
    const result = await app.inject({ method: 'GET', url: '/v1/guided-setups/availability', headers: { authorization } });
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    const response = await app.inject({ method: 'POST', url: '/v1/guided-setups', headers: { authorization, 'idempotency-key': 'setup-start-once' }, payload: { name: 'Setup', transport: 'QR' } });
    expect(response.statusCode).toBe(201); expect(start).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, { name: 'Setup', transport: 'QR' }, 'setup-start-once');
    const foreign = await app.inject({ method: 'POST', url: '/v1/guided-setups', headers: { authorization, 'idempotency-key': 'foreign-setup-1' }, payload: { name: 'Setup', transport: 'QR', organizationId: org } });
    expect(foreign.statusCode).toBe(400); expect(start).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it('exposes controlled check, test, proof and activation actions with strict inputs', async () => {
  const check = vi.fn(async () => ({})), beginTest = vi.fn(async () => ({})), collectProof = vi.fn(async () => ({})),
    activate = vi.fn(async () => ({})), reconcile = vi.fn(async () => ({}));
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }),
    guidedSetup: { jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'OWNER', service: { check, beginTest, collectProof, activate, reconcile } },
  } as never);
  const authorization = 'Bearer ' + await issueAccessToken({ userId: actor, organizationId: org, role: 'OWNER' }, secret);
  try {
    for (const [action, payload] of [
      ['check', { revision: 1 }], ['test', { revision: 1, expectedOwnerRevision: 0, keyword: 'teste-exclusivo', replaceExisting: false }],
      ['proof', { revision: 1 }], ['activate', { revision: 1, expectedOwnerRevision: 1 }], ['reconcile', { revision: 1 }],
    ] as const) {
      const result = await app.inject({ method: 'POST', url: `/v1/guided-setups/${org}/${action}`, headers: { authorization, 'idempotency-key': 'controlled-action-1' }, payload });
      expect(result.statusCode, action).toBe(200);
    }
    const fake = await app.inject({ method: 'POST', url: `/v1/guided-setups/${org}/proof`, headers: { authorization }, payload: { revision: 1, passed: true } });
    expect(fake.statusCode).toBe(400); expect(collectProof).toHaveBeenCalledTimes(1);
    expect(beginTest).toHaveBeenCalledWith({ organizationId: org, actorId: actor }, org,
      { revision: 1, expectedOwnerRevision: 0, keyword: 'teste-exclusivo', replaceExisting: false }, 'controlled-action-1');
  } finally { await app.close(); }
});
