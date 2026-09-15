import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

function connectionStringForRole(connectionString: string, role: 'jrc_app' | 'jrc_auth'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe('limite entre transação PostgreSQL e provider HTTP', () => {
  let database: IsolatedPostgresDatabase;
  let pools: DatabasePools;
  let organizationId: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    pools = createDatabasePools({
      app: { connectionString: connectionStringForRole(database.connectionString, 'jrc_app'), max: 1 },
      auth: { connectionString: connectionStringForRole(database.connectionString, 'jrc_auth'), max: 1 },
    });

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const organization = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Boundary Tenant', 'boundary') RETURNING id",
      );
      organizationId = organization.id;
      const owner = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('boundary@example.test', 'argon2id-test-hash') RETURNING id",
      );
      await client.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
        [organizationId, owner.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pools.close();
    await database.dispose();
  });

  it('encerra a transação e libera a conexão antes da chamada HTTP ao provider', async () => {
    const backendPid = await withOrganizationTransaction(
      pools.appPool,
      organizationId,
      async (transaction) => oneRow<{ pid: number }>(
        transaction,
        'SELECT pg_backend_pid() AS pid',
      ).then(({ pid }) => pid),
    );

    let server: Server | undefined;
    try {
      server = createServer(async (_request, response) => {
        try {
          const activity = await oneRow<{ inTransaction: boolean }>(
            database.pool,
            `SELECT xact_start IS NOT NULL AS "inTransaction"
               FROM pg_stat_activity
              WHERE pid = $1`,
            [backendPid],
          );
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(activity));
        } catch {
          response.writeHead(500);
          response.end();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Provider test server did not expose a TCP address');
      }

      const providerResponse = await fetch(`http://127.0.0.1:${address.port}/provider-check`);

      expect(providerResponse.status).toBe(200);
      await expect(providerResponse.json()).resolves.toEqual({ inTransaction: false });
    } finally {
      if (server) {
        server.close();
        await once(server, 'close');
      }
    }
  });

  it('rejeita o pool administrativo no limite compartilhado antes de definir o tenant', async () => {
    const operation = async () => 'must-not-run';
    await expect(withOrganizationTransaction(database.pool, organizationId, operation))
      .rejects.toThrow('Organization transactions require a direct jrc_app connection');

    const leaked = await oneRow<{ organizationId: string | null }>(
      database.pool,
      "SELECT NULLIF(current_setting('app.organization_id', true), '') AS \"organizationId\"",
    );
    expect(leaked.organizationId).toBeNull();
  });
});
