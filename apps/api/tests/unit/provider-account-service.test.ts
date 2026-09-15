import { describe, expect, it } from 'vitest';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import {
  createProviderAccountService,
  ProviderAccountServiceError,
} from '../../src/modules/provider-accounts/service.js';

const ORGANIZATION_A = 'c9fd2146-457a-4b6c-8359-c8f96fb0f077';
const ORGANIZATION_B = 'b0a5d1af-72cf-483d-b769-cf3b820dad55';
const FIRST_ID = 'ac282057-7f9c-4a91-93c9-82e4cedfa157';
const SECOND_ID = '519b77a6-a4e5-409a-85c8-d78fc155c525';

function harness() {
  const calls: unknown[][] = [];
  const rows = [
    {
      id: FIRST_ID,
      organizationId: ORGANIZATION_A,
      name: 'Principal',
      provider: 'BAILEYS' as const,
      createdAt: new Date('2030-01-02T00:00:00.000Z'),
    },
    {
      id: SECOND_ID,
      organizationId: ORGANIZATION_A,
      name: 'Meta futura',
      provider: 'META' as const,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    },
  ];
  const service = createProviderAccountService({
    repository: {
      async list(_transaction, organizationId, provider, limit, cursor) {
        calls.push([organizationId, provider, limit, cursor]);
        return rows.filter((row) => (
          row.organizationId === organizationId && (provider === null || row.provider === provider)
        )).slice(0, limit);
      },
    },
    runInOrganizationTransaction: async (_organizationId, operation) => operation({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as TenantTransaction),
  });
  return { calls, service };
}

describe('serviço de descoberta de provider accounts', () => {
  it('retorna somente metadados públicos e paginação vinculada ao tenant/filtro', async () => {
    const test = harness();
    const first = await test.service.listProviderAccounts(ORGANIZATION_A, { limit: 1 });

    expect(first.data).toEqual([{
      id: FIRST_ID,
      name: 'Principal',
      provider: 'BAILEYS',
      createdAt: '2030-01-02T00:00:00.000Z',
    }]);
    expect(first.pageInfo).toMatchObject({ hasNextPage: true });
    expect(JSON.stringify(first)).not.toMatch(/organizationId|credential|external|secret/i);

    await test.service.listProviderAccounts(ORGANIZATION_A, {
      limit: 1,
      cursor: first.pageInfo.nextCursor!,
    });
    expect(test.calls[1]?.[3]).toMatchObject({
      organizationId: ORGANIZATION_A,
      provider: null,
      id: FIRST_ID,
    });
  });

  it('aplica provider e rejeita reutilização do cursor com filtro divergente', async () => {
    const test = harness();
    const page = await test.service.listProviderAccounts(ORGANIZATION_A, {
      limit: 1,
      provider: 'BAILEYS',
    });

    await expect(test.service.listProviderAccounts(ORGANIZATION_A, {
      limit: 1,
      provider: 'META',
      cursor: page.pageInfo.nextCursor ?? Buffer.from(JSON.stringify({
        organizationId: ORGANIZATION_A,
        provider: 'BAILEYS',
        createdAt: '2030-01-02T00:00:00.000Z',
        id: FIRST_ID,
      })).toString('base64url'),
    })).rejects.toEqual(new ProviderAccountServiceError('INVALID_CURSOR', 400));
  });

  it('retorna 404 opaco para cursor de outro tenant e 400 para cursor malformado', async () => {
    const test = harness();
    const page = await test.service.listProviderAccounts(ORGANIZATION_A, { limit: 1 });

    await expect(test.service.listProviderAccounts(ORGANIZATION_B, {
      limit: 1,
      cursor: page.pageInfo.nextCursor!,
    })).rejects.toMatchObject({ code: 'CURSOR_NOT_FOUND', status: 404 });
    await expect(test.service.listProviderAccounts(ORGANIZATION_A, {
      limit: 1,
      cursor: 'not-json',
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
  });
});
