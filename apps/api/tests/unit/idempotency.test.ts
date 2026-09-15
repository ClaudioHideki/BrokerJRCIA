import { describe, expect, it } from 'vitest';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import {
  IdempotencyConflictError,
  claimIdempotency,
  hashIdempotencyRequest,
} from '../../src/modules/instances/idempotency.js';

const ORGANIZATION_ID = 'c9fd2146-457a-4b6c-8359-c8f96fb0f077';

describe('idempotência de instâncias', () => {
  it('produz o mesmo fingerprint para objetos semanticamente iguais sem incluir o payload', () => {
    const first = hashIdempotencyRequest({ providerAccountId: 'account', name: 'Primary' });
    const second = hashIdempotencyRequest({ name: 'Primary', providerAccountId: 'account' });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('Primary');
  });

  it('retorna replay para a mesma chave e fingerprint', async () => {
    const stored = {
      id: 'a2961f50-6adb-4b6e-98be-a8c84acac2f5',
      organizationId: ORGANIZATION_ID,
      route: '/v1/instances',
      idempotencyKey: 'create-primary',
      requestHash: hashIdempotencyRequest({ name: 'Primary' }),
      operationId: 'a92b0b8d-dadb-4bd9-a273-89ed914ffabb',
      status: 'IN_PROGRESS' as const,
      responseMetadata: { instanceId: '519b77a6-a4e5-409a-85c8-d78fc155c525' },
      expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    };
    const transaction = {
      async query(text: string) {
        if (text.includes('INSERT INTO idempotency_records')) return { rows: [], rowCount: 0 };
        return { rows: [stored], rowCount: 1 };
      },
    } as unknown as TenantTransaction;

    await expect(claimIdempotency(transaction, {
      organizationId: ORGANIZATION_ID,
      route: '/v1/instances',
      key: 'create-primary',
      requestHash: stored.requestHash,
      expiresAt: stored.expiresAt,
    })).resolves.toEqual({ kind: 'REPLAY', record: stored });
  });

  it('rejeita a mesma chave usada com fingerprint diferente', async () => {
    const transaction = {
      async query(text: string) {
        if (text.includes('INSERT INTO idempotency_records')) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            id: 'a2961f50-6adb-4b6e-98be-a8c84acac2f5',
            organizationId: ORGANIZATION_ID,
            route: '/v1/instances',
            idempotencyKey: 'create-primary',
            requestHash: '0'.repeat(64),
            operationId: null,
            status: 'IN_PROGRESS',
            responseMetadata: {},
            expiresAt: new Date('2030-01-02T00:00:00.000Z'),
          }],
          rowCount: 1,
        };
      },
    } as unknown as TenantTransaction;

    await expect(claimIdempotency(transaction, {
      organizationId: ORGANIZATION_ID,
      route: '/v1/instances',
      key: 'create-primary',
      requestHash: hashIdempotencyRequest({ name: 'changed' }),
      expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
