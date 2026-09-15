import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import { createDatabasePools, type DatabasePools } from '../../src/db/pools.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';

interface TenantFixture {
  organizationId: string;
  providerAccountId: string;
  instanceId: string;
  instanceName: string;
}

function connectionStringForRole(connectionString: string, role: 'jrc_app' | 'jrc_auth'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

async function seedTenant(
  client: PoolClient,
  slug: string,
): Promise<TenantFixture> {
  await client.query('BEGIN');
  try {
    const organization = await oneRow<{ id: string }>(
      client,
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      [`Tenant ${slug}`, slug],
    );
    const owner = await oneRow<{ id: string }>(
      client,
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [`${slug}@example.test`, 'argon2id-test-hash'],
    );
    await client.query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
      [organization.id, owner.id],
    );
    const providerAccount = await oneRow<{ id: string }>(
      client,
      `INSERT INTO provider_accounts (organization_id, provider, name)
       VALUES ($1, 'BAILEYS', $2) RETURNING id`,
      [organization.id, `provider-${slug}`],
    );
    const instanceName = `instance-${slug}`;
    const instance = await oneRow<{ id: string }>(
      client,
      `INSERT INTO instances
         (organization_id, provider_account_id, name, upstream_instance_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organization.id, providerAccount.id, instanceName, `upstream-${slug}`],
    );
    await client.query('COMMIT');
    return {
      organizationId: organization.id,
      providerAccountId: providerAccount.id,
      instanceId: instance.id,
      instanceName,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('RLS no runtime', () => {
  let database: IsolatedPostgresDatabase;
  let pools: DatabasePools;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    pools = createDatabasePools({
      app: { connectionString: connectionStringForRole(database.connectionString, 'jrc_app'), max: 2 },
      auth: { connectionString: connectionStringForRole(database.connectionString, 'jrc_auth'), max: 1 },
    });

    const client = await database.pool.connect();
    try {
      tenantA = await seedTenant(client, 'rls-a');
      tenantB = await seedTenant(client, 'rls-b');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pools.close();
    await database.dispose();
  });

  it('mantém pools separados autenticados como jrc_app e jrc_auth', async () => {
    const appIdentity = await oneRow<{ current_user: string; session_user: string }>(
      pools.appPool,
      'SELECT current_user, session_user',
    );
    const authIdentity = await oneRow<{ current_user: string; session_user: string }>(
      pools.authPool,
      'SELECT current_user, session_user',
    );

    expect(appIdentity).toEqual({ current_user: 'jrc_app', session_user: 'jrc_app' });
    expect(authIdentity).toEqual({ current_user: 'jrc_auth', session_user: 'jrc_auth' });
  });

  it('lista somente as instâncias da organização ativa', async () => {
    const instancesA = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query<{ id: string; name: string }>(
        'SELECT id, name FROM instances ORDER BY name',
      ).then(({ rows }) => rows),
    );
    const instancesB = await withOrganizationTransaction(
      pools.appPool,
      tenantB.organizationId,
      async (transaction) => transaction.query<{ id: string; name: string }>(
        'SELECT id, name FROM instances ORDER BY name',
      ).then(({ rows }) => rows),
    );

    expect(instancesA).toEqual([{ id: tenantA.instanceId, name: tenantA.instanceName }]);
    expect(instancesB).toEqual([{ id: tenantB.instanceId, name: tenantB.instanceName }]);
  });

  it('permite INSERT, UPDATE e DELETE somente nos registros do tenant ativo', async () => {
    const inserted = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => oneRow<{ id: string; organizationId: string; status: string }>(
        transaction,
        `INSERT INTO instances
           (organization_id, provider_account_id, name, upstream_instance_key)
         VALUES ($1, $2, 'tenant-a-write-control', 'upstream-tenant-a-write-control')
         RETURNING id, organization_id AS "organizationId", status`,
        [tenantA.organizationId, tenantA.providerAccountId],
      ),
    );
    expect(inserted).toMatchObject({
      organizationId: tenantA.organizationId,
      status: 'PROVISIONING',
    });

    const updated = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => oneRow<{ id: string; status: string }>(
        transaction,
        "UPDATE instances SET status = 'CONNECTED' WHERE id = $1 RETURNING id, status",
        [inserted.id],
      ),
    );
    expect(updated).toEqual({ id: inserted.id, status: 'CONNECTED' });

    const visibleFromTenantB = await withOrganizationTransaction(
      pools.appPool,
      tenantB.organizationId,
      async (transaction) => transaction.query(
        'SELECT id FROM instances WHERE id = $1',
        [inserted.id],
      ).then(({ rows }) => rows),
    );
    expect(visibleFromTenantB).toEqual([]);

    const deleted = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => oneRow<{ id: string }>(
        transaction,
        'DELETE FROM instances WHERE id = $1 RETURNING id',
        [inserted.id],
      ),
    );
    expect(deleted).toEqual({ id: inserted.id });

    const tenantAWriteControl = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query(
        'SELECT id FROM instances WHERE id = $1',
        [inserted.id],
      ).then(({ rows }) => rows),
    );
    const tenantBState = await withOrganizationTransaction(
      pools.appPool,
      tenantB.organizationId,
      async (transaction) => transaction.query<{ id: string; status: string }>(
        'SELECT id, status FROM instances ORDER BY id',
      ).then(({ rows }) => rows),
    );
    expect(tenantAWriteControl).toEqual([]);
    expect(tenantBState).toEqual([{ id: tenantB.instanceId, status: 'PROVISIONING' }]);
  });

  it('nega SELECT, INSERT, UPDATE e DELETE cruzados', async () => {
    const crossTenantRead = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query(
        'SELECT id FROM instances WHERE id = $1',
        [tenantB.instanceId],
      ).then(({ rows }) => rows),
    );
    const crossTenantUpdate = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query(
        "UPDATE instances SET status = 'CONNECTED' WHERE id = $1",
        [tenantB.instanceId],
      ).then(({ rowCount }) => rowCount),
    );
    const crossTenantDelete = await withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query(
        'DELETE FROM instances WHERE id = $1',
        [tenantB.instanceId],
      ).then(({ rowCount }) => rowCount),
    );

    expect(crossTenantRead).toEqual([]);
    expect(crossTenantUpdate).toBe(0);
    expect(crossTenantDelete).toBe(0);
    await expect(withOrganizationTransaction(
      pools.appPool,
      tenantA.organizationId,
      async (transaction) => transaction.query(
        `INSERT INTO instances
           (organization_id, provider_account_id, name, upstream_instance_key)
         VALUES ($1, $2, 'cross-tenant', 'upstream-cross-tenant')`,
        [tenantB.organizationId, tenantB.providerAccountId],
      ),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('nega por padrão sem contexto e impede jrc_auth de acessar tabelas tenant', async () => {
    const withoutContext = await pools.appPool.query('SELECT id FROM instances');

    expect(withoutContext.rows).toEqual([]);
    await expect(pools.authPool.query('SELECT id FROM instances'))
      .rejects.toThrow(/permission denied/i);
  });
});
