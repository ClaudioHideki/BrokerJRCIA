import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createHistoryImportStore} from '../../src/modules/history-import/store.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import type {HistoryRecord,HistoryScope} from '../../src/modules/history-import/contract.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
const now=new Date('2026-10-17T12:00:00.000Z');
async function fixture(total=2){
 const t=await seedAttendanceTenant(db.database,false);
 const scope:HistoryScope={organizationId:t.org,channelId:t.channel,sourceRevision:1,sourceFingerprint:'a'.repeat(64)};
 const records=Array.from({length:total},(_,ordinal)=>({ordinal,providerMessageId:`snapshot-${ordinal}`,remoteJid:'15550000001@s.whatsapp.net',
   fromMe:ordinal%2===0,messageTimestamp:1792234800,text:`Historical ${ordinal}`,displayName:null}));
 const pageDigests=[];for(let i=0;i<total;i+=100)pageDigests.push(createHash('sha256').update(JSON.stringify(records.slice(i,i+100))).digest('hex'));
 const manifest={schemaVersion:1,snapshotId:randomUUID(),...scope,from:'2026-10-17T10:00:00.000Z',to:'2026-10-17T12:00:00.000Z',
   expiresAt:'2026-10-18T12:00:00.000Z',totalRecords:total,pageSize:100,pageDigests};
 let fail=false,revoked=false,writes=0;
 let entered:(()=>void)|undefined,writeGate:Promise<void>|undefined;
 const persist=async(tx:TenantTransaction,items:HistoryRecord[])=>{
  writes++;entered?.();await writeGate;let imported=0;
  for(const item of items){
   const result=await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [randomUUID(),t.org,t.channel,t.conversation,item.fromMe?'OUTGOING':'INCOMING',item.fromMe?'EXTERNAL_OBSERVED':'CONTACT',
     item.providerMessageId,{type:'TEXT',text:item.text},item.fromMe?'SENT':'DELIVERED',new Date(item.messageTimestamp*1000)]);
   imported+=result.rowCount??0;
  }
  if(fail)throw new Error('SYNTHETIC_ROLLBACK_AFTER_HISTORY');
  return{imported,duplicates:items.length-imported};
 };
 const service=()=>createHistoryImportStore({transact:db.transact,assertCurrentScope:async(_tx:TenantTransaction,s:HistoryScope)=>{
  if(revoked||s.sourceRevision!==scope.sourceRevision||s.sourceFingerprint!==scope.sourceFingerprint)throw new Error('HISTORY_SOURCE_CHANGED');
 },persistHistoricalPage:persist});
 const page=(start=0)=>({schemaVersion:1,snapshotId:manifest.snapshotId,startOrdinal:start,records:records.slice(start,start+100)});
 const read=()=>db.transact(t.org,async tx=>({messages:(await tx.query('SELECT id FROM messaging_messages WHERE channel_id=$1',[t.channel])).rows,
  jobs:(await tx.query('SELECT * FROM messaging_bot_jobs WHERE conversation_id=$1',[t.conversation])).rows,
  outbox:(await tx.query('SELECT o.* FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE m.channel_id=$1',[t.channel])).rows}));
 const pauseWrite=()=>{let release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  writeGate=new Promise<void>(resolve=>{release=resolve;});return{started,release};};
 return{...t,scope,manifest,records,page,service,read,pauseWrite,setFail:(v:boolean)=>{fail=v;},revoke:()=>{revoked=true;},writes:()=>writes};
}
describe('durable history import ledger',()=>{
 it('creates exactly one durable job for concurrent retries of the same approved request',async()=>{
  const f=await fixture(),request=randomUUID();
  const [a,b]=await Promise.all([f.service().start(f.scope,request,f.manifest,1000,now),f.service().start(f.scope,request,f.manifest,1000,now)]);
  expect(a.id).toBe(b.id);expect(a).toMatchObject({state:'OPEN',nextOrdinal:0});
  expect(await f.service().get(f.org,a.id)).toMatchObject({id:a.id,manifest:f.manifest});
 });
 it('refuses request-key reuse for another immutable snapshot',async()=>{
  const f=await fixture(),request=randomUUID();await f.service().start(f.scope,request,f.manifest,1000,now);
  await expect(f.service().start(f.scope,request,{...f.manifest,snapshotId:randomUUID()},1000,now)).rejects.toThrow('HISTORY_IMPORT_REQUEST_CONFLICT');
 });
 it('commits history and its checkpoint together, then replays without applying again',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  const first=await f.service().applyPage(f.org,job.id,f.page(),now);
  expect(first).toMatchObject({replayed:false,job:{state:'COMPLETED',nextOrdinal:2,importedCount:2,duplicateCount:0}});
  expect(await f.service().applyPage(f.org,job.id,f.page(),now)).toMatchObject({replayed:true});
  expect(f.writes()).toBe(1);expect(await f.read()).toMatchObject({messages:expect.any(Array),jobs:[],outbox:[]});
  expect((await f.read()).messages).toHaveLength(2);
 });
 it('rolls back both history and checkpoint after an injected persistence failure',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);f.setFail(true);
  await expect(f.service().applyPage(f.org,job.id,f.page(),now)).rejects.toThrow('SYNTHETIC_ROLLBACK_AFTER_HISTORY');
  expect((await f.read()).messages).toEqual([]);expect(await f.service().get(f.org,job.id)).toMatchObject({nextOrdinal:0,state:'OPEN'});
  f.setFail(false);expect(await f.service().applyPage(f.org,job.id,f.page(),now)).toMatchObject({replayed:false,job:{nextOrdinal:2}});
 });
 it('serializes two workers on one checkpoint with only one historical write',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  const result=await Promise.all([f.service().applyPage(f.org,job.id,f.page(),now),f.service().applyPage(f.org,job.id,f.page(),now)]);
  expect(result.map(r=>r.replayed).sort()).toEqual([false,true]);expect(f.writes()).toBe(1);
 });
 it('persists cancellation across a new service instance and does not apply another page',async()=>{
  const f=await fixture(101),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  await f.service().applyPage(f.org,job.id,f.page(),now);await f.service().cancel(f.org,job.id);
  expect(await f.service().get(f.org,job.id)).toMatchObject({state:'CANCELED',nextOrdinal:100});
  await expect(f.service().applyPage(f.org,job.id,f.page(100),now)).rejects.toThrow('HISTORY_IMPORT_CANCELED');
  expect((await f.read()).messages).toHaveLength(100);
 });
 it('resumes from a durable checkpoint after replacing the service process',async()=>{
  const f=await fixture(101),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  await f.service().applyPage(f.org,job.id,f.page(),now);
  const restarted=f.service();expect(await restarted.get(f.org,job.id)).toMatchObject({state:'OPEN',nextOrdinal:100});
  expect(await restarted.applyPage(f.org,job.id,f.page(100),now)).toMatchObject({job:{state:'COMPLETED',nextOrdinal:101}});
  expect(await restarted.cancel(f.org,job.id)).toMatchObject({state:'COMPLETED'});
 });
 it('rejects changed source authority or page contents before writing history',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  await expect(f.service().applyPage(f.org,job.id,{...f.page(),records:[{...f.records[0],text:'changed'},f.records[1]]},now)).rejects.toThrow('HISTORY_PAGE_DIGEST_MISMATCH');
  f.revoke();await expect(f.service().applyPage(f.org,job.id,f.page(),now)).rejects.toThrow('HISTORY_SOURCE_CHANGED');
  expect(f.writes()).toBe(0);expect((await f.read()).messages).toEqual([]);
 });
 it('does not reveal, cancel or apply another tenants job even with the same provider IDs',async()=>{
  const a=await fixture(),b=await fixture(),job=await a.service().start(a.scope,randomUUID(),a.manifest,1000,now);
  expect(await a.service().get(b.org,job.id)).toBeNull();
  await expect(a.service().cancel(b.org,job.id)).rejects.toThrow('HISTORY_IMPORT_NOT_FOUND');
  await expect(a.service().applyPage(b.org,job.id,a.page(),now)).rejects.toThrow('HISTORY_IMPORT_NOT_FOUND');
  expect(a.writes()).toBe(0);
 });
 it('rejects checkpoint advancement without a committed receipt at the database boundary',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  await expect(db.transact(f.org,tx=>tx.query("UPDATE history_import_jobs SET next_ordinal=2,imported_count=2,state='COMPLETED',revision=revision+1 WHERE id=$1",[job.id])))
   .rejects.toThrow('HISTORY_IMPORT_CHECKPOINT_WITHOUT_RECEIPT');
  expect(await f.service().get(f.org,job.id)).toMatchObject({nextOrdinal:0,state:'OPEN'});
 });
 it('deduplicates overlapping snapshots without suppressing another tenants history',async()=>{
  const a=await fixture(),b=await fixture();
  const first=await a.service().start(a.scope,randomUUID(),a.manifest,1000,now);
  await a.service().applyPage(a.org,first.id,a.page(),now);
  const second=await a.service().start(a.scope,randomUUID(),{...a.manifest,snapshotId:randomUUID()},1000,now);
  expect(await a.service().applyPage(a.org,second.id,{...a.page(),snapshotId:second.manifest.snapshotId},now))
   .toMatchObject({job:{importedCount:0,duplicateCount:2,state:'COMPLETED'}});
  const other=await b.service().start(b.scope,randomUUID(),b.manifest,1000,now);
  expect(await b.service().applyPage(b.org,other.id,b.page(),now)).toMatchObject({job:{importedCount:2,duplicateCount:0}});
 });

 it('lets the page holding the row lock finish before cancellation and blocks the following page',async()=>{
  const f=await fixture(101),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now),barrier=f.pauseWrite();
  const applying=f.service().applyPage(f.org,job.id,f.page(),now);await barrier.started;
  const canceling=f.service().cancel(f.org,job.id);barrier.release();
  expect(await applying).toMatchObject({job:{state:'OPEN',nextOrdinal:100}});
  expect(await canceling).toMatchObject({state:'CANCELED',nextOrdinal:100});
  await expect(f.service().applyPage(f.org,job.id,f.page(100),now)).rejects.toThrow('HISTORY_IMPORT_CANCELED');
  expect(f.writes()).toBe(1);expect((await f.read()).messages).toHaveLength(100);
 });
 it('rejects a waiting page when cancellation already owns the transaction lock',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  let acquired!:()=>void,release!:()=>void;
  const locked=new Promise<void>(resolve=>{acquired=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const canceling=db.transact(f.org,async tx=>{
   await tx.query('SELECT id FROM history_import_jobs WHERE id=$1 FOR UPDATE',[job.id]);
   await tx.query("UPDATE history_import_jobs SET state='CANCELED',revision=revision+1 WHERE id=$1",[job.id]);acquired();await gate;
  });
  await locked;const applying=f.service().applyPage(f.org,job.id,f.page(),now);release();await canceling;
  await expect(applying).rejects.toThrow('HISTORY_IMPORT_CANCELED');expect(f.writes()).toBe(0);
  expect((await f.read()).messages).toEqual([]);
 });

 it('rejects creation of an already advanced checkpoint without importing any history',async()=>{
  const f=await fixture();
  await expect(db.transact(f.org,tx=>tx.query(
   "INSERT INTO history_import_jobs(organization_id,id,channel_id,request_id,manifest,fingerprint,max_records,total_records,next_ordinal,imported_count,state) VALUES($1,$2,$3,$4,$5,$6,1000,2,2,2,'COMPLETED')",
   [f.org,randomUUID(),f.channel,randomUUID(),f.manifest,'a'.repeat(64)]))).rejects.toThrow('HISTORY_IMPORT_INVALID_INITIAL_STATE');
 });
 it('rejects a receipt committed without advancing the same historical checkpoint',async()=>{
  const f=await fixture(),job=await f.service().start(f.scope,randomUUID(),f.manifest,1000,now);
  await expect(db.transact(f.org,tx=>tx.query(
   'INSERT INTO history_import_pages(organization_id,channel_id,import_id,start_ordinal,next_ordinal,checksum,imported_count,duplicate_count) VALUES($1,$2,$3,0,2,$4,2,0)',
   [f.org,f.channel,job.id,f.manifest.pageDigests[0]]))).rejects.toThrow('HISTORY_IMPORT_RECEIPT_WITHOUT_CHECKPOINT');
  expect(await f.service().applyPage(f.org,job.id,f.page(),now)).toMatchObject({replayed:false,job:{nextOrdinal:2}});
 });

 it('completes an empty immutable snapshot without calling the historical writer',async()=>{
  const f=await fixture(0),request=randomUUID(),job=await f.service().start(f.scope,request,f.manifest,1000,now);
  expect(job).toMatchObject({state:'COMPLETED',nextOrdinal:0,importedCount:0,duplicateCount:0});
  expect((await f.service().start(f.scope,request,f.manifest,1000,now)).id).toBe(job.id);
  expect(await f.service().cancel(f.org,job.id)).toMatchObject({state:'COMPLETED'});expect(f.writes()).toBe(0);
 });
});
