import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client.js';
import {
  connectConnection,
  createConnection,
  disconnectConnection,
  getConnection,
  getConnectionStatus,
  listBaileysProviderAccounts,
  listConnections,
} from './api.js';

const ORG = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const ACCOUNT = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const ACCOUNT_2 = '4f090d55-d6fb-4ef2-bec4-2d9b81e3978c';
const INSTANCE = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const OPERATION = '9271726c-8869-49ad-b0e0-57a4e0939ef7';
const now = '2030-01-01T12:00:00.000Z';
const instance = {
  id: INSTANCE, organizationId: ORG, providerAccountId: ACCOUNT,
  name: 'Atendimento', provider: 'BAILEYS' as const, status: 'CREATED' as const,
  createdAt: now, updatedAt: now,
};

function fakeClient(responses: unknown[]): { client: ApiClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => responses.shift());
  return {
    request,
    client: {
      login: vi.fn(), selectOrganization: vi.fn(), restore: vi.fn(), switchOrganization: vi.fn(), logout: vi.fn(),
      request,
      registerTenantPurge: vi.fn(() => () => undefined),
      subscribeToSessionExpiration: vi.fn(() => () => undefined),
    } as unknown as ApiClient,
  };
}

describe('API de conexões', () => {
  it('usa somente rotas públicas JRC e paginação opaca', async () => {
    const { client, request } = fakeClient([
      { data: [instance], pageInfo: { hasNextPage: true, nextCursor: 'opaque+/=' } },
      { data: [{ id: ACCOUNT, name: 'Baileys JRC', provider: 'BAILEYS', createdAt: now }], pageInfo: { hasNextPage: false, nextCursor: null } },
    ]);
    await listConnections(client, 'opaque+/=');
    await listBaileysProviderAccounts(client);
    expect(request).toHaveBeenNthCalledWith(1, '/v1/instances?limit=20&cursor=opaque%2B%2F%3D');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/provider-accounts?limit=100&provider=BAILEYS');
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/evolution|organization_id/i);
  });

  it('envia métodos, corpos e Idempotency-Key exatos', async () => {
    const mutation = { instance, operationId: OPERATION, replayed: false, pending: false, reconciliationRequired: false };
    const { client, request } = fakeClient([
      mutation,
      { ...mutation, action: { type: 'NONE', reason: 'NO_USER_ACTION_REQUIRED' } },
      instance,
      instance,
      mutation,
    ]);
    await createConnection(client, { name: 'Atendimento', providerAccountId: ACCOUNT }, 'create-key');
    await connectConnection(client, INSTANCE, {}, 'connect-key');
    await getConnection(client, INSTANCE);
    await getConnectionStatus(client, INSTANCE);
    await disconnectConnection(client, INSTANCE, 'disconnect-key');
    expect(request.mock.calls).toEqual([
      ['/v1/instances', { method: 'POST', headers: { 'Idempotency-Key': 'create-key' }, body: JSON.stringify({ name: 'Atendimento', provider: 'BAILEYS', providerAccountId: ACCOUNT }) }],
      [`/v1/instances/${INSTANCE}/connect`, { method: 'POST', headers: { 'Idempotency-Key': 'connect-key' }, body: '{}' }],
      [`/v1/instances/${INSTANCE}`],
      [`/v1/instances/${INSTANCE}/status`, undefined],
      [`/v1/instances/${INSTANCE}/disconnect`, { method: 'POST', headers: { 'Idempotency-Key': 'disconnect-key' }, body: '{}' }],
    ]);
  });

  it('percorre todas as páginas de provider accounts sem duplicar contas', async () => {
    const { client, request } = fakeClient([
      {
        data: [{ id: ACCOUNT, name: 'Baileys JRC', provider: 'BAILEYS', createdAt: now }],
        pageInfo: { hasNextPage: true, nextCursor: 'next+/=' },
      },
      {
        data: [
          { id: ACCOUNT, name: 'Baileys JRC', provider: 'BAILEYS', createdAt: now },
          { id: ACCOUNT_2, name: 'Baileys filial', provider: 'BAILEYS', createdAt: now },
        ],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    ]);

    const page = await listBaileysProviderAccounts(client);

    expect(page.data.map((account) => account.id)).toEqual([ACCOUNT, ACCOUNT_2]);
    expect(page.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
    expect(request.mock.calls).toEqual([
      ['/v1/provider-accounts?limit=100&provider=BAILEYS'],
      ['/v1/provider-accounts?limit=100&provider=BAILEYS&cursor=next%2B%2F%3D'],
    ]);
  });

  it('recusa cursor repetido em provider accounts em vez de repetir indefinidamente', async () => {
    const repeated = {
      data: [{ id: ACCOUNT, name: 'Baileys JRC', provider: 'BAILEYS', createdAt: now }],
      pageInfo: { hasNextPage: true, nextCursor: 'same' },
    };
    const { client, request } = fakeClient([repeated, repeated]);

    await expect(listBaileysProviderAccounts(client)).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejeita resposta fora do contrato com erro seguro', async () => {
    const { client } = fakeClient([{ data: [{ upstreamInstanceKey: 'segredo' }], pageInfo: {} }]);
    await expect(listConnections(client)).rejects.toMatchObject({ status: 502 });
  });
});
