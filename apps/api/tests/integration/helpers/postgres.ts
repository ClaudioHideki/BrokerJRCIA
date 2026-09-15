import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface IsolatedPostgresDatabase {
  connectionString: string;
  databaseName: string;
  pool: Pool;
  dispose(): Promise<void>;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error('Unsafe PostgreSQL identifier');
  }
  return `"${identifier}"`;
}

export function requireTestDatabaseAdminUrl(): string {
  const value = process.env.TEST_DATABASE_ADMIN_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_ADMIN_URL is required for PostgreSQL integration tests');
  }
  return value;
}

export async function createIsolatedPostgresDatabase(
  adminConnectionString: string,
): Promise<IsolatedPostgresDatabase> {
  const databaseName = `jrc_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: adminConnectionString, max: 1 });
  await adminPool.query(`create database ${quoteIdentifier(databaseName)}`);

  const databaseUrl = new URL(adminConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  const connectionString = databaseUrl.toString();
  const pool = new Pool({ connectionString });

  return {
    connectionString,
    databaseName,
    pool,
    async dispose() {
      await pool.end();
      // Do not terminate sockets that pg has just begun closing: that races with
      // the normal shutdown and emits an unhandled FATAL on the closing client.
      // A genuinely leaked connection must fail cleanup instead of being hidden.
      try {
        await adminPool.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
      } finally {
        await adminPool.end();
      }
    },
  };
}

export async function oneRow<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rows.length !== 1) {
    throw new Error(`Expected one row, received ${result.rows.length}`);
  }
  return result.rows[0] as T;
}

export async function queryAs(
  pool: Pool,
  role: 'jrc_app' | 'jrc_auth',
  text: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(role)}`);
    await client.query(text);
    await client.query('rollback');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryAsTenant<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  role: 'jrc_app' | 'jrc_auth',
  organizationId: string,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(role)}`);
    await client.query("select set_config('app.organization_id', $1, true)", [organizationId]);
    const result = await client.query<T>(text, values);
    await client.query('rollback');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
