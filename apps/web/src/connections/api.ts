import {
  ConnectionResponseSchema,
  InstanceMutationResponseSchema,
  InstancePageSchema,
  InstanceSchema,
  ProviderAccountPageSchema,
  type ConnectionResponse,
  type Instance,
  type InstanceMutationResponse,
  type Page,
  type ProviderAccount,
} from '@jrc/contracts';

import { ApiClientError, type ApiClient } from '../api/client.js';

function parseContract<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiClientError('O serviço retornou uma resposta inválida.', 502);
  }
  return parsed.data;
}

export async function listConnections(client: ApiClient, cursor?: string): Promise<Page<Instance>> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return parseContract(InstancePageSchema, await client.request<unknown>(`/v1/instances?${query}`));
}

export async function listBaileysProviderAccounts(client: ApiClient): Promise<Page<ProviderAccount>> {
  const accounts = new Map<string, ProviderAccount>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ limit: '100', provider: 'BAILEYS' });
    if (cursor) query.set('cursor', cursor);
    const page = parseContract(
      ProviderAccountPageSchema,
      await client.request<unknown>(`/v1/provider-accounts?${query}`),
    );
    for (const account of page.data) accounts.set(account.id, account);
    if (!page.pageInfo.hasNextPage) {
      return {
        data: [...accounts.values()],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }
    const nextCursor = page.pageInfo.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new ApiClientError('O serviço retornou uma paginação inválida.', 502);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new ApiClientError('O serviço retornou páginas demais.', 502);
}

export async function createConnection(
  client: ApiClient,
  input: { name: string; providerAccountId: string },
  idempotencyKey: string,
): Promise<InstanceMutationResponse> {
  const response = await client.request<unknown>('/v1/instances', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      name: input.name,
      provider: 'BAILEYS',
      providerAccountId: input.providerAccountId,
    }),
  });
  return parseContract(InstanceMutationResponseSchema, response);
}

export async function getConnection(client: ApiClient, id: string): Promise<Instance> {
  return parseContract(InstanceSchema, await client.request<unknown>(`/v1/instances/${encodeURIComponent(id)}`));
}

export async function connectConnection(
  client: ApiClient,
  id: string,
  input: { pairingHint?: string },
  idempotencyKey: string,
): Promise<ConnectionResponse> {
  const response = await client.request<unknown>(`/v1/instances/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
  return parseContract(ConnectionResponseSchema, response);
}

export async function getConnectionStatus(
  client: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<Instance> {
  const path = `/v1/instances/${encodeURIComponent(id)}/status`;
  return parseContract(
    InstanceSchema,
    await client.request<unknown>(path, signal ? { signal } : undefined),
  );
}

export async function disconnectConnection(
  client: ApiClient,
  id: string,
  idempotencyKey: string,
): Promise<InstanceMutationResponse> {
  const response = await client.request<unknown>(`/v1/instances/${encodeURIComponent(id)}/disconnect`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: '{}',
  });
  return parseContract(InstanceMutationResponseSchema, response);
}
