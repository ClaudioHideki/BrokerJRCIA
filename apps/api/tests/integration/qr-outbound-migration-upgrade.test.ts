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
import { seedAttendanceTenant } from './helpers/attendance.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, queryAsTenant, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';

async function seedQrTenant(db: IsolatedPostgresDatabase) {
  const tenant = await seedAttendanceTenant(db, false);
  const client = await db.pool.connect();
  const instance = randomUUID();
  try {
    await client.query('BEGIN');
    const account = (await client.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1', [tenant.channel])).rows[0]!.provider_account_id as string;
    await client.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1 AND organization_id=$2", [account, tenant.org]);
    await client.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status)
      VALUES($1,$2,$3,'Synthetic QR upgrade',$4,'CONNECTED')`, [instance, tenant.org, account, `synthetic-upgrade-${instance}`]);
    await client.query(`UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL
      WHERE organization_id=$1 AND id=$2`, [tenant.org, tenant.channel, instance]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { ...tenant, instance };
}

it('upgrades populated 0048 to 0049 without inventing provider IDs, preserving history and tenant boundaries through purge', async () => {
  const admin = requireTestDatabaseAdminUrl();
  const db = await createIsolatedPostgresDatabase(admin);
  const root = resolve(tmpdir());
  const folder = await mkdtemp(join(root, 'jrc-qr-outbound-upgrade-'));
  let worker: Pool | undefined;
  try {
    const source = resolve('apps/api/drizzle/migrations');
    const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const latest = journal.entries.find(entry => entry.tag === '0049_qr_outbound_observations')!;
    journal.entries = journal.entries.filter(entry => entry.idx < latest.idx);
    expect(journal.entries.at(-1)?.tag).toBe('0048_central_cutover');
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

    const a = await seedQrTenant(db), b = await seedQrTenant(db), meta = await seedAttendanceTenant(db, false);
    const sending = randomUUID(), unknown = randomUUID(), confirmed = randomUUID(), incoming = randomUUID();
    const otherUnknown = randomUUID(), metaUnknown = randomUUID(), lease = randomUUID();
    const expiry = new Date('2030-01-01T00:00:00.000Z');
    for (const [id, tenant, direction, sourceKind, state, upstream] of [
      [sending, a, 'OUTGOING', 'AUTOMATION', 'SENDING', null],
      [unknown, a, 'OUTGOING', 'OPERATOR', 'UNKNOWN', null],
      [confirmed, a, 'OUTGOING', 'OPERATOR', 'SENT', 'synthetic-confirmed-proof'],
      [incoming, a, 'INCOMING', 'CONTACT', 'DELIVERED', 'synthetic-contact-proof'],
      [otherUnknown, b, 'OUTGOING', 'OPERATOR', 'UNKNOWN', null],
      [metaUnknown, meta, 'OUTGOING', 'AUTOMATION', 'UNKNOWN', null],
    ] as const) {
      await db.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id,idempotency_key,idempotency_body_hash)
        VALUES($1::uuid,$2,$3,$4,$5,$6,'{"type":"TEXT","text":"Synthetic upgrade history"}',$7,$8,$1::text,$9)`,
      [id, tenant.org, tenant.channel, tenant.conversation, direction, sourceKind, state, upstream, 'a'.repeat(64)]);
    }
    await db.pool.query(`INSERT INTO messaging_outbox(organization_id,message_id,lease_token,lease_expires_at,attempt_count,retry_safe)
      VALUES($1,$2,$3,$4,2,false)`, [a.org, sending, lease, expiry]);

    const snapshot = async () => ({
      channels: (await db.pool.query('SELECT * FROM messaging_channels ORDER BY id')).rows,
      contacts: (await db.pool.query('SELECT * FROM messaging_contacts ORDER BY id')).rows,
      conversations: (await db.pool.query('SELECT * FROM messaging_conversations ORDER BY id')).rows,
      messages: (await db.pool.query('SELECT * FROM messaging_messages ORDER BY id')).rows,
      outbox: (await db.pool.query('SELECT * FROM messaging_outbox ORDER BY organization_id,message_id')).rows,
    });
    const before = await snapshot();
    const oldJournal = (await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(oldJournal).toHaveLength(48);
    expect(oldJournal.at(-1)?.created_at).toBe(String(journal.entries.at(-1)!.when));
    expect((await db.pool.query("SELECT to_regclass('public.qr_dispatch_attempts') AS attempts,to_regclass('public.qr_outbound_observations') AS observations")).rows)
      .toEqual([{ attempts: null, observations: null }]);
    const probeAsApp = async () => {
      const client = await db.pool.connect();
      try { await client.query('SET ROLE jrc_app'); return await probeRequiredRuntimeSchema(sql => client.query(sql)); }
      finally { await client.query('RESET ROLE'); client.release(); }
    };
    expect(await probeAsApp()).toBe(false);
    const started = (await db.pool.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    expect(await probeAsApp()).toBe(true);
    const ended = (await db.pool.query('SELECT clock_timestamp() AS now')).rows[0]!.now as Date;
    expect(await snapshot()).toEqual(before);
    const newJournal = (await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(newJournal).toHaveLength(50); expect(newJournal.slice(0, 48)).toEqual(oldJournal);
    expect(newJournal[48]).toMatchObject({ hash: createHash('sha256').update(await readFile(join(source, `${latest.tag}.sql`), 'utf8')).digest('hex'), created_at: String(latest.when) });

    const attempts = (await db.pool.query('SELECT * FROM qr_dispatch_attempts')).rows;
    expect(attempts).toHaveLength(3);
    expect(attempts.find(row => row.message_id === sending)).toMatchObject({ organization_id: a.org, channel_id: a.channel, conversation_id: a.conversation,
      lease_token: lease, lease_expires_at: expiry, state: 'DISPATCHED', provider_message_id: null, revision: 1 });
    for (const [message, tenant] of [[unknown, a], [otherUnknown, b]] as const) {
      const attempt = attempts.find(row => row.message_id === message)!;
      expect(attempt).toMatchObject({ organization_id: tenant.org, channel_id: tenant.channel, conversation_id: tenant.conversation, state: 'UNKNOWN', provider_message_id: null, revision: 1 });
      expect(attempt.lease_token).toMatch(/^[a-f0-9-]{36}$/); expect(attempt.lease_token).not.toBe(lease);
      expect((attempt.lease_expires_at as Date).getTime()).toBeGreaterThanOrEqual(started.getTime());
      expect((attempt.lease_expires_at as Date).getTime()).toBeLessThanOrEqual(ended.getTime());
    }
    expect(attempts.some(row => [confirmed, incoming, metaUnknown].includes(row.message_id))).toBe(false);
    expect((await db.pool.query('SELECT * FROM qr_outbound_observations')).rows).toEqual([]);
    expect((await db.pool.query("SELECT table_name FROM lifecycle_purge_catalogue WHERE table_name IN ('qr_dispatch_attempts','qr_outbound_observations') ORDER BY table_name")).rows)
      .toEqual([{ table_name: 'qr_dispatch_attempts' }, { table_name: 'qr_outbound_observations' }]);

    const ownRows = await queryAsTenant(db.pool, 'jrc_app', a.org, 'SELECT organization_id,message_id FROM qr_dispatch_attempts');
    expect(ownRows.rows).toHaveLength(2); expect(ownRows.rows.every(row => row.organization_id === a.org)).toBe(true);
    expect((await queryAsTenant(db.pool, 'jrc_app', b.org, 'SELECT message_id FROM qr_dispatch_attempts')).rows).toEqual([{ message_id: otherUnknown }]);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, 'SELECT id FROM qr_dispatch_attempts WHERE organization_id=$1', [b.org])).rows).toEqual([]);
    expect((await queryAsTenant(db.pool, 'jrc_app', a.org, "UPDATE qr_dispatch_attempts SET state='REJECTED' WHERE organization_id=$1", [b.org])).rowCount).toBe(0);
    await expect(queryAsTenant(db.pool, 'jrc_app', a.org, `INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,now())`, [b.org, b.channel, b.conversation, otherUnknown, randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(db.pool.query(`INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,now())`, [a.org, a.channel, b.conversation, otherUnknown, randomUUID()])).rejects.toMatchObject({ code: '23503' });
    await expect(db.pool.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at)
      VALUES($1,$2,$3,'synthetic-cross-tenant','{"type":"TEXT","text":"Synthetic"}',now())`, [a.org, a.channel, b.conversation])).rejects.toMatchObject({ code: '23503' });
    const pending = (await db.pool.query(`SELECT lifecycle_pending_count($1,$2,NULL)::int AS current,
      lifecycle_pending_count_before_qr_outbound($1,$2,NULL)::int AS previous`, [a.org, a.channel])).rows[0]!;
    expect(pending.current).toBe(pending.previous + 2);

    // Only after preservation assertions, model explicit reconciliation and authorized isolated cleanup.
    await db.pool.query("UPDATE messaging_messages SET state='FAILED' WHERE organization_id=$1 AND state IN ('SENDING','UNKNOWN')", [a.org]);
    await db.pool.query('UPDATE messaging_outbox SET lease_token=NULL,lease_expires_at=NULL WHERE organization_id=$1', [a.org]);
    await db.pool.query("UPDATE qr_dispatch_attempts SET state='REJECTED' WHERE organization_id=$1", [a.org]);
    await db.pool.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at,disposition,blocking,message_id)
      VALUES($1,$2,$3,'synthetic-confirmed-proof','{"type":"TEXT","text":"Synthetic confirmed echo"}',now(),'BROKER_ECHO',false,$4)`, [a.org, a.channel, a.conversation, confirmed]);
    expect((await queryAsTenant(db.pool, 'jrc_app', b.org, 'SELECT id FROM qr_outbound_observations')).rows).toEqual([]);
    const actor = (await db.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [a.org])).rows[0]!.user_id as string;
    const deletion = randomUUID(), cleanupLease = randomUUID();
    await db.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,messaging_channel_id,provider,actor_kind,actor_id,status,lease_token,lease_expires_at)
      VALUES($1,$2,'CHANNEL',$3,$4,'QR','TENANT',$5,'REMOVING_DATA',$6,now()+interval '1 minute')`, [deletion, a.org, a.instance, a.channel, actor, cleanupLease]);
    const workerUrl = new URL(db.connectionString); workerUrl.username = 'jrc_lifecycle'; workerUrl.password = '';
    worker = new Pool({ connectionString: workerUrl.href, max: 1 });
    await worker.query('SELECT lifecycle_purge_channel($1,$2)', [deletion, cleanupLease]);
    for (const table of ['qr_dispatch_attempts', 'qr_outbound_observations', 'messaging_messages', 'messaging_conversations', 'messaging_outbox']) {
      expect((await db.pool.query(`SELECT organization_id FROM ${table} WHERE organization_id=$1`, [a.org])).rows).toEqual([]);
    }
    expect((await db.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1', [deletion])).rows).toEqual([{ status: 'COMPLETED' }]);
    expect((await db.pool.query('SELECT state,provider_message_id FROM qr_dispatch_attempts WHERE organization_id=$1', [b.org])).rows)
      .toEqual([{ state: 'UNKNOWN', provider_message_id: null }]);
    expect((await db.pool.query('SELECT * FROM messaging_messages WHERE organization_id=$1 ORDER BY id', [b.org])).rows)
      .toEqual(before.messages.filter(row => row.organization_id === b.org));
    expect((await db.pool.query('SELECT * FROM messaging_messages WHERE organization_id=$1 ORDER BY id', [meta.org])).rows)
      .toEqual(before.messages.filter(row => row.organization_id === meta.org));
    expect((await db.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(newJournal);
    expect(await probeAsApp()).toBe(true);
  } finally {
    await worker?.end(); await db.dispose();
    const scratchPath = relative(root, resolve(folder));
    if (!scratchPath || scratchPath.startsWith('..') || isAbsolute(scratchPath)) throw new Error('INVALID_SCRATCH_PATH');
    await rm(folder, { recursive: true, force: true });
  }
}, 120000);
