import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';

describe('PostgresAuthRepository role boundary', () => {
  it('rejeita SET ROLE jrc_auth originado por uma sessão administrativa', async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('current_user')) {
          return { rows: [{ currentUser: 'jrc_auth', sessionUser: 'postgres' }] };
        }
        throw new Error('domain query must not run');
      },
      release() {
        released = true;
      },
    } as unknown as PoolClient;
    const pool = {
      async connect() {
        return client;
      },
    } as unknown as Pool;

    const repository = createPostgresAuthRepository(pool);

    await expect(repository.findLoginIdentity('owner@example.test'))
      .rejects.toThrow('Authentication repository requires a direct jrc_auth session');
    expect(queries).toHaveLength(1);
    expect(released).toBe(true);
  });

  it('qualifica a função SECURITY DEFINER usada na troca de tenant', async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('current_user')) {
          return { rows: [{ currentUser: 'jrc_auth', sessionUser: 'jrc_auth' }] };
        }
        return { rows: [{ outcome: 'INVALID', userId: null, organizationId: null, role: null }] };
      },
      release() {},
    } as unknown as PoolClient;
    const pool = { async connect() { return client; } } as unknown as Pool;

    await createPostgresAuthRepository(pool).switchOrganization({
      currentTokenHash: 'hash',
      expectedUserId: '8e757fb4-18ff-4c20-841b-19f282ece546',
      expectedOrganizationId: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
      targetOrganizationId: '2db58223-99c7-4f16-8b59-0fe73aa395a8',
      nextTokenId: '3156b2ad-ed4a-4e64-a0f1-4606bdeee85e',
      nextFamilyId: '70e01fe6-1664-4660-b6bc-2df0c514df9a',
      nextTokenHash: 'next-hash',
      nextExpiresAt: new Date('2030-02-01T12:00:00.000Z'),
      now: new Date('2030-01-01T12:00:00.000Z'),
    });

    expect(queries[1]).toContain('FROM public.switch_refresh_organization(');
  });
});
