import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { seedAttendanceTenant } from './helpers/attendance.js';
import { createIsolatedPostgresDatabase, queryAsTenant, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0072 without granting initial identity authority to existing connections or pending replies', async () => {
  const admin = requireTestDatabaseAdminUrl(), db = await createIsolatedPostgresDatabase(admin), root = resolve(tmpdir());
  const folder = await mkdtemp(join(root, 'initial-identity-upgrade-'));
  try {
    const source = resolve('apps/api/drizzle/migrations'), journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 72);
    await mkdir(join(folder, 'meta')); await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(join(source, entry.tag + '.sql'), join(folder, entry.tag + '.sql'));
    await withGlobalRoleLock(admin, async () => {
      const client = await db.pool.connect();
      try {
        await client.query(await readFile('infra/app/postgres/init-roles.sql', 'utf8')); await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
      } finally { await client.query('RESET ROLE'); client.release(); }
    });
    const t = await seedAttendanceTenant(db);
    await db.pool.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,identity_enforced,observed_fingerprint,observed_connected)
      VALUES($1,$2,$3,true,'synthetic-legacy-observation',true)`, [t.org, t.integration, t.channel]);
    await db.pool.query("INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,payload) VALUES($1,$2,'CHATWOOT_REPLY','synthetic-legacy-reply','{}')", [t.org, t.integration]);
    const before = (await db.pool.query('SELECT * FROM chatwoot_connection_health')).rows[0];
    expect(await probeRequiredRuntimeSchema(sql => queryAsTenant(db.pool, 'jrc_app', t.org, sql))).toBe(false);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    const after = (await db.pool.query('SELECT * FROM chatwoot_connection_health')).rows[0];
    expect(after).toMatchObject(before);
    expect(after).toMatchObject({ approved_fingerprint: null, initial_identity_intent: null, initial_identity_expires_at: null, initial_identity_pair_expires_at: null });
    expect((await db.pool.query('SELECT status FROM integration_jobs WHERE organization_id=$1', [t.org])).rows).toEqual([{ status: 'PENDING' }]);
    expect(await probeRequiredRuntimeSchema(sql => queryAsTenant(db.pool, 'jrc_app', t.org, sql))).toBe(true);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('ALTER TABLE chatwoot_connection_health DROP CONSTRAINT chatwoot_initial_identity_shape');
      await client.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(false);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await db.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name='chatwoot_connection_health'")).rows).toHaveLength(1);
    await expect(queryAsTenant(db.pool, 'jrc_auth', t.org, 'SELECT initial_identity_intent FROM chatwoot_connection_health')).rejects.toMatchObject({ code: '42501' });
  } finally {
    await db.dispose(); const child = relative(root, resolve(folder));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_SCRATCH_PATH');
    await rm(folder, { recursive: true, force: true });
  }
}, 60000);
