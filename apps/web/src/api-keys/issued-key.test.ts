import { describe, expect, it } from 'vitest';

import { toApiKeyMetadata } from './issued-key.js';

describe('toApiKeyMetadata', () => {
  it('remove o segredo da representação persistida na lista', () => {
    const metadata = toApiKeyMetadata({
      id: '81555d45-b1a2-4a3f-ab95-c1459b0df0d0',
      name: 'Integração',
      prefix: 'prefix123',
      secret: 'jrc_prefix123_super-secret',
      scopes: ['instances:read'],
      expiresAt: null,
      createdAt: '2030-01-01T12:00:00.000Z',
    });

    expect(metadata).toEqual({
      id: '81555d45-b1a2-4a3f-ab95-c1459b0df0d0',
      name: 'Integração',
      prefix: 'prefix123',
      scopes: ['instances:read'],
      expiresAt: null,
      createdAt: '2030-01-01T12:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(metadata).not.toHaveProperty('secret');
  });
});
