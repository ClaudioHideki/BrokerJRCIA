import type { Pool, PoolClient } from 'pg';

declare const tenantTransactionBrand: unique symbol;

export interface TenantTransaction {
  readonly [tenantTransactionBrand]: true;
  query: PoolClient['query'];
}

export type OrganizationTransaction<T> = (transaction: TenantTransaction) => Promise<T>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function assertDirectAppConnection(client: PoolClient): Promise<void> {
  const identity = await client.query<{ currentUser: string; sessionUser: string }>(
    `SELECT current_user AS "currentUser", session_user AS "sessionUser"`,
  );
  if (
    identity.rows[0]?.currentUser !== 'jrc_app'
    || identity.rows[0]?.sessionUser !== 'jrc_app'
  ) {
    throw new Error('Organization transactions require a direct jrc_app connection');
  }
}

export async function withOrganizationTransaction<T>(
  pool: Pool,
  organizationId: string,
  operation: OrganizationTransaction<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError: Error | undefined;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await assertDirectAppConnection(client);
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);

    const result = await operation(client as unknown as TenantTransaction);

    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        releaseError = asError(rollbackError);
        throw new AggregateError(
          [error, rollbackError],
          'Organization transaction failed and rollback did not complete',
        );
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
