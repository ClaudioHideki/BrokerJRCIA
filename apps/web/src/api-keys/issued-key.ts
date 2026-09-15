import type { ApiKey, IssuedApiKey } from '@jrc/contracts';

export function toApiKeyMetadata(issued: IssuedApiKey): ApiKey {
  return {
    id: issued.id,
    name: issued.name,
    prefix: issued.prefix,
    scopes: issued.scopes,
    expiresAt: issued.expiresAt,
    createdAt: issued.createdAt,
    revokedAt: null,
    lastUsedAt: null,
  };
}
