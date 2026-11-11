import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { historySyncRecordsDigest, type HistorySyncScope, type HistorySyncRecord } from '../../src/modules/history-sync/contract.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 180000);
afterAll(async () => { await db?.dispose(); });
const now = new Date('2026-11-05T12:00:00Z');
const selection = {mode:'FULL_AVAILABLE',categories:['INDIVIDUAL','GROUP','MEDIA']} as const;
const key = Buffer.alloc(32, 73);
const message: HistorySyncRecord = {kind:'MESSAGE',recipientKind:'INDIVIDUAL',chatJid:'15550000001@s.whatsapp.net',
  providerMessageId:'synthetic-history',fromMe:false,participantJid:null,messageTimestamp:1600000000,
  displayName:'Synthetic',content:{type:'TEXT',text:'Synthetic private historical text'},state:'SENT'};
async function fixture() {
  const t = await seedAttendanceTenant(db.database), instance = randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`,[instance,t.channel]);
  const scope: HistorySyncScope = {organizationId:t.org,channelId:t.channel,instanceId:instance,engineId:'synthetic-engine',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),historyAccountIdentity:null,identityScopeId:null,ownerFingerprint:null};
  let revoked = false;
  const options = {transact:db.transact,encryptionKey:key,maxStagedBytes:2_000_000,
    assertCurrentScope:async () => {if(revoked) throw Error('HISTORY_SYNC_AUTHORITY_REVOKED');}};
  const store = createHistorySyncStore(options);
  const chunk = (ordinal=0) => ({schemaVersion:2,provenance:'SOCKET',scope,chunkId:randomUUID(),ordinal,capturedAt:now.toISOString(),
    isLast:false,progress:null,records:[message],checksum:historySyncRecordsDigest([message])});
  return {t,scope,store,options,chunk,revoke:()=>{revoked=true;}};
}

it('commits encrypted provisional chunks and resumes them through a new store without importing or acknowledging ownership',async()=>{
  const f=await fixture(), run=await f.store.admit(f.scope,randomUUID(),selection,now), chunk=f.chunk();
  const first=await f.store.acceptChunk(f.scope,run.id,chunk,now);
  expect(first).toMatchObject({kind:'STAGED',chunkId:chunk.chunkId,checksum:chunk.checksum});
  const row=(await db.transact(f.t.org,tx=>tx.query('SELECT private_payload,state FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0];
  expect(row.state).toBe('PROVISIONAL');
  expect(JSON.stringify(row.private_payload)).not.toContain(message.content.type==='TEXT'?message.content.text:'unexpected');
  const restarted=createHistorySyncStore(f.options);
  expect(await restarted.acceptChunk(f.scope,run.id,chunk,now)).toEqual(first);
  expect((await restarted.get(f.t.org,run.id))?.capture).toBe('WAITING_IDENTITY');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('1');
});

it('deduplicates admission and rejects changed content or a changed terminal marker for the same chunk',async()=>{
  const f=await fixture(), request=randomUUID();
  const first=await f.store.admit(f.scope,request,selection,now);
  expect((await f.store.admit(f.scope,request,selection,now)).id).toBe(first.id);
  const c=f.chunk(); await f.store.acceptChunk(f.scope,first.id,c,now);
  await expect(f.store.acceptChunk(f.scope,first.id,{...c,isLast:true},now)).rejects.toThrow('HISTORY_SYNC_CHUNK_CONFLICT');
  await expect(f.store.admit(f.scope,request,{...selection,categories:['INDIVIDUAL']},now)).rejects.toThrow('HISTORY_SYNC_REQUEST_CONFLICT');
});

it('promotes only the original capture generation and keeps a stable owner catalogue across reconnection',async()=>{
  const f=await fixture(), run=await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk(),now);
  const confirmed={...f.scope,identityScopeId:randomUUID(),historyAccountIdentity:randomUUID(),ownerFingerprint:'b'.repeat(64)};
  const first=await f.store.promote(run.id,confirmed,now);
  expect(first).toMatchObject({capture:'CAPTURING',historyAccountIdentity:confirmed.historyAccountIdentity});
  const reconnect={...confirmed,engineGeneration:2,sessionGeneration:randomUUID(),identityScopeId:randomUUID()};
  const next=await f.store.admit(reconnect,randomUUID(),selection,now);
  expect(next.historyAccountIdentity).toBe(first.historyAccountIdentity);
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT state FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].state).toBe('VALIDATED');
  const following=f.chunk(1);
  const receipt=await f.store.acceptChunk(confirmed,run.id,following,now);
  expect(receipt.kind).toBe('VALIDATED');
  expect(await f.store.acceptChunk(confirmed,run.id,following,now)).toEqual(receipt);
});

it('quarantines rather than attributing a provisional batch to a different session',async()=>{
  const f=await fixture(), run=await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk(),now);
  const changed={...f.scope,sessionGeneration:randomUUID(),historyAccountIdentity:randomUUID(),identityScopeId:randomUUID(),ownerFingerprint:'c'.repeat(64)};
  expect(await f.store.promote(run.id,changed,now)).toMatchObject({state:'BLOCKED',lastError:'HISTORY_SYNC_SCOPE_CHANGED'});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT state FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].state).toBe('QUARANTINED');
});

it('makes quota exhaustion explicit and never acknowledges an uncommitted chunk',async()=>{
  const f=await fixture(), store=createHistorySyncStore({...f.options,maxStagedBytes:100});
  const run=await store.admit(f.scope,randomUUID(),selection,now);
  expect(await store.acceptChunk(f.scope,run.id,f.chunk(),now)).toMatchObject({kind:'GAP',reason:'SOURCE_QUOTA'});
  expect((await store.get(f.t.org,run.id))?.state).toBe('PARTIAL');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('0');
});

it('serializes duplicate arrivals, fences revocation, and isolates reads from another tenant',async()=>{
  const f=await fixture(), run=await f.store.admit(f.scope,randomUUID(),selection,now), chunk=f.chunk();
  const results=await Promise.all([f.store.acceptChunk(f.scope,run.id,chunk,now),f.store.acceptChunk(f.scope,run.id,chunk,now)]);
  expect(results[0]).toEqual(results[1]);
  const foreign=await seedAttendanceTenant(db.database);
  expect(await f.store.get(foreign.org,run.id)).toBeNull();
  f.revoke();
  await expect(f.store.acceptChunk(f.scope,run.id,f.chunk(1),now)).rejects.toThrow('HISTORY_SYNC_AUTHORITY_REVOKED');
});

it('recovers a real process crash after COMMIT before its correlated ACK without a second chunk',async()=>{
  const f=await fixture(),run=await f.store.admit(f.scope,randomUUID(),selection,now),chunk=f.chunk();
  const url=new URL(db.database.connectionString); url.username='jrc_app'; url.password='';
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/history-sync-crash-child.mjs',import.meta.url))],{
    env:{...process.env,HISTORY_SYNC_CRASH_DATABASE:url.href,
      HISTORY_SYNC_CRASH_FIXTURE:JSON.stringify({scope:f.scope,runId:run.id,chunk,now:now.toISOString()})},
    stdio:['ignore','pipe','pipe'],
  });
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('history child commit timeout')),10000);
      child.stdout.on('data',data=>{if(String(data).includes('COMMITTED')) {clearTimeout(timer);resolve();}});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);reject(Error(`history child exited before commit: ${code}`));});
    });
  } finally {
    const exited=new Promise(resolve=>child.once('exit',resolve));
    if(child.exitCode===null) {child.kill('SIGKILL');await exited;}
  }
  const restarted=createHistorySyncStore(f.options);
  expect(await restarted.acceptChunk(f.scope,run.id,chunk,now)).toMatchObject({kind:'STAGED',chunkId:chunk.chunkId});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('1');
});

it('fences pause, resume and cancel by revision while preserving committed chunks',async()=>{
  const f=await fixture(),run=await f.store.admit(f.scope,randomUUID(),selection,now),chunk=f.chunk();
  await f.store.acceptChunk(f.scope,run.id,chunk,now);
  const paused=await f.store.command(f.scope,run.id,1,'PAUSE');
  expect(paused).toMatchObject({state:'PAUSED',revision:2});
  await expect(f.store.acceptChunk(f.scope,run.id,f.chunk(1),now)).rejects.toThrow('HISTORY_SYNC_NOT_RUNNING');
  await expect(f.store.command(f.scope,run.id,1,'RESUME')).rejects.toThrow('HISTORY_SYNC_REVISION_CHANGED');
  expect(await f.store.command(f.scope,run.id,2,'RESUME')).toMatchObject({state:'RUNNING',revision:3});
  expect(await f.store.command(f.scope,run.id,3,'CANCEL')).toMatchObject({state:'CANCELED',revision:4});
  await expect(f.store.command(f.scope,run.id,4,'RESUME')).rejects.toThrow('HISTORY_SYNC_TERMINAL');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('1');
});

it('rejects chunks outside the persisted category selection before staging them',async()=>{
  const f=await fixture(),run=await f.store.admit(f.scope,randomUUID(),{mode:'FULL_AVAILABLE',categories:['INDIVIDUAL']},now);
  const excluded=[{...message,recipientKind:'GROUP',chatJid:'100-200@g.us',participantJid:'15550000002@s.whatsapp.net'}];
  const group={...f.chunk(),records:excluded,checksum:historySyncRecordsDigest(excluded)};
  await expect(f.store.acceptChunk(f.scope,run.id,group,now)).rejects.toThrow('HISTORY_SYNC_CATEGORY_NOT_SELECTED');
  const media=[{...message,content:{type:'MEDIA',referenceId:randomUUID(),mediaType:'IMAGE',byteSize:123,sha256:'d'.repeat(64),
    mimeType:'image/jpeg',filename:'synthetic.jpg',caption:'Synthetic'}}];
  await expect(f.store.acceptChunk(f.scope,run.id,{...f.chunk(),records:media,checksum:historySyncRecordsDigest(media)},now))
    .rejects.toThrow('HISTORY_SYNC_CATEGORY_NOT_SELECTED');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('0');
});

it('authorizes an immutable scope even when the caller changes owner while the transaction is admitted',async()=>{
  const f=await fixture(), run=await f.store.admit(f.scope,randomUUID(),selection,now), chunk=f.chunk();
  let checkedOwner: string | null | undefined;
  const owner='d'.repeat(64);
  const store=createHistorySyncStore({...f.options,
    transact:(org,work)=>{
      Object.assign(f.scope,{ownerFingerprint:owner,historyAccountIdentity:randomUUID(),identityScopeId:randomUUID()});
      return db.transact(org,work);
    },
    assertCurrentScope:async(_tx,scope)=>{checkedOwner=scope.ownerFingerprint;if(scope.ownerFingerprint!==owner)throw Error('HISTORY_SYNC_AUTHORITY_REVOKED');},
  });
  await expect(store.acceptChunk(f.scope,run.id,chunk,now)).rejects.toThrow('HISTORY_SYNC_AUTHORITY_REVOKED');
  expect(checkedOwner).toBeNull();
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_chunks WHERE run_id=$1',[run.id]))).rows[0].count).toBe('0');
});
