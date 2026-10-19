import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {persistQrHistoryPage} from '../../src/modules/history-import/qr-writer.js';
import {createHistoryImportStore} from '../../src/modules/history-import/store.js';
import type {HistoryRecord} from '../../src/modules/history-import/contract.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
const now=new Date('2026-10-17T12:00:00.000Z');
async function fixture(){
 const t=await seedAttendanceTenant(db.database,false);
 const {instance,channel}=await db.transact(t.org,async tx=>{
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic import') RETURNING id",[t.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic',$3,'CONNECTED') RETURNING id",[t.org,provider,randomUUID()])).rows[0].id;
  return{instance,channel:(await ensureQrChannel(tx,t.org,instance)).id};
 });
 const records:HistoryRecord[]=[false,true].map((fromMe,ordinal)=>({ordinal,providerMessageId:'historical-'+ordinal,remoteJid:'15550000001@s.whatsapp.net',fromMe,
  messageTimestamp:1792234800+ordinal,text:'Synthetic history '+ordinal,displayName:'Old name'}));
 const scope={organizationId:t.org,channelId:channel,sourceRevision:1,sourceFingerprint:'a'.repeat(64)};
 const manifest={schemaVersion:1,snapshotId:randomUUID(),...scope,from:'2026-10-17T10:00:00.000Z',to:'2026-10-17T12:00:00.000Z',expiresAt:'2026-10-18T12:00:00.000Z',totalRecords:2,pageSize:100,
  pageDigests:[createHash('sha256').update(JSON.stringify(records)).digest('hex')]};
 const page={schemaVersion:1,snapshotId:manifest.snapshotId,startOrdinal:0,records};
 const read=()=>db.transact(t.org,async tx=>({messages:(await tx.query('SELECT * FROM messaging_messages WHERE channel_id=$1 ORDER BY created_at',[channel])).rows,
  conversations:(await tx.query('SELECT * FROM messaging_conversations WHERE channel_id=$1',[channel])).rows,
  jobs:(await tx.query('SELECT j.* FROM messaging_bot_jobs j JOIN messaging_conversations c ON c.organization_id=j.organization_id AND c.id=j.conversation_id WHERE c.channel_id=$1',[channel])).rows,
  outbox:(await tx.query('SELECT o.* FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE m.channel_id=$1',[channel])).rows}));
 const write=(items=records)=>db.transact(t.org,tx=>persistQrHistoryPage(tx,t.org,channel,items));
 const seedAlias=()=>db.transact(t.org,async tx=>{
  const identity=randomUUID();
  await tx.query("INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,scope_id,owner_fingerprint,upstream_instance_key,binding_fingerprint) SELECT $1,$2,id,$3,$4,upstream_instance_key,$4 FROM instances WHERE organization_id=$1 AND id=$5",[t.org,channel,identity,'b'.repeat(64),instance]);
  await tx.query("INSERT INTO qr_contact_aliases(organization_id,channel_id,scope_id,lid,phone) VALUES($1,$2,$3,'123456789@lid','15550000001')",[t.org,channel,identity]);
 });
 return{...t,instance,channel,records,scope,manifest,page,read,write,seedAlias};
}
describe('QR historical writer inside the ledger transaction',()=>{
 it('preserves a source READ acknowledgement on an imported outgoing message',async()=>{
  const f=await fixture();await f.write([{...f.records[1]!,state:'READ'}]);
  expect((await f.read()).messages).toMatchObject([{state:'READ',is_historical:true}]);
 });
 it('preserves IDs, both directions and timestamps while leaving bot and sending outbox empty',async()=>{
  const f=await fixture();expect(await f.write()).toEqual({imported:2,duplicates:0});expect(await f.write()).toEqual({imported:0,duplicates:2});
  const rows=await f.read();expect(rows.messages).toHaveLength(2);expect(rows.jobs).toEqual([]);expect(rows.outbox).toEqual([]);
  expect(rows.messages[0]).toMatchObject({upstream_message_id:'historical-0',direction:'INCOMING',source:'CONTACT',created_at:new Date(f.records[0]!.messageTimestamp*1000)});
  expect(rows.messages.map(row=>row.is_historical)).toEqual([true,true]);
  expect(rows.messages[1]).toMatchObject({upstream_message_id:'historical-1',direction:'OUTGOING',source:'EXTERNAL_OBSERVED',state:'SENT'});
  expect(rows.conversations[0]).toMatchObject({mode:'BOT'});
 });
 it('rolls back real contact, conversation and message writes with the checkpoint after an injected failure',async()=>{
  const f=await fixture();let fail=true;
  const service=()=>createHistoryImportStore({transact:db.transact,assertCurrentScope:async()=>{},persistHistoricalPage:async(tx,items)=>{
   const counts=await persistQrHistoryPage(tx,f.org,f.channel,items);if(fail)throw new Error('INJECTED_AFTER_REAL_HISTORY');return counts;
  }});
  const job=await service().start(f.scope,randomUUID(),f.manifest,100,now);
  await expect(service().applyPage(f.org,job.id,f.page,now)).rejects.toThrow('INJECTED_AFTER_REAL_HISTORY');
  expect(await f.read()).toMatchObject({messages:[],conversations:[],jobs:[],outbox:[]});
  expect(await service().get(f.org,job.id)).toMatchObject({nextOrdinal:0});fail=false;
  expect(await service().applyPage(f.org,job.id,f.page,now)).toMatchObject({job:{state:'COMPLETED',importedCount:2}});
 });
 it('rejects unresolved LID instead of advancing a page whose identity is unknown',async()=>{
  const f=await fixture();await expect(f.write([{...f.records[0]!,remoteJid:'123456789@lid'}])).rejects.toThrow('HISTORY_IDENTITY_UNRESOLVED');
  expect((await f.read()).messages).toEqual([]);
 });
 it('does not write through another tenants channel',async()=>{
  const a=await fixture(),b=await fixture();await expect(db.transact(a.org,tx=>persistQrHistoryPage(tx,b.org,b.channel,b.records))).rejects.toThrow('HISTORY_CHANNEL_UNAVAILABLE');
  expect((await b.read()).messages).toEqual([]);
 });
 it('refuses an archived instance without creating historical facts',async()=>{
  const f=await fixture();await db.database.pool.query('UPDATE instances SET archived_at=now() WHERE id=$1',[f.instance]);
  await expect(f.write()).rejects.toThrow('HISTORY_CHANNEL_UNAVAILABLE');expect((await f.read()).messages).toEqual([]);
 });
 it('does not replace a current contact name with an old snapshot name',async()=>{
  const f=await fixture();await db.transact(f.org,tx=>tx.query("INSERT INTO messaging_contacts(organization_id,external_id,display_name) VALUES($1,'15550000001','Current name')",[f.org]));
  await f.write();expect((await db.transact(f.org,tx=>tx.query("SELECT display_name FROM messaging_contacts WHERE organization_id=$1 AND external_id='15550000001'",[f.org]))).rows[0].display_name).toBe('Current name');
 });
 it('resolves LID only through the current confirmed tenant and instance identity scope',async()=>{
  const f=await fixture();await f.seedAlias();expect(await f.write([{...f.records[0]!,remoteJid:'123456789:2@lid'}])).toEqual({imported:1,duplicates:0});
  const rows=await f.read();expect(rows.messages).toHaveLength(1);expect(rows.jobs).toEqual([]);expect(rows.outbox).toEqual([]);
 });
 it.each(['stale','conflict'] as const)('refuses a %s LID alias without writing a historical message',async kind=>{
  const f=await fixture();await f.seedAlias();await db.transact(f.org,tx=>tx.query(kind==='stale'
   ?'UPDATE qr_identity_scopes SET scope_id=gen_random_uuid() WHERE channel_id=$1'
   :"UPDATE qr_contact_aliases SET status='CONFLICT' WHERE channel_id=$1",[f.channel]));
  await expect(f.write([{...f.records[0]!,remoteJid:'123456789@lid'}])).rejects.toThrow('HISTORY_IDENTITY_UNRESOLVED');expect((await f.read()).messages).toEqual([]);
 });

 it('serializes two imports on the same channel without promoting shared instance locks',async()=>{
  const f=await fixture();let promoted=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const apply=()=>db.transact(f.org,tx=>persistQrHistoryPage(new Proxy(tx,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return async(sql:string,...args:unknown[])=>{
    if(sql.startsWith('SELECT id FROM instances')&&sql.includes('FOR UPDATE')){if(++promoted===2)release();await barrier;}
    return (target.query as (...args:unknown[])=>Promise<unknown>)(sql,...args);
   };
  }}),f.org,f.channel,f.records));
  const results=await Promise.allSettled([apply(),apply()]);expect(results.filter(r=>r.status==='rejected').map(r=>({code:r.reason.code,message:r.reason.message}))).toEqual([]);
  expect(results.filter(r=>r.status==='fulfilled').map(r=>r.value.imported).sort()).toEqual([0,2]);
  expect((await f.read()).messages).toHaveLength(2);
 });

});
