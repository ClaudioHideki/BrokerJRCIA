import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

it('upgrades 0017 without modifying credentials, IDs or previous verification evidence', async () => {
  const admin = requireTestDatabaseAdminUrl();
  const db = await createIsolatedPostgresDatabase(admin);
  const scratch = resolve('.sessions');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(resolve(scratch, 'destination-upgrade-'));
  try {
    const migrations = resolve('apps/api/drizzle/migrations');
    const journal = JSON.parse(await readFile(resolve(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 17);
    await mkdir(resolve(folder, 'meta'));
    await writeFile(resolve(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(resolve(migrations, `${entry.tag}.sql`), resolve(folder, `${entry.tag}.sql`));
    await withGlobalRoleLock(admin, async () => {
      const client = await db.pool.connect();
      try {
        await client.query(await readFile('infra/app/postgres/init-roles.sql', 'utf8'));
        await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
      } finally { await client.query('RESET ROLE'); client.release(); }
    });
    const org = await runInAdminTransaction(db.pool, async tx => {
      const id = (await createOrganization(tx, { name: 'Upgrade fixture', slug: 'upgrade-fixture' })).id;
      const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES('upgrade@example.test','synthetic') RETURNING id")).rows[0];
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user.id]);
      return id;
    });
    await db.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://legacy.example.com',1,'opaque-upgrade-fixture','READY')", [org]);
    const before = (await db.pool.query('SELECT * FROM chatwoot_accounts WHERE organization_id=$1', [org])).rows[0];
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    const after = (await db.pool.query('SELECT * FROM chatwoot_accounts WHERE organization_id=$1', [org])).rows[0];
    expect(after).toMatchObject(before);
    expect(after).toMatchObject({ credential_version: 1, capabilities: {}, capabilities_verified_at: null });
    expect((await db.pool.query('SELECT * FROM chatwoot_destinations WHERE organization_id=$1', [org])).rows[0])
      .toMatchObject({ base_url: before.base_url, mode: 'MANAGED', approval_status: 'APPROVED', approved_at: null, approval_audit_id: null });
    const authClient = await db.pool.connect();
    try {
      await authClient.query('SET ROLE jrc_auth');
      await expect(authClient.query('SELECT * FROM chatwoot_destinations')).rejects.toThrow();
    } finally { await authClient.query('RESET ROLE'); authClient.release(); }
  } finally {
    await db.dispose();
    if (!resolve(folder).startsWith(scratch + sep)) throw new Error('Unsafe test scratch path');
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
