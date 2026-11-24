import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase} from './helpers/attendance.js';
import {resumeFixture} from './helpers/attendance-resume.js';
import {settleResolvedPhysicalCycles} from '../../src/modules/attendance/resolved-cycle.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';

describe('opt-in reentry after a resolved JRC attendance',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{db=await attendanceDatabase();},60000);
 afterAll(async()=>{await db?.dispose();});
 async function fixture(enabled=true){
  const t=await resumeFixture(db);
  await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
  await db.database.pool.query(`UPDATE automation_versions SET graph=jsonb_set(graph,'{nodes,0,data}',$2::jsonb) WHERE organization_id=$1`,
   [t.org,JSON.stringify({entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS',restartAfterResolution:enabled})]);
  return t;
 }
 it('preserves the resolved mapping and starts a fresh bot conversation only on the next incoming message',async()=>{
  const t=await fixture();t.canonical.status='resolved';t.canonical.updated_at++;await t.record();
  expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
  const old=(await db.database.pool.query('SELECT mode,remote_conversation_key,contact_id FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0];
  expect(old.mode).toBe('HUMAN');expect(old.remote_conversation_key).toMatch(/^chatwoot-cycle:/);
  expect((await db.database.pool.query('SELECT remote_conversation_id FROM chatwoot_conversations WHERE conversation_id=$1',[t.conversation])).rows[0].remote_conversation_id).toBe('51');
  expect((await db.database.pool.query('SELECT count(*) FROM messaging_messages WHERE organization_id=$1',[t.org])).rows[0].count).toBe('0');
  const next=await db.transact(t.org,tx=>createPostgresMessagingRepository().getOrCreateConversation(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,contactId:old.contact_id}));
  expect(next.id).not.toBe(t.conversation);expect(next.mode).toBe('BOT');
  expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
 });
 it('does not release a human attendance, another tenant, an unconfigured box or a newer human observation',async()=>{
  const active=await fixture(),disabled=await fixture(false),resolved=await fixture();
  disabled.canonical.status='resolved';disabled.canonical.updated_at++;await disabled.record();
  const hold=randomUUID();
  await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
   VALUES($1::uuid,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic"}','UNKNOWN',$1::text,$5)`,[hold,resolved.org,resolved.channel,resolved.conversation,'b'.repeat(64)]);
  resolved.canonical.status='resolved';resolved.canonical.updated_at++;await resolved.record();await resolved.human();
  await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1",[hold]);
  await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE organization_id=$1 AND message_id=$2",[resolved.org,hold]);
  for(const t of [active,disabled,resolved])expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
 });
 it('preserves an uncertain outgoing message and closes only after its receipt is settled',async()=>{
  const t=await fixture(),id=randomUUID();
  await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
   VALUES($1::uuid,$2,$3,$4,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Synthetic"}','UNKNOWN',$1::text,$5)`,[id,t.org,t.channel,t.conversation,'a'.repeat(64)]);
  t.canonical.status='resolved';t.canonical.updated_at++;await t.record();
  expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
  await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1",[id]);
  expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
  await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE organization_id=$1 AND message_id=$2",[t.org,id]);
  const contact=(await db.database.pool.query('SELECT contact_id FROM messaging_conversations WHERE id=$1',[t.conversation])).rows[0].contact_id;
  const next=await db.transact(t.org,tx=>createPostgresMessagingRepository().getOrCreateConversation(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,contactId:contact}));
  expect(next.id).not.toBe(t.conversation);expect(next.mode).toBe('BOT');
  expect(await db.transact(t.org,tx=>settleResolvedPhysicalCycles(tx,t.org))).toBe(0);
 });
});
