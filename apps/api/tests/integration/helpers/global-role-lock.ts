import { Pool } from 'pg';

const GLOBAL_ROLE_LOCK_KEY = 'jrc-test-global-roles';

export async function withGlobalRoleLock<T>(
  adminConnectionString: string,
  operation: () => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: adminConnectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      [GLOBAL_ROLE_LOCK_KEY],
    );
    return await operation();
  } finally {
    await client.query(
      "select pg_advisory_unlock(hashtextextended($1, 0))",
      [GLOBAL_ROLE_LOCK_KEY],
    );
    client.release();
    await pool.end();
  }
}
