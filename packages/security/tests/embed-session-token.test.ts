import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueEmbedSessionToken, verifyEmbedSessionToken } from '../src/index.js';

const secret = 'synthetic-embed-session-secret-with-at-least-32-bytes';
const now = new Date('2026-09-21T12:00:00.000Z');
const claims = {
  tenantId: '4f2491a2-6853-4ac2-a7ef-c997813a9182',
  destinationRevision: 7,
  accountId: 42,
  inboxIds: [12, 13],
  externalUserId: '81555d45-b1a2-4a3f-ab95-c1459b0df0d0',
  scopes: ['chatwoot:read', 'chatwoot:pair'] as const,
  nonce: randomUUID(),
};

describe('Chatwoot embed session token', () => {
  it('signs the tenant, destination, account, inboxes, user, scopes, audience, nonce and expiry', async () => {
    const token = await issueEmbedSessionToken(claims, secret, now);
    expect(token.split('.')).toHaveLength(3);
    await expect(verifyEmbedSessionToken(token, secret, new Date(now.getTime() + 60_000))).resolves.toMatchObject(claims);
  });

  it('rejects an expired token and a token signed by another key', async () => {
    const token = await issueEmbedSessionToken(claims, secret, now);
    await expect(verifyEmbedSessionToken(token, secret, new Date(now.getTime() + 301_000))).rejects.toThrow();
    await expect(verifyEmbedSessionToken(token, 'another-synthetic-secret-with-at-least-32-bytes', now)).rejects.toThrow();
  });

  it('rejects a token issued too far in the future', async () => {
    const token = await issueEmbedSessionToken(claims, secret, new Date(now.getTime() + 31_000));
    await expect(verifyEmbedSessionToken(token, secret, now)).rejects.toThrow('issued in the future');
  });

  it('rejects duplicate inboxes and administrative scopes', async () => {
    await expect(issueEmbedSessionToken({ ...claims, inboxIds: [12, 12] }, secret, now)).rejects.toThrow();
    await expect(issueEmbedSessionToken({ ...claims, scopes: ['chatwoot:disconnect'] as never }, secret, now)).rejects.toThrow();
  });
});
