import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  createIsolatedPostgresDatabase,
  queryAsTenant,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('legacy flow migration schema', () => {
  let database: IsolatedPostgresDatabase;
  const organizationA = randomUUID();
  const organizationB = randomUUID();

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => {
      await runMigrations(database.connectionString);
      await runMigrations(database.connectionString);
    });
    const seed = await database.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(
        `insert into organizations(id,name,slug)
         values ($1,'Migration A',$3),($2,'Migration B',$4)`,
        [organizationA, organizationB, `migration-${organizationA}`, `migration-${organizationB}`],
      );
      const owner = await seed.query<{ id: string }>(
        `insert into users(email,password_hash)
         values ($1,'test-only-no-login') returning id`,
        [`migration-${organizationA}@example.test`],
      );
      await seed.query(
        `insert into memberships(organization_id,user_id,role)
         values ($1,$3,'OWNER'),($2,$3,'OWNER')`,
        [organizationA, organizationB, owner.rows[0]!.id],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it('rejects migration state that is not owned by an existing organization', async () => {
    await expect(database.pool.query(
      `insert into automation_legacy_migrations
         (organization_id,source,source_id,status)
       values ($1,'BROKER_FLOW_V1','orphan','LEGACY')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('isolates migration reports in both tenant directions', async () => {
    await database.pool.query(
      `insert into automation_legacy_migrations
         (organization_id,source,source_id,status,report)
       values ($1,'BROKER_FLOW_V1','flow-a','LEGACY','{"tenant":"a"}'),
              ($2,'BROKER_FLOW_V1','flow-b','LEGACY','{"tenant":"b"}')`,
      [organizationA, organizationB],
    );

    const rowsA = await queryAsTenant<{ source_id: string }>(
      database.pool,
      'jrc_app',
      organizationA,
      'select source_id from automation_legacy_migrations order by source_id',
    );
    const rowsB = await queryAsTenant<{ source_id: string }>(
      database.pool,
      'jrc_app',
      organizationB,
      'select source_id from automation_legacy_migrations order by source_id',
    );

    expect(rowsA.rows).toEqual([{ source_id: 'flow-a' }]);
    expect(rowsB.rows).toEqual([{ source_id: 'flow-b' }]);
  });

  it('grants the runtime only the operations required by migration', async () => {
    const privileges = await database.pool.query<{ privilege_type: string; table_name: string }>(
      `select privilege_type, table_name
         from information_schema.role_table_grants
        where grantee='jrc_app'
          and table_name in ('automation_legacy_migrations','automation_owner_transitions')
        order by table_name, privilege_type`,
    );

    expect(privileges.rows).toEqual([
      { privilege_type: 'INSERT', table_name: 'automation_legacy_migrations' },
      { privilege_type: 'SELECT', table_name: 'automation_legacy_migrations' },
      { privilege_type: 'UPDATE', table_name: 'automation_legacy_migrations' },
      { privilege_type: 'INSERT', table_name: 'automation_owner_transitions' },
      { privilege_type: 'SELECT', table_name: 'automation_owner_transitions' },
    ]);
  });

  it('requires complete and bounded owner transition audit fields', async () => {
    const columns = await database.pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema='public'
          and table_name='automation_owner_transitions'
          and column_name in ('from_origin','to_origin','reason_code')
        order by column_name`,
    );
    const checks = await database.pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid='automation_owner_transitions'::regclass
          and contype='c'`,
    );

    expect(columns.rows).toEqual([
      { column_name: 'from_origin', is_nullable: 'NO' },
      { column_name: 'reason_code', is_nullable: 'NO' },
      { column_name: 'to_origin', is_nullable: 'NO' },
    ]);
    const checkDefinitions = checks.rows.map(({ definition }) => definition).join('\n');
    expect(checkDefinitions).toMatch(/octet_length\(reason_code\).*>= 1/is);
    expect(checkDefinitions).toMatch(/octet_length\(reason_code\).*<= 128/is);
  });
});
