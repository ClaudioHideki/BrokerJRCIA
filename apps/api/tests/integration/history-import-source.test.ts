import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createPostgresHistorySource} from '../../src/modules/history-import/postgres-source.js';
import type {HistorySnapshot} from '../../src/modules/history-import/contract.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>,sourcePool:Pool;
beforeAll(async()=>{db=await attendanceDatabase();sourcePool=new Pool({connectionString:db.database.connectionString,max:1});
 await db.database.pool.query('CREATE TABLE "Instance"(id text primary key,name text unique,"ownerJid" text,"connectionStatus" text); CREATE TABLE "Message"(id text primary key,"instanceId" text,key jsonb,"messageTimestamp" integer,message jsonb,"pushName" text,status text)');
});afterAll(async()=>{await sourcePool?.end();await db?.dispose();});
const now=new Date('2026-10-19T12:00:00.000Z');
async function fixture(){
 const tenant=await seedAttendanceTenant(db.database,false),key=randomUUID();
 const channel=await db.transact(tenant.org,async tx=>{const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic') RETURNING id",[tenant.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic',$3,'CONNECTED') RETURNING id",[tenant.org,provider,key])).rows[0].id;
  return(await ensureQrChannel(tx,tenant.org,instance)).id;});
 await db.database.pool.query('INSERT INTO "Instance" VALUES($1,$1,$2,\'open\')',[key,'15550000001@s.whatsapp.net']);
 const scope={organizationId:tenant.org,channelId:channel,instanceId:key,instanceKey:key,sourceRevision:1,sourceFingerprint:'a'.repeat(64)};
 const selection={from:'2026-10-01T00:00:00.000Z',to:'2026-10-19T12:00:00.000Z',maxRecords:100};
 const insert=async(id:string,text:string,instance=key)=>db.database.pool.query('INSERT INTO "Message" VALUES($1,$2,$3,1792407600,$4,NULL)',[`${key}-${id}`,instance,{id,remoteJid:'15550000002@s.whatsapp.net',fromMe:false},{conversation:text}]);
 const source=()=>createPostgresHistorySource({transact:db.transact,resolveDatabase:async()=>sourcePool,verifyOwner:async(_scope,owner)=>owner==='15550000001@s.whatsapp.net',now:()=>now});
 return{...tenant,key,channel,scope,selection,source,insert};
}
describe('immutable Evolution database snapshot',()=>{
 it('freezes the provider acknowledgement with the record instead of treating every outgoing message as merely sent',async()=>{
  const f=await fixture();await f.insert('read','Already read');
  await db.database.pool.query('UPDATE "Message" SET status=\'READ\' WHERE id=$1',[`${f.key}-read`]);
  const source=f.source(),manifest=await source.createSnapshot(f.scope,f.selection,randomUUID()) as HistorySnapshot;
  expect(await source.readPage(f.scope,manifest,0)).toMatchObject({records:[{state:'READ'}]});
 });
 it('keeps the same database snapshot when new messages and edits arrive during capture',async()=>{
  const f=await fixture();await f.insert('a','original');
  let reached!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{reached=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const source=createPostgresHistorySource({transact:db.transact,resolveDatabase:async()=>sourcePool,now:()=>now,
   verifyOwner:async()=>{reached();await hold;return true;}});
  const capturing=source.createSnapshot(f.scope,f.selection,randomUUID());
  try{await ready;await f.insert('b','arrived during capture');await db.database.pool.query('UPDATE "Message" SET message=$1 WHERE id=$2',[{conversation:'edited during capture'},`${f.key}-a`]);}
  finally{release();}
  const manifest=await capturing as HistorySnapshot;
  expect(manifest.totalRecords).toBe(1);
  expect(await source.readPage(f.scope,manifest,0)).toMatchObject({records:[{providerMessageId:'a',text:'original'}]});
 });
 it('rejects excess simultaneous exports before opening another provider connection and releases admission afterwards',async()=>{
  const f=await fixture();let reached!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{reached=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const source=createPostgresHistorySource({transact:db.transact,resolveDatabase:async()=>sourcePool,now:()=>now,
   verifyOwner:async()=>{reached();await hold;return true;}});
  const first=source.createSnapshot(f.scope,f.selection,randomUUID());await ready;
  const second=source.createSnapshot(f.scope,f.selection,randomUUID());
  const third=source.createSnapshot(f.scope,f.selection,randomUUID()).then(()=> 'ACCEPTED',error=>error.code);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{expect(await Promise.race([third,new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('NOT_REJECTED'),1000);})])).toBe('HISTORY_SOURCE_BUSY');}
  finally{if(timer)clearTimeout(timer);release();await Promise.all([first,second,third]);}
  expect(await source.createSnapshot(f.scope,f.selection,randomUUID())).toMatchObject({totalRecords:0});
 });
 it('freezes deterministically tied timestamps and survives source replacement, updates and new arrivals',async()=>{
  const f=await fixture();await f.insert('b','second');await f.insert('a','first');const requestId=randomUUID();
  const manifest=await f.source().createSnapshot(f.scope,f.selection,requestId) as HistorySnapshot;
  await f.insert('c','new');await db.database.pool.query('UPDATE "Message" SET message=$1 WHERE id=$2',[{conversation:'edited'},`${f.key}-a`]);
  expect(await f.source().createSnapshot(f.scope,f.selection,requestId)).toEqual(manifest);
  const page=await f.source().readPage(f.scope,manifest,0) as {records:Array<{providerMessageId:string;text:string;ordinal:number}>};
  expect(page.records.map(r=>[r.ordinal,r.providerMessageId,r.text])).toEqual([[0,'a','first'],[1,'b','second']]);
  expect(createHash('sha256').update(JSON.stringify(page.records)).digest('hex')).toBe(manifest.pageDigests[0]);
 });
 it('rejects source-owner mismatch and budget overflow rather than publishing partial coverage',async()=>{
  const f=await fixture();await f.insert('a','first');await f.insert('b','second');
  await expect(f.source().createSnapshot(f.scope,{...f.selection,maxRecords:1},randomUUID())).rejects.toMatchObject({code:'HISTORY_IMPORT_BUDGET'});
  await db.database.pool.query('UPDATE "Instance" SET "ownerJid"=$1 WHERE id=$2',['15550000009@s.whatsapp.net',f.key]);
  expect(await f.source().capability(f.scope)).toEqual({available:false,maxRecords:0});
  await expect(f.source().createSnapshot(f.scope,f.selection,randomUUID())).rejects.toMatchObject({code:'HISTORY_SNAPSHOT_SCOPE_CHANGED'});
 });
 it('does not expose another tenants snapshot and rejects changed source scope',async()=>{
  const a=await fixture(),b=await fixture();await a.insert('a','private synthetic');const manifest=await a.source().createSnapshot(a.scope,a.selection,randomUUID()) as HistorySnapshot;
  await expect(b.source().readPage(b.scope,manifest,0)).rejects.toMatchObject({statusCode:404});
  await expect(a.source().readPage({...a.scope,sourceFingerprint:'b'.repeat(64)},manifest,0)).rejects.toMatchObject({code:'HISTORY_SNAPSHOT_SCOPE_CHANGED'});
 });
 it('bounds active snapshot admission per company without preventing another company from importing',async()=>{
  const a=await fixture(),b=await fixture();
  await db.database.pool.query("INSERT INTO history_import_snapshots(organization_id,id,channel_id,request_id,payload,expires_at) SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),'{}',now()+interval '1 day' FROM generate_series(1,20)",[a.org,a.channel]);
  await expect(a.source().createSnapshot(a.scope,a.selection,randomUUID())).rejects.toMatchObject({code:'HISTORY_SOURCE_STORAGE_LIMIT'});
  expect(await b.source().createSnapshot(b.scope,b.selection,randomUUID())).toMatchObject({organizationId:b.org,totalRecords:0});
  expect((await db.database.pool.query('SELECT count(*)::int AS n FROM history_import_snapshots WHERE organization_id=$1',[a.org])).rows[0].n).toBe(20);
 });
 it('expires only the current companys temporary snapshots',async()=>{
  const a=await fixture(),b=await fixture();
  for(const f of [a,b])await db.database.pool.query("INSERT INTO history_import_snapshots(organization_id,id,channel_id,request_id,payload,expires_at) VALUES($1,gen_random_uuid(),$2,gen_random_uuid(),'{}',now()-interval '1 hour')",[f.org,f.channel]);
  await db.transact(a.org,tx=>tx.query('SELECT history_import_expire_snapshots()'));
  expect((await db.database.pool.query('SELECT organization_id FROM history_import_snapshots WHERE organization_id=ANY($1::uuid[])',[[a.org,b.org]])).rows).toEqual([{organization_id:b.org}]);
 });
});
