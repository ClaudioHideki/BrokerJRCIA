import {
  ApiKeyPageSchema,
  IssuedApiKeySchema,
  type ApiKey,
  type IssueApiKeyRequest,
  type IssuedApiKey,
  type Page,
} from '@jrc/contracts';

import { ApiClientError, type ApiClient } from '../api/client.js';

function invalidResponse(): never {
  throw new ApiClientError('O serviço retornou uma resposta inválida.', 502);
}

export async function listApiKeys(client: ApiClient, cursor?: string): Promise<Page<ApiKey>> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const parsed = ApiKeyPageSchema.safeParse(await client.request<unknown>(`/v1/api-keys?${query}`));
  return parsed.success ? parsed.data : invalidResponse();
}

export async function issueApiKey(client: ApiClient, input: IssueApiKeyRequest): Promise<IssuedApiKey> {
  const parsed = IssuedApiKeySchema.safeParse(await client.request<unknown>('/v1/api-keys', {
    method: 'POST',
    body: JSON.stringify(input),
  }));
  return parsed.success ? parsed.data : invalidResponse();
}

export async function revokeApiKey(client: ApiClient, id: string): Promise<void> {
  await client.request<void>(`/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
