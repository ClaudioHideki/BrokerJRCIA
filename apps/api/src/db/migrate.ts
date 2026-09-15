import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(moduleDirectory, '../../drizzle/migrations');
const roleBootstrapFile = resolve(moduleDirectory, '../../../../infra/app/postgres/init-roles.sql');

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query(await readFile(roleBootstrapFile, 'utf8'));

    const access = await client.query<{ can_set_role: boolean }>(
      "select pg_has_role(current_user, 'jrc_migrator', 'SET') as can_set_role",
    );
    if (access.rows[0]?.can_set_role !== true) {
      throw new Error('Migration connection cannot SET ROLE jrc_migrator');
    }

    await client.query('set role jrc_migrator');
    const identity = await client.query<{ current_user: string }>('select current_user');
    if (identity.rows[0]?.current_user !== 'jrc_migrator') {
      throw new Error('Migration connection did not assume jrc_migrator');
    }

    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });
  } finally {
    if (connected) {
      try {
        await client.query('reset role');
      } finally {
        await client.end();
      }
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
  }
  await runMigrations(connectionString);
}
