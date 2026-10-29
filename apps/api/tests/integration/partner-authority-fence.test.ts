import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 60_000);
afterAll(async () => { await db?.dispose(); });

async function queued() {
  const tenant = await seedAttendanceTenant(db.database, false), key = randomUUID(), message = randomUUID();
  await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes)
    VALUES($1,$2,'Synthetic authority fence',$3,$4,ARRAY['messaging:send'])`,
  [key, tenant.org, randomUUID(), 'b'.repeat(64)]);
  await db.transact(tenant.org, tx => tx.query(`INSERT INTO messaging_messages
    (id,organization_id,channel_id,conversation_id,direction,source,content,state,authorizing_api_key_id)
    VALUES($1,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic queued message"}','ACCEPTED',$5)`,
  [message, tenant.org, tenant.channel, tenant.conversation, key]));
  return { ...tenant, key, message };
}

// The 0069 worker does not select authorizing_api_key_id. Its last database
// boundary before provider POST is this state UPDATE, so exercise that SQL
// directly without the new application-level validateClaim implementation.
const oldWorkerMarkSending = (t: Awaited<ReturnType<typeof queued>>) => db.transact(t.org,
  tx => tx.query("UPDATE messaging_messages SET state='SENDING',updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING state",
    [t.org, t.message]));

it.each([
  ['revoked', 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'],
  ['expired', "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"],
  ['scope removed', "UPDATE api_keys SET scopes=ARRAY['messaging:read'] WHERE id=$1"],
  ['deleted', 'DELETE FROM api_keys WHERE id=$1'],
])('blocks the old worker state boundary when the authorizing key is %s', async (_label, mutation) => {
  const t = await queued();
  await db.database.pool.query(mutation, [t.key]);
  await expect(oldWorkerMarkSending(t)).rejects.toMatchObject({ code: '42501', message: 'PARTNER_CREDENTIAL_REVOKED' });
  expect((await db.database.pool.query('SELECT state,authorizing_api_key_id FROM messaging_messages WHERE id=$1', [t.message])).rows[0])
    .toMatchObject({ state: 'ACCEPTED', authorizing_api_key_id: t.key });
});

it('permits a valid partner and checks SENDING to SENDING again after revocation', async () => {
  const t = await queued();
  expect((await oldWorkerMarkSending(t)).rows[0]?.state).toBe('SENDING');
  await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [t.key]);
  await expect(oldWorkerMarkSending(t)).rejects.toMatchObject({ code: '42501', message: 'PARTNER_CREDENTIAL_REVOKED' });
});

it('blocks partner MEDIA SENDING to SENDING after only media:send is removed while preserving TEXT',async()=>{
  const t=await queued();
  await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send','media:send'] WHERE id=$1",[t.key]);
  // A stored media reference is needed by the existing composite FK.
  const asset=randomUUID();
  await db.transact(t.org,tx=>tx.query(`INSERT INTO messaging_media(id,organization_id,channel_id,source,source_key,kind,file_name,descriptor)
    VALUES($1,$2,$3,'QR',$4,'image','synthetic.png',$5::jsonb)`,[asset,t.org,t.channel,randomUUID(),JSON.stringify({messageId:'synthetic-media-fence'})]));
  await db.database.pool.query(`UPDATE messaging_messages SET content=$2::jsonb WHERE id=$1`,[t.message,
    JSON.stringify({type:'MEDIA',mediaId:asset,kind:'image',fileName:'synthetic.png'})]);
  expect((await oldWorkerMarkSending(t)).rows[0]?.state).toBe('SENDING');
  await db.database.pool.query("UPDATE api_keys SET scopes=ARRAY['messaging:send'] WHERE id=$1",[t.key]);
  await expect(oldWorkerMarkSending(t)).rejects.toMatchObject({code:'42501',message:'PARTNER_CREDENTIAL_REVOKED'});
  const text=await queued();
  expect((await oldWorkerMarkSending(text)).rows[0]?.state).toBe('SENDING');
});

it('rejects a foreign-tenant authorizing identity without affecting legacy null-authority messages', async () => {
  const t = await queued(), other = await queued();
  await db.database.pool.query('UPDATE messaging_messages SET authorizing_api_key_id=$2 WHERE id=$1', [t.message, other.key]);
  await expect(oldWorkerMarkSending(t)).rejects.toMatchObject({ code: '42501' });
  await db.database.pool.query('UPDATE messaging_messages SET authorizing_api_key_id=NULL WHERE id=$1', [t.message]);
  await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [t.key]);
  expect((await oldWorkerMarkSending(t)).rows[0]?.state).toBe('SENDING');
});

it('waits for an in-progress revocation and rechecks its committed value without a lock cycle', async () => {
  const t = await queued(), revoker = await db.database.pool.connect();
  let workerPid!: (pid: number) => void;
  const pidAvailable = new Promise<number>(resolve => { workerPid = resolve; });
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    await revoker.query('BEGIN');
    const revokerPid = Number((await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    await revoker.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [t.key]);
    pending = db.transact(t.org, async tx => {
      await tx.query("SET LOCAL lock_timeout='5s'");
      workerPid(Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
      await tx.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND id=$2", [t.org, t.message]);
    }).then(() => ({}), error => ({ error }));
    const pid = await pidAvailable;
    let blocked = false;
    for (let count = 0; count < 100 && !blocked; count++) {
      const row = (await db.database.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [pid, revokerPid])).rows[0]!;
      blocked = row.blocked;
      if (!blocked) await wait(10);
    }
    expect(blocked).toBe(true);
    await revoker.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code: '42501', message: 'PARTNER_CREDENTIAL_REVOKED' } });
  } finally {
    await revoker.query('ROLLBACK');
    revoker.release();
    await pending;
  }
});

it.each([
  'ALTER TABLE messaging_messages DISABLE TRIGGER partner_message_authority',
  'DROP TRIGGER partner_message_authority ON messaging_messages',
  'ALTER FUNCTION partner_require_message_authority() SECURITY INVOKER',
  'GRANT EXECUTE ON FUNCTION partner_require_message_authority() TO PUBLIC',
  'GRANT EXECUTE ON FUNCTION partner_require_message_authority() TO jrc_app',
])('readiness rejects a weakened dispatch authority fence: %s', async change => {
  const client = await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(change);
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(false);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
