import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { runMigrations } from '../../src/db/migrate.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TOKEN_HASH = 'a'.repeat(64);
const REFRESH_HASH = 'b'.repeat(64);

function connectionStringForAuthRole(connectionString: string): string {
  const url = new URL(connectionString);
  url.username = 'jrc_auth';
  url.password = '';
  return url.toString();
}

describe('jrc_auth e seleção de organização com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;
  let authPool: Pool;
  let repository: ReturnType<typeof createPostgresAuthRepository>;
  let userId: string;
  let organizationId: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    authPool = new Pool({ connectionString: connectionStringForAuthRole(database.connectionString), max: 2 });
    repository = createPostgresAuthRepository(authPool);

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const organization = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Auth Tenant', 'auth-tenant') RETURNING id",
      );
      const user = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('owner@example.test', 'known-hash') RETURNING id",
      );
      await client.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
        [organization.id, user.id],
      );
      const secondOwner = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('second-owner@example.test', 'known-hash') RETURNING id",
      );
      await client.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
        [organization.id, secondOwner.id],
      );
      await client.query('COMMIT');
      organizationId = organization.id;
      userId = user.id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await authPool?.end();
    await database?.dispose();
  });

  it('consulta somente organizações ativas permitidas usando jrc_auth', async () => {
    const identity = await repository.findLoginIdentity('owner@example.test');

    expect(identity).toEqual({
      id: userId,
      passwordHash: 'known-hash',
      status: 'ACTIVE',
      organizations: [{
        id: organizationId,
        name: 'Auth Tenant',
        slug: 'auth-tenant',
        role: 'OWNER',
      }],
    });
    await expect(authPool.query('SELECT * FROM instances')).rejects.toThrow(/permission denied/i);
    await expect(authPool.query('SELECT * FROM audit_logs')).rejects.toThrow(/permission denied/i);
  });

  it('rejeita sessão administrativa que tenta assumir jrc_auth com SET ROLE', async () => {
    const adminPool = new Pool({ connectionString: database.connectionString, max: 1 });
    try {
      await adminPool.query('SET ROLE jrc_auth');
      const masqueradingRepository = createPostgresAuthRepository(adminPool);

      await expect(masqueradingRepository.findLoginIdentity('owner@example.test'))
        .rejects.toThrow('Authentication repository requires a direct jrc_auth session');
    } finally {
      await adminPool.query('RESET ROLE');
      await adminPool.end();
    }
  });

  it('mantém os grants de jrc_auth estritamente limitados sem UPDATE em memberships', async () => {
    const expected = new Map<string, readonly string[]>([
      ['organizations', ['SELECT']],
      ['users', ['SELECT']],
      ['memberships', ['SELECT']],
      ['login_sessions', ['INSERT']],
      ['refresh_tokens', ['SELECT', 'INSERT', 'UPDATE']],
      ['security_audit_logs', ['INSERT']],
    ]);
    const runtimeTables = [
      'api_keys',
      'audit_logs',
      'connection_challenges',
      'idempotency_records',
      'instances',
      'login_sessions',
      'memberships',
      'organizations',
      'provider_accounts',
      'provider_operations',
      'refresh_tokens',
      'security_audit_logs',
      'users',
    ];
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

    for (const table of runtimeTables) {
      for (const privilege of privileges) {
        const result = await oneRow<{ allowed: boolean }>(
          database.pool,
          'SELECT has_table_privilege($1, $2, $3) AS allowed',
          ['jrc_auth', table, privilege],
        );
        expect(result.allowed, `${privilege} on ${table}`).toBe(
          expected.get(table)?.includes(privilege) ?? false,
        );
      }
    }

    await expect(authPool.query('DELETE FROM refresh_tokens')).rejects.toThrow(/permission denied/i);

    const functions = await database.pool.query<{
      grantee: string;
      privilegeType: string;
      routineName: string;
    }>(
      `SELECT grantee, privilege_type AS "privilegeType", routine_name AS "routineName"
         FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN ('consume_login_selection', 'switch_refresh_organization')
        ORDER BY routine_name, grantee, privilege_type`,
    );
    expect(functions.rows).toEqual([
      {
        grantee: 'jrc_auth',
        privilegeType: 'EXECUTE',
        routineName: 'consume_login_selection',
      },
      {
        grantee: 'jrc_migrator',
        privilegeType: 'EXECUTE',
        routineName: 'consume_login_selection',
      },
      {
        grantee: 'jrc_auth',
        privilegeType: 'EXECUTE',
        routineName: 'switch_refresh_organization',
      },
      {
        grantee: 'jrc_migrator',
        privilegeType: 'EXECUTE',
        routineName: 'switch_refresh_organization',
      },
    ]);

    const switchFunction = await oneRow<{
      owner: string;
      securityDefiner: boolean;
      fixedSearchPath: boolean;
      publicCanExecute: boolean;
      authCanExecute: boolean;
    }>(
      database.pool,
      `SELECT owner.rolname AS owner,
              procedure.prosecdef AS "securityDefiner",
              procedure.proconfig @> ARRAY['search_path=pg_catalog, public'] AS "fixedSearchPath",
              EXISTS (
                SELECT 1
                  FROM aclexplode(
                    COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
                  ) AS privilege
                 WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
              ) AS "publicCanExecute",
              has_function_privilege(
                'jrc_auth', procedure.oid, 'EXECUTE'
              ) AS "authCanExecute"
         FROM pg_proc procedure
         JOIN pg_roles owner ON owner.oid = procedure.proowner
        WHERE procedure.oid =
          'switch_refresh_organization(text,uuid,uuid,uuid,timestamptz,uuid,uuid,text,timestamptz)'::regprocedure`,
    );
    expect(switchFunction).toEqual({
      owner: 'jrc_migrator',
      securityDefiner: true,
      fixedSearchPath: true,
      publicCanExecute: false,
      authCanExecute: true,
    });
  });

  it('permite somente um consumo concorrente e persiste refresh somente como hash', async () => {
    await repository.createSelectionSession({
      userId,
      tokenHash: TOKEN_HASH,
      expiresAt: new Date('2030-01-01T12:05:00.000Z'),
    });

    const results = await Promise.all([
      repository.consumeSelection({
        selectionTokenHash: TOKEN_HASH,
        organizationId,
        now: NOW,
        refreshTokenId: '739e310a-8609-45b5-a5e6-a91ec98eb784',
        refreshFamilyId: '1a87172d-bc5c-42aa-b09a-e2b6998607cc',
        refreshTokenHash: REFRESH_HASH,
        refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      }),
      repository.consumeSelection({
        selectionTokenHash: TOKEN_HASH,
        organizationId,
        now: NOW,
        refreshTokenId: 'e8c55298-b50b-4d87-884e-cf9dd31def67',
        refreshFamilyId: 'fa3142d4-0878-4e9d-b13c-c0f671ef85d6',
        refreshTokenHash: 'c'.repeat(64),
        refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      }),
    ]);

    expect(results.filter((result) => result.outcome === 'SELECTED')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'REUSED')).toHaveLength(1);
    const persisted = await oneRow<{ tokenHash: string; count: number }>(
      database.pool,
      'SELECT min(token_hash) AS "tokenHash", count(*)::int AS count FROM refresh_tokens',
    );
    expect(persisted.count).toBe(1);
    expect([REFRESH_HASH, 'c'.repeat(64)]).toContain(persisted.tokenHash);
  });

  it('consome o token também quando a organização não pertence ao usuário', async () => {
    const tokenHash = 'd'.repeat(64);
    await repository.createSelectionSession({
      userId,
      tokenHash,
      expiresAt: new Date('2030-01-01T12:05:00.000Z'),
    });

    await expect(repository.consumeSelection({
      selectionTokenHash: tokenHash,
      organizationId: 'e2842f9a-0c03-4c34-a2a0-86f49acdb129',
      now: NOW,
      refreshTokenId: 'bfa30fb0-449f-43e7-95b2-d466ef576370',
      refreshFamilyId: 'c7ef082e-5c80-45fc-a1f0-3b0efad6241d',
      refreshTokenHash: 'e'.repeat(64),
      refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
    })).resolves.toEqual({ outcome: 'INVALID' });

    await expect(repository.consumeSelection({
      selectionTokenHash: tokenHash,
      organizationId,
      now: NOW,
      refreshTokenId: '630e7960-7667-433a-891e-19f584b08bf5',
      refreshFamilyId: '954a2efe-2205-40c5-a6be-70f845d480b1',
      refreshTokenHash: 'f'.repeat(64),
      refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
    })).resolves.toEqual({ outcome: 'REUSED' });
  });

  it.each([
    ['desativação', "status = 'DISABLED'", null],
    ['rebaixamento', "role = 'ADMIN'", 'ADMIN'],
  ] as const)('serializa seleção concorrente com %s da membership e revalida depois do lock', async (_label, mutation, expectedRole) => {
    const suffix = mutation.includes('DISABLED') ? '1' : '2';
    const tokenHash = suffix.repeat(64);
    await database.pool.query(
      "UPDATE memberships SET role = 'OWNER', status = 'ACTIVE' WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    await repository.createSelectionSession({
      userId,
      tokenHash,
      expiresAt: new Date('2030-01-01T12:05:00.000Z'),
    });

    const mutator = await database.pool.connect();
    try {
      await mutator.query('BEGIN');
      await mutator.query(
        `UPDATE memberships SET ${mutation} WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, userId],
      );
      const selection = repository.consumeSelection({
        selectionTokenHash: tokenHash,
        organizationId,
        now: NOW,
        refreshTokenId: suffix === '1'
          ? '040fda3a-6948-4661-9fc8-6092e12f87b8'
          : '3a3db26a-c095-4b3d-a178-08d1f1a5093a',
        refreshFamilyId: suffix === '1'
          ? 'feaf281a-c285-45de-bd36-609ae40604f4'
          : 'f28d8c9d-f851-42f3-8a49-137420329745',
        refreshTokenHash: suffix.repeat(64),
        refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      });
      const beforeCommit = await Promise.race([
        selection.then(() => 'resolved'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 30)),
      ]);
      expect(beforeCommit).toBe('blocked');
      await mutator.query('COMMIT');
      const selected = await selection;
      if (expectedRole === null) {
        expect(selected).toEqual({ outcome: 'INVALID' });
      } else {
        expect(selected).toEqual({
          outcome: 'SELECTED',
          userId,
          organizationId,
          role: expectedRole,
        });
      }
      const persistedRefresh = await oneRow<{ count: number }>(
        database.pool,
        'SELECT count(*)::int AS count FROM refresh_tokens WHERE token_hash = $1',
        [suffix.repeat(64)],
      );
      expect(persistedRefresh.count).toBe(expectedRole === null ? 0 : 1);
    } catch (error) {
      await mutator.query('ROLLBACK');
      throw error;
    } finally {
      mutator.release();
    }
  });
});
