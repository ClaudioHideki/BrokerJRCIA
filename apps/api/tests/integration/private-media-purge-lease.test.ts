import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>, lifecycle: Pool, platform: Pool, platformActor: string;
type Kind = 'CHANNEL' | 'ORGANIZATION';
function rolePool(role: string) {
  const url = new URL(db.database.connectionString); url.username = role; url.password = '';
  return new Pool({ connectionString: url.href, max: 1 });
}
async function fixture(kind: Kind) {
  const t = await seedAttendanceTenant(db.database, false), instance = randomUUID();
  const provider = (await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1', [t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1 AND id=$2", [t.org, provider]);
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic lease media',$4,'CONNECTED')", [instance,t.org,provider,`synthetic-${instance}`]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1", [t.channel,instance]);
  const owner = (await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [t.org])).rows[0]!.user_id;
  const d = kind === 'CHANNEL'
    ? (await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id', [t.org,instance,'Synthetic lease media','Synthetic lease test','TENANT',owner])).rows[0]!.id
    : (await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id', [t.org,'Attendance','Synthetic lease test',platformActor])).rows[0]!.id;
  const lease = randomUUID();
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1", [d]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [d,lease]);
  return { ...t, instance, d: d as string, lease };
}
const purgeSql = (kind: Kind) => kind === 'CHANNEL' ? 'SELECT lifecycle_purge_channel($1,$2)' : 'SELECT lifecycle_purge_organization($1,$2)';

beforeAll(async () => {
  db = await attendanceDatabase(); lifecycle = rolePool('jrc_lifecycle'); platform = rolePool('jrc_platform');
  platformActor = randomUUID();
  await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')", [platformActor,`${platformActor}@example.test`]);
});
afterAll(async () => { await lifecycle?.end(); await platform?.end(); await db?.dispose(); });

it.each<Kind>(['CHANNEL','ORGANIZATION'])('rejects %s purge when a current lease expires while waiting for the deletion row lock', async kind => {
  const t = await fixture(kind), holder = await db.database.pool.connect(), worker = await lifecycle.connect();
  let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
  try {
    await holder.query("UPDATE lifecycle_deletions SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [t.d]);
    await holder.query('BEGIN'); await holder.query('SELECT id FROM lifecycle_deletions WHERE id=$1 FOR UPDATE', [t.d]);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await worker.query('BEGIN');
    const workerPid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    expect((await worker.query('SELECT now()<lease_expires_at AS initially_live FROM lifecycle_deletions WHERE id=$1',[t.d])).rows).toEqual([{ initially_live: true }]);
    pending = worker.query(purgeSql(kind), [t.d,t.lease]).then(() => ({ result:true }), error => ({ error }));
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const wait = (await db.database.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [holderPid,workerPid])).rows[0]!.blocked;
      if (wait) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);
    await holder.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM lease_expires_at-clock_timestamp()))+0.05) FROM lifecycle_deletions WHERE id=$1',[t.d]);
    expect((await holder.query('SELECT lease_expires_at<=clock_timestamp() AS expired FROM lifecycle_deletions WHERE id=$1',[t.d])).rows).toEqual([{ expired: true }]);
    await holder.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code:'23514',constraint:'lifecycle_operation_not_ready' } });
  } finally {
    await holder.query('ROLLBACK');
    if (pending) await pending;
    await worker.query('ROLLBACK'); holder.release(); worker.release();
  }
  expect((await db.database.pool.query('SELECT status,lease_token FROM lifecycle_deletions WHERE id=$1',[t.d])).rows).toEqual([{ status:'REMOVING_DATA',lease_token:t.lease }]);
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rowCount).toBe(1);
  expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1',[t.org])).rowCount).toBe(1);
});

it.each<Kind>(['CHANNEL','ORGANIZATION'])('still purges %s with an unexpired current lease and completed external cleanup', async kind => {
  const t = await fixture(kind);
  await lifecycle.query(purgeSql(kind),[t.d,t.lease]);
  expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[t.d])).rows).toEqual([{status:'COMPLETED'}]);
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rowCount).toBe(0);
  expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1',[t.org])).rowCount).toBe(kind === 'ORGANIZATION' ? 0 : 1);
});
