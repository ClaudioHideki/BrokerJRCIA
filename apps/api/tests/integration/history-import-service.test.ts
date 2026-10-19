import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createHistoryImportService} from '../../src/modules/history-import/service.js';
import type {HistorySnapshotSource} from '../../src/modules/history-import/types.js';
import {createPostgresHistorySource} from '../../src/modules/history-import/postgres-source.js';
import {Pool} from 'pg';
import {createHistoryImportWorker} from '../../src/modules/history-import/worker.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
const now=new Date('2026-10-19T12:00:00.000Z');
async function fixture(){
 const tenant=await seedAttendanceTenant(db.database,false);
 const {instance,channel,actor}=await db.transact(tenant.org,async tx=>{
  const actor=(await tx.query<{user_id:string}>("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[tenant.org])).rows[0]!.user_id;
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic source') RETURNING id",[tenant.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic',$3,'CONNECTED') RETURNING id",[tenant.org,provider,randomUUID()])).rows[0].id;
  const channel=(await ensureQrChannel(tx,tenant.org,instance)).id;
  await tx.query("INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,upstream_instance_key,owner_fingerprint,binding_fingerprint) SELECT $1,$2,id,upstream_instance_key,$3,$4 FROM instances WHERE organization_id=$1 AND id=$5",[tenant.org,channel,'a'.repeat(64),'b'.repeat(64),instance]);
  await tx.query('UPDATE qr_identity_scopes SET updated_at=$1 WHERE channel_id=$2',['2026-10-01T00:00:00Z',channel]);
  return{instance,channel,actor};
 });
 const selection={from:'2026-10-01T00:00:00.000Z',to:'2026-10-19T12:00:00.000Z',maxRecords:100};
 const records=[{ordinal:0,providerMessageId:'synthetic-history',remoteJid:'15550000001@s.whatsapp.net',fromMe:false,messageTimestamp:1792407600,text:'Synthetic history',displayName:null}];
 let reads=0,creates=0,changeAfterRead:(()=>Promise<void>)|undefined;
 const source:HistorySnapshotSource={capability:async()=>({available:true,maxRecords:100}),
  createSnapshot:async(scope,chosen,requestId)=>{creates++;return{schemaVersion:1,snapshotId:requestId,
   organizationId:scope.organizationId,channelId:scope.channelId,sourceRevision:scope.sourceRevision,sourceFingerprint:scope.sourceFingerprint,
   from:chosen.from,to:chosen.to,expiresAt:'2026-10-20T00:00:00.000Z',totalRecords:1,pageSize:100,pageDigests:[createHash('sha256').update(JSON.stringify(records)).digest('hex')]};},
  readPage:async(_scope,snapshot,startOrdinal)=>{reads++;await changeAfterRead?.();return{schemaVersion:1,snapshotId:snapshot.snapshotId,startOrdinal,records};}};
 const service=()=>createHistoryImportService({transact:db.transact,source,now:()=>now});
 return{...tenant,instance,channel,actor,selection,source,service,stats:()=>({reads,creates}),onRead:(fn:()=>Promise<void>)=>{changeAfterRead=fn;}};
}
describe('history application with real ledger and QR writer',()=>{
 it('exposes the verified identity boundary and refuses an older provider cache range',async()=>{
  const f=await fixture();
  await db.database.pool.query('UPDATE qr_identity_scopes SET updated_at=$1 WHERE channel_id=$2',['2026-10-10T12:00:00Z',f.channel]);
  expect(await f.service().capability(f.org,f.actor,f.instance)).toMatchObject({availableFrom:'2026-10-10T12:00:00.000Z'});
  await expect(f.service().start(f.org,f.actor,f.instance,f.selection,randomUUID())).rejects.toMatchObject({code:'HISTORY_SOURCE_IDENTITY_RANGE'});
  expect(f.stats()).toEqual({reads:0,creates:0});
 });
 it('maps the public instance ID to its tenant channel and resumes after replacement without bot effects',async()=>{
  const f=await fixture(),requestId=randomUUID();const service=f.service();
  expect(await service.capability(f.org,f.actor,f.instance)).toMatchObject({channelId:f.instance,available:true});
  const job=await service.start(f.org,f.actor,f.instance,f.selection,requestId);
  expect(job).toMatchObject({channelId:f.instance,state:'OPEN',processedRecords:0});
  expect(await f.service().byRequest(f.org,f.actor,f.instance,requestId)).toEqual(job);
  expect(await f.service().start(f.org,f.actor,f.instance,f.selection,requestId)).toEqual(job);
  const done=await f.service().advance(f.org,f.actor,f.instance,job.id);
  expect(done).toMatchObject({state:'COMPLETED',processedRecords:1,importedCount:1,duplicateCount:0});
  expect(await f.service().advance(f.org,f.actor,f.instance,job.id)).toEqual(done);expect(f.stats()).toEqual({reads:1,creates:1});
  const stored=await db.transact(f.org,async tx=>({messages:(await tx.query('SELECT channel_id,direction FROM messaging_messages WHERE channel_id=$1',[f.channel])).rows,
   jobs:(await tx.query('SELECT * FROM messaging_bot_jobs WHERE organization_id=$1',[f.org])).rows,outbox:(await tx.query('SELECT * FROM messaging_outbox WHERE organization_id=$1',[f.org])).rows}));
  expect(stored).toEqual({messages:[{channel_id:f.channel,direction:'INCOMING'}],jobs:[],outbox:[]});
 });
 it('cancels durably and refuses another channel, another tenant and a conflicting request key',async()=>{
  const a=await fixture(),b=await fixture(),requestId=randomUUID();const job=await a.service().start(a.org,a.actor,a.instance,a.selection,requestId);
  await expect(a.service().start(a.org,a.actor,a.instance,{...a.selection,maxRecords:99},requestId)).rejects.toMatchObject({code:'HISTORY_IMPORT_REQUEST_CONFLICT'});
  expect(await a.service().cancel(a.org,a.actor,a.instance,job.id)).toMatchObject({state:'CANCELED'});
  await expect(a.service().advance(a.org,a.actor,a.instance,job.id)).rejects.toMatchObject({code:'HISTORY_IMPORT_CANCELED'});
  await expect(b.service().get(b.org,b.actor,b.instance,job.id)).rejects.toMatchObject({statusCode:404});
  await expect(a.service().get(a.org,a.actor,b.instance,job.id)).rejects.toMatchObject({statusCode:404});expect(a.stats().reads).toBe(0);
 });
 it.each(['identity','membership'] as const)('rolls back when %s changes while fetching a page outside the transaction',async change=>{
  const f=await fixture();const job=await f.service().start(f.org,f.actor,f.instance,f.selection,randomUUID());
  if(change==='membership'){
   const peer=randomUUID();await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",[peer,`${peer}@example.test`]);
   await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[f.org,peer]);
  }
  f.onRead(()=>db.database.pool.query(change==='identity'?'UPDATE qr_identity_scopes SET scope_id=gen_random_uuid() WHERE channel_id=$1':"UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2",change==='identity'?[f.channel]:[f.org,f.actor]).then(()=>{}));
  await expect(f.service().advance(f.org,f.actor,f.instance,job.id)).rejects.toMatchObject({code:change==='identity'?'HISTORY_SNAPSHOT_SCOPE_CHANGED':'FORBIDDEN'});
  const count=await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_messages WHERE channel_id=$1',[f.channel]);expect(count.rows[0].n).toBe(0);
 });
 it('keeps progress and cancellation available after disconnect or identity revocation, without fetching another page',async()=>{
  const f=await fixture(),key=randomUUID();const job=await f.service().start(f.org,f.actor,f.instance,f.selection,key);
  await db.database.pool.query("UPDATE instances SET status='DISCONNECTED' WHERE id=$1",[f.instance]);
  await db.database.pool.query('UPDATE qr_identity_scopes SET owner_fingerprint=NULL WHERE channel_id=$1',[f.channel]);
  expect(await f.service().get(f.org,f.actor,f.instance,job.id)).toEqual(job);
  expect(await f.service().start(f.org,f.actor,f.instance,f.selection,key)).toEqual(job);
  expect(await f.service().cancel(f.org,f.actor,f.instance,job.id)).toMatchObject({state:'CANCELED'});
  expect(f.stats().reads).toBe(0);
 });
 it('imports from a real frozen database source through the complete application after both objects are replaced',async()=>{
  const f=await fixture();await db.database.pool.query('CREATE TABLE "Instance"(id text primary key,name text unique,"ownerJid" text,"connectionStatus" text); CREATE TABLE "Message"(id text primary key,"instanceId" text,key jsonb,"messageTimestamp" integer,message jsonb,"pushName" text,status text)');
  const key=(await db.database.pool.query('SELECT upstream_instance_key FROM instances WHERE id=$1',[f.instance])).rows[0].upstream_instance_key;
  await db.database.pool.query('INSERT INTO "Instance" VALUES($1,$1,$2,\'open\')',[key,'15550000001@s.whatsapp.net']);
  await db.database.pool.query('INSERT INTO "Message" VALUES($1,$2,$3,1792407600,$4,NULL)',[randomUUID(),key,{id:'immutable-synthetic',remoteJid:'15550000002@s.whatsapp.net',fromMe:true},{extendedTextMessage:{text:'Immutable outgoing text'}}]);
  const providerPool=new Pool({connectionString:db.database.connectionString,max:1});
  const service=()=>createHistoryImportService({transact:db.transact,now:()=>now,source:createPostgresHistorySource({transact:db.transact,resolveDatabase:async()=>providerPool,verifyOwner:async(_scope,jid)=>jid==='15550000001@s.whatsapp.net',now:()=>now})});
  try{const job=await service().start(f.org,f.actor,f.instance,f.selection,randomUUID());
   await db.database.pool.query('DELETE FROM "Message" WHERE "instanceId"=$1',[key]);
   expect(await service().advance(f.org,f.actor,f.instance,job.id)).toMatchObject({state:'COMPLETED',importedCount:1,processedRecords:1});
   const rows=await db.database.pool.query('SELECT direction,source,state FROM messaging_messages WHERE channel_id=$1',[f.channel]);
   expect(rows.rows).toEqual([{direction:'OUTGOING',source:'EXTERNAL_OBSERVED',state:'SENT'}]);
  }finally{await providerPool.end();}
 });
 it('processes admitted imports automatically and retains canceled work without historical side effects',async()=>{
  const f=await fixture();const job=await f.service().start(f.org,f.actor,f.instance,f.selection,randomUUID());
  const worker=createHistoryImportWorker({transact:db.transact,service:f.service()});await worker.runOnce(f.org);
  expect(await f.service().get(f.org,f.actor,f.instance,job.id)).toMatchObject({state:'COMPLETED',importedCount:1});
  const canceled=await fixture();const pending=await canceled.service().start(canceled.org,canceled.actor,canceled.instance,canceled.selection,randomUUID());
  canceled.onRead(async()=>{await canceled.service().cancel(canceled.org,canceled.actor,canceled.instance,pending.id);});
  await createHistoryImportWorker({transact:db.transact,service:canceled.service()}).runOnce(canceled.org);
  expect(await canceled.service().get(canceled.org,canceled.actor,canceled.instance,pending.id)).toMatchObject({state:'CANCELED',processedRecords:0});
  expect((await db.database.pool.query('SELECT * FROM messaging_messages WHERE channel_id=$1',[canceled.channel])).rows).toEqual([]);
 });
 it('records a safe failure and backs off without advancing or repeatedly fetching a revoked source',async()=>{
  const f=await fixture();const job=await f.service().start(f.org,f.actor,f.instance,f.selection,randomUUID());
  f.onRead(()=>db.database.pool.query('UPDATE qr_identity_scopes SET scope_id=gen_random_uuid() WHERE channel_id=$1',[f.channel]).then(()=>{}));
  const worker=createHistoryImportWorker({transact:db.transact,service:f.service()});await worker.runOnce(f.org);
  expect(await f.service().get(f.org,f.actor,f.instance,job.id)).toMatchObject({state:'OPEN',processedRecords:0,lastError:'HISTORY_SNAPSHOT_SCOPE_CHANGED'});
  await worker.runOnce(f.org);expect(f.stats().reads).toBe(1);
 });
});
