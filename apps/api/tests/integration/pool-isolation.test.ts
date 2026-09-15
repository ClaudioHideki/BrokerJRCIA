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

function appConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.username = 'jrc_app';
  url.password = '';
  return url.toString();
}

async function seedTenant(client: PoolClient, slug: string): Promise<{ id: string; instanceName: string }> {
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
    const provider = await oneRow<{ id: string }>(
      client,
      `INSERT INTO provider_accounts (organization_id, provider, name)
       VALUES ($1, 'BAILEYS', $2) RETURNING id`,
      [organization.id, `provider-${slug}`],
    );
    const instanceName = `instance-${slug}`;
    await client.query(
      `INSERT INTO instances
         (organization_id, provider_account_id, name, upstream_instance_key)
       VALUES ($1, $2, $3, $4)`,
      [organization.id, provider.id, instanceName, `upstream-${slug}`],
    );
    await client.query('COMMIT');
    return { id: organization.id, instanceName };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('isolamento do contexto tenant no pool', () => {
  let database: IsolatedPostgresDatabase;
  let pools: DatabasePools;
  let tenantA: { id: string; instanceName: string };
  let tenantB: { id: string; instanceName: string };

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    const unusedAuthUrl = new URL(database.connectionString);
    unusedAuthUrl.username = 'jrc_auth';
    unusedAuthUrl.password = '';
    pools = createDatabasePools({
      app: { connectionString: appConnectionString(database.connectionString), max: 1 },
      auth: { connectionString: unusedAuthUrl.toString(), max: 1 },
    });

    const client = await database.pool.connect();
    try {
      tenantA = await seedTenant(client, 'pool-a');
      tenantB = await seedTenant(client, 'pool-b');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pools.close();
    await database.dispose();
  });

  async function contextOutsideTransaction(): Promise<{
    pid: number;
    organizationId: string | null;
    visibleInstances: number;
  }> {
    return oneRow(
      pools.appPool,
      `SELECT pg_backend_pid() AS pid,
              NULLIF(current_setting('app.organization_id', true), '') AS "organizationId",
              (SELECT count(*)::int FROM instances) AS "visibleInstances"`,
    );
  }

  it('limpa o SET LOCAL após commit e reutiliza a mesma conexão com outro tenant', async () => {
    const committed = await withOrganizationTransaction(
      pools.appPool,
      tenantA.id,
      async (transaction) => oneRow<{ pid: number; organizationId: string; names: string[] }>(
        transaction,
        `SELECT pg_backend_pid() AS pid,
                current_setting('app.organization_id', true) AS "organizationId",
                ARRAY(SELECT name FROM instances ORDER BY name) AS names`,
      ),
    );
    const outside = await contextOutsideTransaction();
    const reused = await withOrganizationTransaction(
      pools.appPool,
      tenantB.id,
      async (transaction) => oneRow<{ pid: number; organizationId: string; names: string[] }>(
        transaction,
        `SELECT pg_backend_pid() AS pid,
                current_setting('app.organization_id', true) AS "organizationId",
                ARRAY(SELECT name FROM instances ORDER BY name) AS names`,
      ),
    );

    expect(committed).toEqual({
      pid: outside.pid,
      organizationId: tenantA.id,
      names: [tenantA.instanceName],
    });
    expect(outside.organizationId).toBeNull();
    expect(outside.visibleInstances).toBe(0);
    expect(reused).toEqual({
      pid: outside.pid,
      organizationId: tenantB.id,
      names: [tenantB.instanceName],
    });
  });

  it('limpa o SET LOCAL após rollback na mesma conexão', async () => {
    let transactionPid: number | undefined;
    const failure = new Error('force rollback');

    await expect(withOrganizationTransaction(
      pools.appPool,
      tenantA.id,
      async (transaction) => {
        transactionPid = (await oneRow<{ pid: number }>(
          transaction,
          'SELECT pg_backend_pid() AS pid',
        )).pid;
        throw failure;
      },
    )).rejects.toBe(failure);

    const outside = await contextOutsideTransaction();
    expect(outside.pid).toBe(transactionPid);
    expect(outside.organizationId).toBeNull();
    expect(outside.visibleInstances).toBe(0);
  });
});
