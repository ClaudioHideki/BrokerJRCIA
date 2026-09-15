import type { Pool, PoolClient, QueryResultRow } from 'pg';

declare const adminTransactionBrand: unique symbol;

export interface AdminTransaction {
  readonly [adminTransactionBrand]: true;
  query: PoolClient['query'];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export type AdminTransactionOperation<T> = (transaction: AdminTransaction) => Promise<T>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function exactlyOne<T extends QueryResultRow>(
  transaction: AdminTransaction,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await transaction.query<T>(text, values);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error(`Expected exactly one row, received ${result.rows.length}`);
  }
  return row;
}

export async function runInAdminTransaction<T>(
  pool: Pool,
  operation: AdminTransactionOperation<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const access = await client.query<{ canSetRole: boolean }>(
      `SELECT pg_has_role(current_user, 'jrc_migrator', 'SET') AS "canSetRole"`,
    );
    if (access.rows[0]?.canSetRole !== true) {
      throw new Error('Administrative connection cannot SET ROLE jrc_migrator');
    }
    await client.query('SET LOCAL ROLE jrc_migrator');
    const result = await operation(client as unknown as AdminTransaction);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackFailure) {
        releaseError = asError(rollbackFailure);
        throw new AggregateError(
          [error, rollbackFailure],
          'Administrative transaction failed and rollback did not complete',
        );
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function acquireBootstrapLock(transaction: AdminTransaction): Promise<void> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('jrc-bootstrap-first-tenant', 0))",
  );
}

export async function countOrganizations(transaction: AdminTransaction): Promise<number> {
  const row = await exactlyOne<{ count: number }>(
    transaction,
    'SELECT count(*)::int AS count FROM organizations',
  );
  return row.count;
}

export async function createOrganization(
  transaction: AdminTransaction,
  input: CreateOrganizationInput,
): Promise<Organization> {
  return exactlyOne<Organization>(
    transaction,
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     RETURNING id, name, slug, status`,
    [input.name, input.slug],
  );
}
