import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {requireExclusiveLab} from './helpers/exclusive-lab.js';
import {createPartnerEventService} from '../../src/modules/partner-events/service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {claimDelivery,settleDelivery} from '../../src/modules/partner-events/worker.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{
 const raw=process.env.TEST_DATABASE_ADMIN_URL;
 requireExclusiveLab(raw,process.env.TEST_PARTNER_REPLAY_EXCLUSIVE_CLUSTER,'PARTNER_REPLAY');
 db=await attendanceDatabase();
 if(!(await db.database.pool.query("SELECT to_regclass('public.partner_delivery_replays') AS name")).rows[0]!.name){
  const migration=await readFile(new URL('../../drizzle/migrations/0077_partner_delivery_replay.sql',import.meta.url),'utf8');
  await withGlobalRoleLock(raw,()=>db.database.pool.query(migration).then(()=>{}));
 }
},60_000);
afterAll(async()=>{await db?.dispose();});
const service=()=>createPartnerEventService({transact:db.transact,secrets:createIntegrationSecrets(Buffer.alloc(32,7).toString('base64'))});
async function waitForReplayLock(){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const waiting=(await db.database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT partner_replay_delivery%') AS waiting")).rows[0]!.waiting;
  if(waiting)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('REPLAY_DID_NOT_WAIT_FOR_EXPECTED_LOCK');
}
async function fixture(){
 const t=await seedAttendanceTenant(db.database,false),key=randomUUID(),message=randomUUID();
 await db.database.pool.query(`INSERT INTO api_keys(id,organization_id,name,prefix,key_hmac,scopes) VALUES($1,$2,'Synthetic replay',$3,$4,ARRAY['webhooks:manage'])`,[key,t.org,randomUUID(),'c'.repeat(64)]);
 const endpoint=(await service().create(t.org,{url:'https://synthetic.example.test/hook'},randomUUID())).endpoint.id;
 await db.transact(t.org,tx=>tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"synthetic"}','DELIVERED')`,[message,t.org,t.channel,t.conversation]));
 await service().events(t.org,{limit:100});
 const delivery=(await service().deliveries(t.org,{limit:100})).data[0]!;
 await db.database.pool.query(`UPDATE partner_event_deliveries SET status='FAILED',attempts=10,last_error_code='HTTP_503' WHERE organization_id=$1 AND id=$2`,[t.org,delivery.id]);
 return {...t,key,endpoint,delivery:delivery.id,event:delivery.eventId,message};
}
it('serializes concurrent replay, preserves identity/evidence and does not change source messages',async()=>{
 const t=await fixture(),idem=randomUUID();
 const all=await Promise.all(Array.from({length:4},()=>service().replay(t.org,t.key,t.delivery,idem)));
 expect(new Set(all.map(r=>r.replay.id)).size).toBe(1);expect(all.filter(r=>!r.replayed)).toHaveLength(1);
 expect(all[0]!.replay).toMatchObject({eventId:t.event,deliveryId:t.delivery,endpointId:t.endpoint,priorAttempts:10,replayNumber:1});
 expect((await service().deliveries(t.org,{limit:100})).data[0]).toMatchObject({id:t.delivery,status:'PENDING',attempts:0});
 expect(await service().deliveryStats(t.org,t.key,{})).toMatchObject({counts:{PENDING:1},replays:1,lifetimeAttempts:10});
 expect((await db.database.pool.query('SELECT prior_attempts,prior_error_code FROM partner_delivery_replays WHERE organization_id=$1',[t.org])).rows).toEqual([{prior_attempts:10,prior_error_code:'HTTP_503'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_messages WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
 // Lost response retried after a worker has already started must not reset again.
 const claim=(await db.transact(t.org,tx=>claimDelivery(tx,t.org)))!;
 expect((await service().replay(t.org,t.key,t.delivery,idem)).replayed).toBe(true);
 expect((await service().deliveries(t.org,{limit:100})).data[0]).toMatchObject({status:'RUNNING',attempts:1});
 await db.transact(t.org,tx=>settleDelivery(tx,claim,{status:'FAILED',attempts:1,errorCode:'HTTP_403',delayMs:0}));
 const next=await service().replay(t.org,t.key,t.delivery,randomUUID());expect(next.replay).toMatchObject({priorAttempts:1,replayNumber:2});
 expect(await service().deliveryStats(t.org,t.key,{endpointId:t.endpoint})).toMatchObject({replays:2,lifetimeAttempts:11});
});
it('rejects conflicting UUID, cross tenant, active delivery, expired event and revoked endpoint',async()=>{
 const t=await fixture(),other=await fixture(),idem=randomUUID();await service().replay(t.org,t.key,t.delivery,idem);
 await expect(service().replay(t.org,t.key,t.delivery,randomUUID())).rejects.toMatchObject({code:'PARTNER_DELIVERY_NOT_FAILED'});
 await expect(service().replay(t.org,t.key,other.delivery,idem)).rejects.toMatchObject({code:'PARTNER_REPLAY_CONFLICT'});
 await expect(service().replay(other.org,other.key,t.delivery,randomUUID())).rejects.toMatchObject({code:'PARTNER_DELIVERY_NOT_FOUND'});
 expect((await db.transact(other.org,tx=>tx.query('SELECT id FROM partner_delivery_replays'))).rows).toEqual([]);
 await db.database.pool.query("UPDATE partner_events SET occurred_at=now()-interval '31 days' WHERE organization_id=$1",[t.org]);
 await expect(service().replay(t.org,t.key,t.delivery,idem)).rejects.toMatchObject({code:'PARTNER_EVENT_EXPIRED'});
 await service().revoke(other.org,other.endpoint);
 await expect(service().replay(other.org,other.key,other.delivery,randomUUID())).rejects.toMatchObject({code:'PARTNER_ENDPOINT_REVOKED'});
});
it('rejects stale settlement from an earlier cycle and SQL attempt reset/ledger mutation',async()=>{
 const t=await fixture();await service().replay(t.org,t.key,t.delivery,randomUUID());
 const stale=(await db.transact(t.org,tx=>claimDelivery(tx,t.org)))!;
 await db.database.pool.query(`UPDATE partner_event_deliveries SET status='FAILED',lease_token=NULL,lease_expires_at=NULL WHERE organization_id=$1 AND id=$2`,[t.org,t.delivery]);
 await service().replay(t.org,t.key,t.delivery,randomUUID());const fresh=(await db.transact(t.org,tx=>claimDelivery(tx,t.org)))!;
 await db.transact(t.org,tx=>settleDelivery(tx,stale,{status:'DELIVERED',attempts:1,errorCode:null,delayMs:0}));
 expect((await service().deliveries(t.org,{limit:100})).data[0]).toMatchObject({status:'RUNNING',attempts:1});expect(fresh.leaseToken).not.toBe(stale.leaseToken);
 await expect(db.transact(t.org,tx=>tx.query('UPDATE partner_event_deliveries SET attempts=0 WHERE organization_id=$1 AND id=$2',[t.org,t.delivery]))).rejects.toMatchObject({code:'23514'});
 await db.transact(t.org,tx=>settleDelivery(tx,fresh,{status:'FAILED',attempts:1,errorCode:'HTTP_403',delayMs:0}));
 // Keeping attempts unchanged must not bypass the explicit replay ledger either.
 await expect(db.transact(t.org,tx=>tx.query("UPDATE partner_event_deliveries SET status='PENDING' WHERE organization_id=$1 AND id=$2",[t.org,t.delivery]))).rejects.toMatchObject({code:'23514'});
 for(const sql of ['UPDATE partner_delivery_replays SET prior_attempts=0','DELETE FROM partner_delivery_replays','INSERT INTO partner_delivery_replays(organization_id) VALUES($1)'])await expect(db.transact(t.org,tx=>tx.query(sql,sql.includes('$1')?[t.org]:[]))).rejects.toMatchObject({code:'42501'});
});
it('aggregates all statuses, oldest availability, expired leases and endpoint isolation without content',async()=>{
 const t=await fixture(),other=await fixture(),oldest='2026-10-01T00:00:00.000Z';
 for(const status of ['PENDING','RUNNING','DELIVERED','CANCELLED']){
  const event=randomUUID();
  await db.database.pool.query("INSERT INTO partner_events(organization_id,id,event_type,payload) VALUES($1,$2,'message.received','{\"private\":\"synthetic-payload\"}')",[t.org,event]);
  await db.database.pool.query(`INSERT INTO partner_event_deliveries(organization_id,endpoint_id,event_id,status,attempts,lifetime_attempts,available_at,lease_token,lease_expires_at)
   VALUES($1,$2,$3,$4,3,3,$5,CASE WHEN $4='RUNNING' THEN gen_random_uuid() ELSE NULL END,CASE WHEN $4='RUNNING' THEN now()-interval '1 second' ELSE NULL END)`,[t.org,t.endpoint,event,status,oldest]);
 }
 const stats=await service().deliveryStats(t.org,t.key,{endpointId:t.endpoint});
 expect(stats).toEqual({schemaVersion:1,retentionDays:30,counts:{PENDING:1,RUNNING:1,DELIVERED:1,FAILED:1,CANCELLED:1},oldestPendingAt:oldest,expiredLeases:1,replays:0,lifetimeAttempts:22});
 expect(JSON.stringify(stats)).not.toMatch(/synthetic-payload|https:|encrypted|api_key/);
 expect((await service().deliveryStats(t.org,t.key,{endpointId:other.endpoint})).counts).toEqual({PENDING:0,RUNNING:0,DELIVERED:0,FAILED:0,CANCELLED:0});
 await db.database.pool.query("UPDATE partner_events SET occurred_at=now()-interval '31 days' WHERE organization_id=$1",[t.org]);
 expect((await service().deliveryStats(t.org,t.key,{})).lifetimeAttempts).toBe(0);
});
it('requires current webhooks scope and refuses control-bound keys even with webhooks scope',async()=>{
 const t=await fixture();
 for(const clause of ["scopes=ARRAY['messaging:read']","scopes=ARRAY['webhooks:manage'],expires_at=now()-interval '1 second'","expires_at=NULL,revoked_at=now()"]){
  await db.database.pool.query(`UPDATE api_keys SET ${clause} WHERE id=$1`,[t.key]);
  await expect(service().replay(t.org,t.key,t.delivery,randomUUID())).rejects.toMatchObject({code:'PARTNER_REPLAY_FORBIDDEN'});
  await expect(service().deliveryStats(t.org,t.key,{})).rejects.toMatchObject({code:'PARTNER_REPLAY_FORBIDDEN'});
 }
 await db.database.pool.query("UPDATE api_keys SET revoked_at=NULL,expires_at=NULL,scopes=ARRAY['webhooks:manage'] WHERE id=$1",[t.key]);
 await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,'https://synthetic.example.test',7,'READY')",[t.org]);
 await db.database.pool.query('INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,7,1)',[t.key,t.org]);
 await expect(service().replay(t.org,t.key,t.delivery,randomUUID())).rejects.toMatchObject({code:'PARTNER_REPLAY_FORBIDDEN'});
});
it('revalidates wall clock expiry after waiting on delivery locks',async()=>{
 const t=await fixture(),blocker=await db.database.pool.connect();let pending:Promise<unknown>|undefined;
 try{
  const expiry=(await db.database.pool.query("UPDATE api_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at",[t.key])).rows[0]!.expires_at;
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM partner_event_deliveries WHERE id=$1 FOR UPDATE',[t.delivery]);
  pending=service().replay(t.org,t.key,t.delivery,randomUUID()).then(()=>({accepted:true}),error=>error);
  await waitForReplayLock();
  const deadline=Date.now()+5000;
  while(!(await db.database.pool.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[expiry])).rows[0]!.expired){
   if(Date.now()>deadline)throw Error('LAB_CLOCK_DID_NOT_REACH_EXPIRY');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  await blocker.query('COMMIT');
  expect(await pending).toMatchObject({code:'PARTNER_REPLAY_FORBIDDEN'});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM partner_delivery_replays WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
it('lets endpoint revocation win while replay waits for its lock',async()=>{
 const t=await fixture(),blocker=await db.database.pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query("UPDATE partner_webhook_endpoints SET status='REVOKED',encrypted_secret=NULL,revoked_at=now() WHERE id=$1",[t.endpoint]);
  pending=service().replay(t.org,t.key,t.delivery,randomUUID()).then(()=>({accepted:true}),error=>error);
  await waitForReplayLock();await blocker.query('COMMIT');expect(await pending).toMatchObject({code:'PARTNER_ENDPOINT_REVOKED'});
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
it('prunes replay ledger with the event at 30 days and preserves another tenant',async()=>{
 const t=await fixture(),other=await fixture();await service().replay(t.org,t.key,t.delivery,randomUUID());await service().replay(other.org,other.key,other.delivery,randomUUID());
 await db.database.pool.query("UPDATE partner_events SET occurred_at=now()-interval '31 days' WHERE organization_id=$1",[t.org]);
 await db.transact(t.org,tx=>tx.query('SELECT partner_publish_events()'));
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM partner_delivery_replays WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM partner_delivery_replays WHERE organization_id=$1',[other.org])).rows[0].n).toBe(1);
});
