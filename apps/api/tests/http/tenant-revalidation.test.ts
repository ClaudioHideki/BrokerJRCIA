import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { issueAccessToken } from '@jrc/security';
import { authenticateRequest } from '../../src/http/plugins/authentication.js';
// Runtime revocation must apply to every tenant route using the shared guard.
it('denies a signed token after membership removal and applies current downgraded role', async () => {
  const app = Fastify(); let role: 'VIEWER' | null = null;
  app.decorate('resolveTenantRole', async () => role);
  app.decorateRequest('authentication', null);
  app.get('/', { preHandler: authenticateRequest({jwtSecret:'t'.repeat(48),authenticateApiKey:async()=>null}) }, req => req.authentication);
  const token = await issueAccessToken({ userId:'00000000-0000-4000-8000-000000000001',organizationId:'00000000-0000-4000-8000-000000000002',role:'OWNER' }, 't'.repeat(48));
  const headers = {authorization:`Bearer ${token}`};
  expect((await app.inject({url:'/',headers})).statusCode).toBe(401);
  role='VIEWER'; const response=await app.inject({url:'/',headers}); expect(response.statusCode).toBe(200); expect(response.json().role).toBe('VIEWER');
  await app.close();
});
