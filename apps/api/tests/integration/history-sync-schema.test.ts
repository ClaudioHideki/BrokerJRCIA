import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { historySyncRuntimeSql } from '../../src/db/history-sync-runtime-schema.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 180000);
afterAll(async () => { await db?.dispose(); });

it('admits the migrated private schema and refuses a missing immutable admission receipt field',async()=>{
  const client=await db.database.pool.connect();
  try {
    expect((await client.query(`SELECT (${historySyncRuntimeSql}) AS ready`)).rows[0].ready).toBe(true);
    await client.query('BEGIN');
    await client.query('ALTER TABLE history_sync_chunks DROP COLUMN admission_kind');
    expect((await client.query(`SELECT (${historySyncRuntimeSql}) AS ready`)).rows[0].ready).toBe(false);
  } finally {await client.query('ROLLBACK');client.release();}
});
it('refuses the catalogue schema if its peer identity guard is disabled',async()=>{
  const client=await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE history_sync_peers DISABLE TRIGGER history_sync_peer_guard');
    expect((await client.query(`SELECT (${historySyncRuntimeSql}) AS ready`)).rows[0].ready).toBe(false);
  } finally {await client.query('ROLLBACK');client.release();}
});
it('refuses incomplete 0090 source-media and chat-progress structures before serving the candidate binary',async()=>{
  const client=await db.database.pool.connect();
  try {
    for(const drift of [
      'ALTER TABLE history_sync_record_results DROP COLUMN peer_jid CASCADE',
      'ALTER TABLE messaging_media DROP CONSTRAINT messaging_media_upload_identity',
      'REVOKE EXECUTE ON FUNCTION history_media_upload_identity_valid(jsonb,text,uuid) FROM jrc_app',
    ]) {
      await client.query('BEGIN');await client.query(drift);
      expect((await client.query(`SELECT (${historySyncRuntimeSql}) AS ready`)).rows[0].ready,drift).toBe(false);
      await client.query('ROLLBACK');
    }
  } finally {await client.query('ROLLBACK');client.release();}
});
it('refuses a forced-RLS catalogue that the existing explicit lifecycle definer cannot clean',async()=>{
  const client=await db.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP POLICY lifecycle_migrator ON history_sync_catalogue_pages');
    expect((await client.query(`SELECT (${historySyncRuntimeSql}) AS ready`)).rows[0].ready).toBe(false);
  } finally {await client.query('ROLLBACK');client.release();}
});
async function seed() {
  const t = await seedAttendanceTenant(db.database), instance = randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`, [instance,t.channel]);
  return {...t, instance};
}

it('persists a stable logical number identity without using the engine generation as its key', async () => {
  const t = await seedAttendanceTenant(db.database);
  const values = [t.org, randomUUID(), t.channel, 'a'.repeat(64)];
  const sql = `INSERT INTO history_account_identities(organization_id,id,channel_id,owner_fingerprint)
    VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,channel_id,owner_fingerprint)
    DO UPDATE SET owner_fingerprint=EXCLUDED.owner_fingerprint RETURNING id`;
  const first = await db.transact(t.org, tx => tx.query(sql, values));
  const second = await db.transact(t.org, tx => tx.query(sql, [t.org, randomUUID(), t.channel, values[3]]));
  expect(second.rows[0].id).toBe(first.rows[0].id);
  const foreign = await seedAttendanceTenant(db.database);
  expect((await db.transact(foreign.org, tx => tx.query('SELECT id FROM history_account_identities'))).rows).toEqual([]);
});

it('keeps provisional work durable without a logical owner and rejects contradictory completion', async () => {
  const t = await seed(), run = randomUUID();
  await db.transact(t.org, tx => tx.query(`INSERT INTO history_sync_runs
    (organization_id,id,channel_id,request_id,request_hash,engine_id,engine_generation,session_generation,binding_fingerprint,categories,instance_id)
    VALUES($1,$2,$3,$4,$5,'synthetic-engine',1,$6,$5,ARRAY['INDIVIDUAL','GROUP','MEDIA'],$7)`,
  [t.org, run, t.channel, randomUUID(), 'a'.repeat(64), randomUUID(), t.instance]));
  expect((await db.transact(t.org, tx => tx.query('SELECT state,capture,history_account_identity FROM history_sync_runs WHERE id=$1', [run]))).rows[0])
    .toEqual({ state: 'RUNNING', capture: 'WAITING_IDENTITY', history_account_identity: null });
  await expect(db.transact(t.org, tx => tx.query("UPDATE history_sync_runs SET state='COMPLETED' WHERE id=$1", [run])))
    .rejects.toMatchObject({ code: '23514' });
  expect((await db.transact(t.org, tx => tx.query('SELECT state FROM history_sync_runs WHERE id=$1', [run]))).rows[0].state).toBe('RUNNING');
});

it('does not permit a caller to create a run for another tenant channel', async () => {
  const t = await seed(), foreign = await seed();
  await expect(db.transact(t.org, tx => tx.query(`INSERT INTO history_sync_runs
    (organization_id,channel_id,request_id,request_hash,engine_id,engine_generation,session_generation,binding_fingerprint,categories,instance_id)
    VALUES($1,$2,$3,$4,'synthetic-engine',1,$5,$4,ARRAY['INDIVIDUAL'],$6)`,
  [foreign.org, foreign.channel, randomUUID(), 'a'.repeat(64), randomUUID(), foreign.instance])))
    .rejects.toMatchObject({ code: '42501' });
  await expect(db.transact(t.org, tx => tx.query(`INSERT INTO history_sync_runs
    (organization_id,channel_id,request_id,request_hash,engine_id,engine_generation,session_generation,binding_fingerprint,categories,instance_id)
    VALUES($1,$2,$3,$4,'synthetic-engine',1,$5,$4,ARRAY['INDIVIDUAL'],$6)`,
  [t.org, foreign.channel, randomUUID(), 'a'.repeat(64), randomUUID(), foreign.instance])))
    .rejects.toMatchObject({ code: '23503' });
});

it('does not allow changing the provenance of committed work or partially confirming an owner', async () => {
  const t=await seed(), run=randomUUID();
  await db.transact(t.org,tx=>tx.query(`INSERT INTO history_sync_runs
    (organization_id,id,channel_id,instance_id,request_id,request_hash,engine_id,engine_generation,session_generation,binding_fingerprint,categories)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-engine',1,$7,$6,ARRAY['INDIVIDUAL'])`,
  [t.org,run,t.channel,t.instance,randomUUID(),'a'.repeat(64),randomUUID()]));
  await expect(db.transact(t.org,tx=>tx.query('UPDATE history_sync_runs SET engine_generation=2 WHERE id=$1',[run])))
    .rejects.toMatchObject({code:'23514'});
  const identity=randomUUID();
  await db.transact(t.org,tx=>tx.query('INSERT INTO history_account_identities(organization_id,id,channel_id,owner_fingerprint) VALUES($1,$2,$3,$4)',
    [t.org,identity,t.channel,'b'.repeat(64)]));
  await expect(db.transact(t.org,tx=>tx.query("UPDATE history_sync_runs SET history_account_identity=$2,identity_scope_id=$3,capture='CAPTURING' WHERE id=$1",[run,identity,randomUUID()])))
    .rejects.toMatchObject({code:'23514'});
  await expect(db.transact(t.org,tx=>tx.query("UPDATE history_sync_runs SET history_account_identity=$2,identity_scope_id=$3,owner_fingerprint=$4,capture='CAPTURING' WHERE id=$1",[run,identity,randomUUID(),'c'.repeat(64)])))
    .rejects.toMatchObject({code:'23514'});
});
