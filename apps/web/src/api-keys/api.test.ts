import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client.js';
import { issueApiKey, listApiKeys, revokeApiKey } from './api.js';

const ID = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const now = '2030-01-01T12:00:00.000Z';
const key = {
  id: ID, name: 'Automação', prefix: 'prefix123', scopes: ['instances:read'],
  expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: now,
};
const issuedKey = {
  id: ID, name: 'Automação', prefix: 'prefix123', scopes: ['instances:read'],
  expiresAt: null, createdAt: now,
  secret: 'jrc_prefix123_abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
};

function client(responses: unknown[]) {
  const request = vi.fn(async () => responses.shift());
  return { value: { request } as unknown as ApiClient, request };
}

describe('API de chaves', () => {
  it('lista com cursor opaco, emite e revoga somente pela API JRC', async () => {
    const fake = client([
      { data: [key], pageInfo: { hasNextPage: false, nextCursor: null } },
      issuedKey,
      undefined,
    ]);
    await listApiKeys(fake.value, 'opaque+/=');
    await issueApiKey(fake.value, { name: 'Automação', scopes: ['instances:read'], expiresAt: null });
    await revokeApiKey(fake.value, ID);
    expect(fake.request.mock.calls).toEqual([
      ['/v1/api-keys?limit=20&cursor=opaque%2B%2F%3D'],
      ['/v1/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Automação', scopes: ['instances:read'], expiresAt: null }) }],
      [`/v1/api-keys/${ID}`, { method: 'DELETE' }],
    ]);
  });

  it('rejeita segredo ou listagem fora do contrato', async () => {
    const malformedList = client([{ data: [{ ...key, secret: 'leak' }], pageInfo: { hasNextPage: false, nextCursor: null } }]);
    await expect(listApiKeys(malformedList.value)).rejects.toMatchObject({ status: 502 });
    const malformedIssue = client([{ ...key, secret: 'invalid' }]);
    await expect(issueApiKey(malformedIssue.value, { name: 'Automação', scopes: ['instances:read'], expiresAt: null }))
      .rejects.toMatchObject({ status: 502 });
  });
});
