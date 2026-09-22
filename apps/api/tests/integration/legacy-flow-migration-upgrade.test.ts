import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0028 to 0029 without changing legacy flows or exposing their content', async () => {
  const adminUrl = requireTestDatabaseAdminUrl();
  const database = await createIsolatedPostgresDatabase(adminUrl);
  const scratch = resolve('.sessions');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(resolve(scratch, 'legacy-flow-upgrade-'));

  try {
    const migrations = resolve('apps/api/drizzle/migrations');
    const journal = JSON.parse(await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < 28);
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

    const seed = await database.pool.connect();
    let seeded: { rows: Array<{ organization_id: string; flow_id: string }> };
    try {
      await seed.query('begin');
      const organization = await seed.query<{ id: string }>(
        `insert into organizations(name, slug)
         values ('Legacy upgrade', 'legacy-upgrade') returning id`,
      );
      const owner = await seed.query<{ id: string }>(
        `insert into users(email, password_hash)
         values ('legacy-upgrade@example.test', 'test-only-no-login') returning id`,
      );
      await seed.query(
        `insert into memberships(organization_id, user_id, role)
         values ($1, $2, 'OWNER')`,
        [organization.rows[0]!.id, owner.rows[0]!.id],
      );
      seeded = await seed.query<{ organization_id: string; flow_id: string }>(
        `insert into flows(organization_id, name, graph)
         values ($1, 'Sensitive legacy flow', '{"nodes":[{"secret":"must-not-leak"}]}'::jsonb)
         returning organization_id, id as flow_id`,
        [organization.rows[0]!.id],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
    const before = await database.pool.query(
      'select id, organization_id, name, graph, revision, published_version from flows',
    );

    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));

    const after = await database.pool.query(
      'select id, organization_id, name, graph, revision, published_version from flows',
    );
    expect(after.rows).toEqual(before.rows);

    const runtime = await database.pool.connect();
    try {
      await runtime.query('set role jrc_app');
      const discovery = await runtime.query(
        'select * from legacy_flow_migration_organizations(null, 100)',
      );
      const directFlows = await runtime.query('select id, name, graph from flows');

      expect(discovery.fields.map((field) => field.name)).toEqual(['organization_id']);
      expect(discovery.rows).toEqual([
        { organization_id: seeded.rows[0]!.organization_id },
      ]);
      expect(JSON.stringify(discovery.rows)).not.toContain('must-not-leak');
      expect(directFlows.rows).toEqual([]);
    } finally {
      await runtime.query('reset role');
      runtime.release();
    }
  } finally {
    await database.dispose();
    if (!resolve(folder).startsWith(`${scratch}${sep}`)) {
      throw new Error('Unsafe test scratch path');
    }
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
