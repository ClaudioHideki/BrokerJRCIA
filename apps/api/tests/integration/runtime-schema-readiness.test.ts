import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';

it('requires migration 0031 for app-role readiness after a valid 0030 upgrade', async () => {
  const adminUrl = requireTestDatabaseAdminUrl();
  const database = await createIsolatedPostgresDatabase(adminUrl);
  const scratch = resolve('.sessions');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(resolve(scratch, 'runtime-schema-'));

  try {
    const migrations = resolve('apps/api/drizzle/migrations');
    const journal = JSON.parse(await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    journal.entries = journal.entries.filter(entry => entry.idx < 30);
    await mkdir(resolve(folder, 'meta'));
    await writeFile(resolve(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(resolve(migrations, `${entry.tag}.sql`), resolve(folder, `${entry.tag}.sql`));
    }

    await withGlobalRoleLock(adminUrl, async () => {
      const client = await database.pool.connect();
      try {
        await client.query(await readFile('infra/app/postgres/init-roles.sql', 'utf8'));
        await client.query('set role jrc_migrator');
        await migrate(drizzle(client), {
          migrationsFolder: folder,
          migrationsSchema: 'drizzle',
          migrationsTable: '__drizzle_migrations',
        });
      } finally {
        await client.query('reset role');
        client.release();
      }
    });

    const probeAsApp = async () => {
      const client = await database.pool.connect();
      try {
        await client.query('set role jrc_app');
        return await probeRequiredRuntimeSchema(sql => client.query(sql));
      } finally {
        await client.query('reset role');
        client.release();
      }
    };

    expect(await probeAsApp()).toBe(false);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    expect(await probeAsApp()).toBe(true);

    const probeWithout = async (removeSql: string) => {
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role jrc_migrator');
        await client.query(removeSql);
        await client.query('set local role jrc_app');
        return await probeRequiredRuntimeSchema(sql => client.query(sql));
      } finally {
        await client.query('rollback');
        client.release();
      }
    };
    expect(await probeWithout('drop trigger instance_archive_operations on provider_operations')).toBe(false);
    expect(await probeWithout('alter table provider_operations disable trigger instance_archive_operations')).toBe(false);
    expect(await probeWithout('alter table automation_bindings drop constraint automation_binding_destination')).toBe(false);
    expect(await probeWithout('drop policy platform_boundary on economic_groups')).toBe(false);
    expect(await probeWithout('alter table economic_group_organizations no force row level security')).toBe(false);
  } finally {
    await database.dispose();
    if (!resolve(folder).startsWith(`${scratch}${sep}`)) {
      throw new Error('Unsafe test scratch path');
    }
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
