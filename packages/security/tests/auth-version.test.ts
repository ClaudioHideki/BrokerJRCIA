import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { issueAccessToken, verifyAccessToken } from '../src/index.js';

const secret = 'synthetic-jwt-secret-with-at-least-32-bytes';
const now = new Date('2030-01-01T12:00:00Z');
const identity = { userId: 'user', organizationId: 'organization', role: 'OWNER' as const };

describe('access-token authentication generation', () => {
  it('binds the issued token to the authenticated generation', async () => {
    const token = await issueAccessToken({ ...identity, authVersion: 7 }, secret, now);
    await expect(verifyAccessToken(token, secret, now)).resolves.toMatchObject({ auth_version: 7 });
  });

  it.each([-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])('rejects malformed generation %s', async (authVersion) => {
    const token = await new SignJWT({ organization_id: 'organization', role: 'OWNER', auth_version: authVersion })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('jrc-whatsapp-broker').setAudience('jrc-api')
      .setSubject('user').setJti('synthetic-id').setIssuedAt(1893499200).setExpirationTime(1893499800)
      .sign(Buffer.from(secret));
    await expect(verifyAccessToken(token, secret, now)).rejects.toThrow();
  });

  it('maps existing pre-migration tokens to generation zero only', async () => {
    const token = await new SignJWT({ organization_id: 'organization', role: 'OWNER' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('jrc-whatsapp-broker').setAudience('jrc-api')
      .setSubject('user').setJti('synthetic-id').setIssuedAt(1893499200).setExpirationTime(1893499800)
      .sign(Buffer.from(secret));
    await expect(verifyAccessToken(token, secret, now)).resolves.toMatchObject({ auth_version: 0 });
  });
});
