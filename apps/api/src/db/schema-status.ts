import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsFolder = resolve(moduleDirectory, '../../drizzle/migrations');

export interface ExpectedMigration {
  name: string;
  hash: string;
  createdAt: number;
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

export interface MigrationStatus {
  state: 'CURRENT' | 'PENDING' | 'DIVERGED';
  compatible: boolean;
  expectedVersion: string | null;
  appliedVersion: string | null;
  expectedCount: number;
  appliedCount: number;
  pending: string[];
}

export function compareMigrationStatus(
  expectedInput: readonly ExpectedMigration[],
  appliedInput: readonly AppliedMigration[],
): MigrationStatus {
  const expected = [...expectedInput].sort((left, right) => left.createdAt - right.createdAt);
  const applied = [...appliedInput].sort((left, right) => left.createdAt - right.createdAt);
  const prefixMatches = applied.length <= expected.length && applied.every((migration, index) => {
    const expectedMigration = expected[index];
    return expectedMigration?.hash === migration.hash
      && expectedMigration.createdAt === migration.createdAt;
  });
  const appliedVersion = prefixMatches && applied.length > 0
    ? expected[applied.length - 1]?.name ?? null
    : null;
  const pending = prefixMatches
    ? expected.slice(applied.length).map(({ name }) => name)
    : [];
  const current = prefixMatches && pending.length === 0;

  return {
    state: current ? 'CURRENT' : prefixMatches ? 'PENDING' : 'DIVERGED',
    compatible: current,
    expectedVersion: expected.at(-1)?.name ?? null,
    appliedVersion,
    expectedCount: expected.length,
    appliedCount: applied.length,
    pending,
  };
}

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

export async function loadExpectedMigrations(
  migrationsFolder = defaultMigrationsFolder,
): Promise<ExpectedMigration[]> {
  const journal = JSON.parse(
    await readFile(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as Journal;
  const files = readMigrationFiles({ migrationsFolder });
  if (journal.entries.length !== files.length) {
    throw new Error('MIGRATION_MANIFEST_MISMATCH');
  }
  return journal.entries.map((entry, index) => ({
    name: entry.tag,
    createdAt: entry.when,
    hash: files[index]!.hash,
  }));
}

export async function inspectSchemaStatus(
  connectionString: string,
  migrationsFolder = defaultMigrationsFolder,
): Promise<MigrationStatus> {
  const expected = await loadExpectedMigrations(migrationsFolder);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
    );
    const applied = table.rows[0]?.present
      ? (await client.query<{ hash: string; created_at: string }>(
          'SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at',
        )).rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }))
      : [];
    await client.query('COMMIT');
    return compareMigrationStatus(expected, applied);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  const connectionString = process.env.SCHEMA_STATUS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(JSON.stringify({ state: 'UNAVAILABLE', code: 'SCHEMA_STATUS_DATABASE_URL_REQUIRED' }));
    process.exitCode = 2;
  } else {
    try {
      const status = await inspectSchemaStatus(connectionString);
      console.log(JSON.stringify(status, null, 2));
      if (!status.compatible) process.exitCode = 1;
    } catch {
      console.error(JSON.stringify({ state: 'UNAVAILABLE', code: 'SCHEMA_STATUS_UNAVAILABLE' }));
      process.exitCode = 2;
    }
  }
}
