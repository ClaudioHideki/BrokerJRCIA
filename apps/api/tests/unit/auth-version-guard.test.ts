import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { authenticateRequest } from '../../src/http/plugins/authentication.js';

const secret = 'synthetic-jwt-secret-with-at-least-32-bytes';
describe('authentication generation guard', () => {
  it('rejects old JWTs after a reset, accepts the new generation and fails closed on lookup error', async () => {
    const app = Fastify();
    let version = 0;
    app.decorate('isUserAuthenticationCurrent', async (_user: string, received: number) => {
      if (version === -1) throw new Error('database unavailable');
      return received === version;
    });
    app.get('/protected', { preHandler: authenticateRequest({ jwtSecret: secret, authenticateApiKey: async () => null }) }, async () => ({ ok: true }));
    const token = await issueAccessToken({ userId: 'user', organizationId: 'organization', role: 'OWNER', authVersion: 0 }, secret);
    const get = (bearer: string) => app.inject({ url: '/protected', headers: { authorization: `Bearer ${bearer}` } });
    try {
      expect((await get(token)).statusCode).toBe(200);
      version = 1;
      expect((await get(token)).statusCode).toBe(401);
      const next = await issueAccessToken({ userId: 'user', organizationId: 'organization', role: 'OWNER', authVersion: 1 }, secret);
      expect((await get(next)).statusCode).toBe(200);
      version = -1;
      expect((await get(next)).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
