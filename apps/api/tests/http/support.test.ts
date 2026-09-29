import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import type { SupportService } from '../../src/modules/support/service.js';

it('takes the organization from authenticated membership and denies a downgraded reader write', async () => {
  const secret = 'support-route-secret-with-at-least-32-bytes', org = randomUUID(), user = randomUUID();
  const list = vi.fn(async () => ({ data: [] })), create = vi.fn();
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ verifyPasswordOrDummy: async () => false }), support: {
    jwtSecret: secret, authenticateApiKey: async () => null, resolveCurrentRole: async () => 'VIEWER' as const,
    service: { list, create } as unknown as SupportService,
  } });
  try {
    const authorization = `Bearer ${await issueAccessToken({ userId: user, organizationId: org, role: 'ADMIN' }, secret)}`;
    const listResponse = await app.inject({ url: '/v1/support/tickets', headers: { authorization } });
    expect(listResponse.statusCode).toBe(200); expect(list).toHaveBeenCalledWith({kind:'TENANT',actorId:user,organizationId:org,canWrite:false},undefined);
    const denied = await app.inject({ method:'POST', url:'/v1/support/tickets', headers:{authorization}, payload:{title:'Canal sem conexão',message:'Preciso de suporte.',requestId:randomUUID()} });
    expect(denied.statusCode).toBe(403); expect(create).not.toHaveBeenCalled();
    expect((await app.inject('/v1/support/tickets')).statusCode).toBe(401);
    expect((await app.inject({url:`/v1/support/tickets?organizationId=${randomUUID()}`,headers:{authorization}})).statusCode).toBe(400);
  } finally { await app.close(); }
});
