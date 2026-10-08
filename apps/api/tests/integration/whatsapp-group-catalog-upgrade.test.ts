import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { createWhatsAppGroupCatalog } from '../../src/modules/whatsapp-groups/service.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, queryAsTenant, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';

const groupJid = '120000000000001@g.us';

async function seedQrTenant(db: IsolatedPostgresDatabase) {
  const tenant = await seedAttendanceTenant(db, false), instance = randomUUID();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const provider = (await client.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1', [tenant.channel])).rows[0]!.provider_account_id;
    await client.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1 AND id=$2", [tenant.org, provider]);
    await client.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
      VALUES($1,$2,$3,'Synthetic G1 upgrade',$4,'CONNECTED')`, [instance, tenant.org, provider, `synthetic-g1-${instance}`]);
    await client.query('UPDATE messaging_channels SET provider=\'BAILEYS\',instance_id=$3,phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2', [tenant.org, tenant.channel, instance]);
    const actor = (await client.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [tenant.org])).rows[0]!.user_id as string;
    await client.query('COMMIT');
    return { ...tenant, instance, actor };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function rolePool(db: IsolatedPostgresDatabase, role: 'jrc_platform' | 'jrc_lifecycle') {
  const url = new URL(db.connectionString); url.username = role; url.password = '';
  return new Pool({ connectionString: url.href, max: 1 });
}

async function readyPurge(db: IsolatedPostgresDatabase, deletion: string) {
  const lease = randomUUID();
  // Synthetic engine cleanup acknowledgement; this never calls an engine.
  await db.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1", [deletion]);
  await db.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1", [deletion, lease]);
  return lease;
}

async function seedCatalog(db: IsolatedPostgresDatabase, tenant: Awaited<ReturnType<typeof seedQrTenant>>) {
  await db.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,$3,1,$4,now(),now()+interval '5 minutes')`, [tenant.org, tenant.channel, 'a'.repeat(64), randomUUID()]);
  await db.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count)
    VALUES($1,$2,$3,'Synthetic catalog group',3)`, [tenant.org, tenant.channel, groupJid]);
}

it('upgrades populated 0049 to 0050 without manufacturing catalogs, preserving QR history and enforcing tenant grants through purge', async () => {
  const admin = requireTestDatabaseAdminUrl(), db = await createIsolatedPostgresDatabase(admin);
  const scratchRoot = resolve(tmpdir()), folder = await mkdtemp(join(scratchRoot, 'jrc-g1-upgrade-'));
  let platform: Pool | undefined, worker: Pool | undefined;
  try {
    const source = resolve('apps/api/drizzle/migrations');
    const fullJournal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const latest = fullJournal.entries.find(entry => entry.tag === '0050_whatsapp_group_catalog')!;
    expect(latest).toBeDefined();
    const journal = { ...fullJournal, entries: fullJournal.entries.filter(entry => entry.idx < latest.idx) };
    expect(journal.entries.at(-1)?.tag).toBe('0049_qr_outbound_observations');
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await withGlobalRoleLock(admin, async () => {
      const client = await db.pool.connect();
      try {
        await client.query(await readFile('infra/app/postgres/init-roles.sql', 'utf8'));
        await client.query('SET ROLE jrc_migrator');
        await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
      } finally { await client.query('RESET ROLE'); client.release(); }
    });
    const a = await seedQrTenant(db), b = await seedQrTenant(db), survivor = await seedQrTenant(db);
    const pending = randomUUID(), sent = randomUUID(), incoming = randomUUID(), observed = randomUUID();
    for (const [id, direction, origin, state, providerId] of [
      [pending, 'OUTGOING', 'OPERATOR', 'ACCEPTED', null],
      [sent, 'OUTGOING', 'OPERATOR', 'SENT', 'synthetic-g1-sent'],
      [incoming, 'INCOMING', 'CONTACT', 'DELIVERED', 'synthetic-g1-contact'],
      [observed, 'OUTGOING', 'EXTERNAL_OBSERVED', 'SENT', 'synthetic-g1-observed'],
    ] as const) {
      await db.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id,idempotency_key,idempotency_body_hash)
        VALUES($1::uuid,$2,$3,$4,$5,$6,'{"type":"TEXT","text":"Synthetic preserved QR history"}',$7,$8,$1::text,$9)`,
      [id, a.org, a.channel, a.conversation, direction, origin, state, providerId, 'a'.repeat(64)]);
    }
    await db.pool.query('INSERT INTO messaging_outbox(organization_id,message_id) VALUES($1,$2)', [a.org, pending]);
    await db.pool.query(`INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at,state,provider_message_id)
      VALUES($1,$2,$3,$4,$5,now(),'CONFIRMED','synthetic-g1-sent')`, [a.org, a.channel, a.conversation, sent, randomUUID()]);
    await db.pool.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at,disposition,blocking,message_id)
      VALUES($1,$2,$3,'synthetic-g1-observed','{"type":"TEXT","text":"Synthetic observed history"}',now(),'EXTERNAL_OBSERVED',false,$4)`, [a.org, a.channel, a.conversation, observed]);
    const preservedTables = ['instances', 'messaging_channels', 'messaging_contacts', 'messaging_conversations', 'messaging_messages', 'messaging_outbox', 'qr_dispatch_attempts', 'qr_outbound_observations'];
    const preserved = async () => Object.fromEntries(await Promise.all(preservedTables.map(async table => [table,
      (await db.pool.query(`SELECT * FROM ${table} ORDER BY organization_id,to_jsonb(${table})::text`)).rows])));
    const before = await preserved(), oldJournal = (await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(oldJournal).toHaveLength(49);
    expect((await db.pool.query("SELECT to_regclass('public.whatsapp_group_catalogs') AS catalogs,to_regclass('public.whatsapp_group_catalog_items') AS items")).rows).toEqual([{ catalogs: null, items: null }]);
    const probeAsApp = async () => {
      const client = await db.pool.connect();
      try { await client.query('SET ROLE jrc_app'); return await probeRequiredRuntimeSchema(sql => client.query(sql)); }
      finally { await client.query('RESET ROLE'); client.release(); }
    };
    expect(await probeAsApp()).toBe(false);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    expect(await probeAsApp()).toBe(true);
    expect(await preserved()).toEqual(before);
    const newJournal = (await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(newJournal.slice(0, 49)).toEqual(oldJournal);
    expect(newJournal.find(row => row.created_at === String(latest.when))).toMatchObject({
      hash: createHash('sha256').update(await readFile(join(source, `${latest.tag}.sql`), 'utf8')).digest('hex'),
    });
    expect((await db.pool.query('SELECT * FROM whatsapp_group_catalogs')).rows).toEqual([]);
    expect((await db.pool.query('SELECT * FROM whatsapp_group_catalog_items')).rows).toEqual([]);
    for (const tenant of [a, b, survivor]) await seedCatalog(db, tenant);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'SELECT organization_id,group_jid,selected,automation_enabled FROM whatsapp_group_catalog_items')).rows)
      .toEqual([{ organization_id: a.org, group_jid: groupJid, selected: false, automation_enabled: false }]);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'SELECT channel_id FROM whatsapp_group_catalogs WHERE organization_id=$1', [b.org])).rows).toEqual([]);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'UPDATE whatsapp_group_catalog_items SET selected=true WHERE organization_id=$1', [b.org])).rowCount).toBe(0);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'DELETE FROM whatsapp_group_catalog_items WHERE organization_id=$1', [b.org])).rowCount).toBe(0);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'DELETE FROM whatsapp_group_catalog_items WHERE organization_id=$1', [a.org])).rowCount).toBe(1);
    await expect(queryAsTenant(db.pool, 'jrc_app', a.org, 'DELETE FROM whatsapp_group_catalogs WHERE organization_id=$1', [a.org])).rejects.toMatchObject({ code: '42501' });
    await expect(queryAsTenant(db.pool, 'jrc_app', a.org, 'UPDATE whatsapp_group_catalog_items SET automation_enabled=true WHERE organization_id=$1', [a.org])).rejects.toMatchObject({ code: '23514' });
    for (const update of ['snapshot_id=NULL', 'identity_fingerprint=NULL', 'catalog_revision=0',
      'valid_until=observed_at', 'identity_revision=0', 'lease_token=gen_random_uuid(),lease_expires_at=NULL']) {
      await expect(queryAsTenant(db.pool, 'jrc_app', a.org, `UPDATE whatsapp_group_catalogs SET ${update} WHERE organization_id=$1`, [a.org])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(queryAsTenant(db.pool, 'jrc_app', a.org, 'INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)', [a.org, b.channel])).rejects.toMatchObject({ code: '23503' });
    await expect(queryAsTenant(db.pool, 'jrc_app', a.org, 'INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)', [b.org, b.channel])).rejects.toMatchObject({ code: '42501' });
    const rules = (await db.pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname IN ('whatsapp_group_catalogs','whatsapp_group_catalog_items') ORDER BY c.relname`)).rows;
    expect(rules).toEqual(['whatsapp_group_catalog_items', 'whatsapp_group_catalogs'].map(relname => ({ relname, relrowsecurity: true, relforcerowsecurity: true, owner: 'jrc_migrator' })));
    for (const table of ['whatsapp_group_catalogs', 'whatsapp_group_catalog_items']) {
      for (const role of ['jrc_auth', 'jrc_platform']) {
        expect((await db.pool.query('SELECT has_table_privilege($1,$2,\'SELECT\') OR has_table_privilege($1,$2,\'INSERT\') OR has_table_privilege($1,$2,\'UPDATE\') OR has_table_privilege($1,$2,\'DELETE\') AS allowed', [role, table])).rows).toEqual([{ allowed: false }]);
      }
      expect((await db.pool.query('SELECT has_table_privilege(\'jrc_app\',$1,\'DELETE\') AS allowed', [table])).rows).toEqual([{ allowed: table === 'whatsapp_group_catalog_items' }]);
      expect((await db.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE c.oid=$1::regclass AND a.grantee=0) AS allowed`, [table])).rows).toEqual([{ allowed: false }]);
    }
    expect((await db.pool.query('SELECT * FROM messaging_outbox')).rows).toEqual(before.messaging_outbox);
    const untouched = (await db.pool.query('SELECT * FROM whatsapp_group_catalog_items WHERE organization_id=$1', [survivor.org])).rows;
    platform = rolePool(db, 'jrc_platform'); worker = rolePool(db, 'jrc_lifecycle');
    const channelDeletion = (await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',
      [a.org, a.instance, 'Synthetic G1 upgrade', 'Synthetic authorized channel deletion', 'TENANT', a.actor])).rows[0]!.id as string;
    await worker.query('SELECT lifecycle_purge_channel($1,$2)', [channelDeletion, await readyPurge(db, channelDeletion)]);
    expect((await db.pool.query('SELECT channel_id FROM whatsapp_group_catalogs WHERE organization_id=$1', [a.org])).rows).toEqual([]);
    expect((await db.pool.query('SELECT group_jid FROM whatsapp_group_catalog_items WHERE organization_id=$1', [a.org])).rows).toEqual([]);
    expect((await db.pool.query('SELECT id FROM instances WHERE id=$1', [a.instance])).rows).toEqual([]);
    const adminActor = randomUUID();
    await db.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')", [adminActor, `${adminActor}@example.test`]);
    const orgDeletion = (await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id',
      [b.org, 'Attendance', 'Synthetic authorized organization deletion', adminActor])).rows[0]!.id as string;
    await worker.query('SELECT lifecycle_purge_organization($1,$2)', [orgDeletion, await readyPurge(db, orgDeletion)]);
    expect((await db.pool.query('SELECT id FROM organizations WHERE id=$1', [b.org])).rows).toEqual([]);
    expect((await db.pool.query('SELECT group_jid FROM whatsapp_group_catalog_items WHERE organization_id=$1', [b.org])).rows).toEqual([]);
    expect((await db.pool.query('SELECT * FROM whatsapp_group_catalog_items WHERE organization_id=$1', [survivor.org])).rows).toEqual(untouched);
    expect((await db.pool.query('SELECT status FROM lifecycle_deletions WHERE id=ANY($1::uuid[]) ORDER BY id', [[channelDeletion, orgDeletion]])).rows).toEqual([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]);
    expect(await probeAsApp()).toBe(true);
  } finally {
    await platform?.end(); await worker?.end(); await db.dispose();
    const resolved = resolve(folder), relativePath = relative(scratchRoot, resolved);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('INVALID_SCRATCH_PATH');
    await rm(resolved, { recursive: true, force: true });
  }
}, 120000);

it.each(['CHANNEL', 'ORGANIZATION'] as const)('rejects publication after an actual %s fence during read-only provider IO and releases the lease for authorized purge', async fence => {
  const db = await attendanceDatabase();
  const platform = rolePool(db.database, 'jrc_platform'), worker = rolePool(db.database, 'jrc_lifecycle');
  try {
    const tenant = await seedQrTenant(db.database);
    const principal = { organizationId: tenant.org, actorId: tenant.actor };
    let deletion: string | undefined;
    let actor = tenant.actor;
    if (fence === 'ORGANIZATION') {
      actor = randomUUID();
      await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')", [actor, `${actor}@example.test`]);
    }
    const service = createWhatsAppGroupCatalog({
      encryptionKey: Buffer.alloc(32, 19).toString('base64'), transact: db.transact,
      readIdentity: async () => ({ connected: true, phone: '1'.repeat(11) }),
      readGroups: async () => {
        const request = fence === 'CHANNEL'
          ? await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id', [tenant.org, tenant.instance, 'Synthetic G1 upgrade', 'Synthetic deletion during catalog read', 'TENANT', actor])
          : await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id', [tenant.org, 'Attendance', 'Synthetic deletion during catalog read', actor]);
        deletion = request.rows[0]!.id as string;
        return [{ groupJid, subject: 'Synthetic late catalog', participantCount: 1, restrict: null, announce: null, isCommunity: null, isCommunityAnnounce: null, linkedParent: null }];
      },
    });
    await expect(service.refresh(principal, tenant.channel)).rejects.toThrow(fence === 'CHANNEL' ? 'GROUP_CHANNEL_NOT_FOUND' : 'ORGANIZATION_NOT_ACTIVE');
    expect(deletion).toBeDefined();
    expect((await db.database.pool.query('SELECT snapshot_id,identity_fingerprint,catalog_revision,lease_token,lease_expires_at FROM whatsapp_group_catalogs WHERE organization_id=$1', [tenant.org])).rows)
      .toEqual([{ snapshot_id: null, identity_fingerprint: null, catalog_revision: '0', lease_token: null, lease_expires_at: null }]);
    expect((await db.database.pool.query('SELECT group_jid FROM whatsapp_group_catalog_items WHERE organization_id=$1', [tenant.org])).rows).toEqual([]);
    const constraint = fence === 'CHANNEL' ? 'channel_deletion_in_progress' : 'organization_deletion_in_progress';
    await expect(db.transact(tenant.org, tx => tx.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [tenant.org, tenant.channel]))).rejects.toMatchObject({ code: '23514', constraint });
    await expect(db.transact(tenant.org, tx => tx.query("INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count) VALUES($1,$2,$3,'Late',1)", [tenant.org, tenant.channel, groupJid]))).rejects.toMatchObject({ code: '23514', constraint });
    expect((await worker.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS count', [tenant.org, fence === 'CHANNEL' ? tenant.channel : null])).rows).toEqual([{ count: 0 }]);
    const lease = await readyPurge(db.database, deletion!);
    await worker.query(fence === 'CHANNEL' ? 'SELECT lifecycle_purge_channel($1,$2)' : 'SELECT lifecycle_purge_organization($1,$2)', [deletion, lease]);
    expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1', [deletion])).rows).toEqual([{ status: 'COMPLETED' }]);
    expect((await db.database.pool.query('SELECT channel_id FROM whatsapp_group_catalogs WHERE organization_id=$1', [tenant.org])).rows).toEqual([]);
  } finally { await platform.end(); await worker.end(); await db.dispose(); }
}, 120000);
