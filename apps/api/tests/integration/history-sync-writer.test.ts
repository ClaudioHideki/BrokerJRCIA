import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { historySyncRecordsDigest, type HistorySyncScope, type HistorySyncRecord } from '../../src/modules/history-sync/contract.js';
import { persistQrContactEvent } from '../../src/modules/messaging/qr-contact-persistence.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createGroupAutomationRuntime } from '../../src/modules/whatsapp-groups/automation-runtime.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); },180000);
afterAll(async () => { await db?.dispose(); });
const now = new Date('2026-11-12T12:00:00Z');
const jid = '15555550101@s.whatsapp.net'; // Reserved synthetic fixture, not a customer's address.
const text: HistorySyncRecord = { kind:'MESSAGE',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:null,
  providerMessageId:'synthetic-history-fact',participantJid:null,fromMe:false,messageTimestamp:1600000000,
  state:'DELIVERED',content:{type:'TEXT',text:'Synthetic historical fact'} };
async function fixture() {
  const t=await seedAttendanceTenant(db.database),instanceId=randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`,[instanceId,t.channel]);
  const scope:HistorySyncScope={organizationId:t.org,channelId:t.channel,instanceId,engineId:'synthetic-engine',engineGeneration:1,
    sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),identityScopeId:randomUUID(),historyAccountIdentity:randomUUID(),ownerFingerprint:'b'.repeat(64)};
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=(SELECT provider_account_id FROM messaging_channels WHERE id=$1)",[t.channel]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instanceId]);
  await db.database.pool.query(`INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,scope_id,owner_fingerprint,upstream_instance_key,binding_fingerprint)
    VALUES($1,$2,$3,$4,$5,($3::uuid)::text,$6)`,[t.org,t.channel,instanceId,scope.identityScopeId,'c'.repeat(64),scope.bindingFingerprint]);
  const options={transact:db.transact,encryptionKey:Buffer.alloc(32,83),maxStagedBytes:4000000,assertCurrentScope:async()=>{}};
  const store=createHistorySyncStore(options);
  const admit=async(s=scope)=>store.admit(s,randomUUID(),{mode:'FULL_AVAILABLE',categories:['INDIVIDUAL','GROUP','MEDIA']},now);
  const chunk=(records:HistorySyncRecord[],ordinal=0,s=scope)=>({schemaVersion:2,provenance:'SOCKET',scope:s,chunkId:randomUUID(),
    ordinal,capturedAt:now.toISOString(),isLast:false,progress:null,records,checksum:historySyncRecordsDigest(records)});
  return {t,scope,options,store,admit,chunk};
}

it('atomically materializes native messages, durable receipts, chats and the page checkpoint without live effects',async()=>{
  const f=await fixture(),run=await f.admit();
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{kind:'CHAT',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:'Synthetic contact',lastMessageAt:1600000000,unreadCount:3},text]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({kind:'PERSISTED',created:1,duplicates:0,blocked:0});
  const result=await db.transact(f.t.org,async tx=>({
    messages:(await tx.query(`SELECT m.is_historical,m.content,m.direction,c.mode,c.bot_public_id FROM messaging_messages m
      JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id WHERE m.channel_id=$1`,[f.t.channel])).rows,
    progress:(await tx.query('SELECT next_ordinal,persisted_messages,captured_messages FROM history_sync_runs WHERE id=$1',[run.id])).rows[0],
    effects:(await tx.query(`SELECT (SELECT count(*) FROM messaging_bot_jobs) bots,(SELECT count(*) FROM messaging_outbox) sends,
      (SELECT count(*) FROM integration_jobs WHERE status='PENDING') live_jobs,(SELECT count(*) FROM history_sync_receipts) receipts`)).rows[0]
  }));
  expect(result.messages).toEqual([{is_historical:true,content:text.kind==='MESSAGE'?text.content:null,direction:'INCOMING',mode:'HUMAN',bot_public_id:null}]);
  expect(result.progress).toEqual({next_ordinal:'1',persisted_messages:'1',captured_messages:'1'});
  expect(result.effects).toEqual({bots:'0',sends:'0',live_jobs:'0',receipts:'1'});
  expect(await f.store.persistNext(f.scope,run.id,now)).toEqual({kind:'IDLE'});
});
it('counts distinct chats from this run including empty groups without counting repeat pages twice',async()=>{
  const f=await fixture(),run=await f.admit();
  await db.database.pool.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)',[f.t.org,f.t.channel]);
  const chats:HistorySyncRecord[]=[{kind:'CHAT',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:'Synthetic',lastMessageAt:1600000000,unreadCount:0},
    {kind:'CHAT',recipientKind:'GROUP',chatJid:'100-200@g.us',displayName:'Synthetic group',lastMessageAt:1600000000,unreadCount:0}];
  await f.store.acceptChunk(f.scope,run.id,f.chunk([...chats,text]),now);await f.store.persistNext(f.scope,run.id,now);
  expect((await f.store.status(f.t.org,f.t.channel,run.id))?.counts.chats).toBe(2);
  await f.store.acceptChunk(f.scope,run.id,f.chunk(chats,1),now);await f.store.persistNext(f.scope,run.id,now);
  expect((await f.store.status(f.t.org,f.t.channel,run.id))?.counts.chats).toBe(2);
});

it('commits a versioned projection obligation before returning the native page acknowledgement',async()=>{
  const f=await fixture(),run=await f.admit();
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  await f.store.persistNext(f.scope,run.id,now);
  const jobs=(await db.transact(f.t.org,tx=>tx.query('SELECT state,attempts FROM history_sync_deliveries WHERE run_id=$1',[run.id]))).rows;
  expect(jobs).toEqual([{state:'PENDING',attempts:0}]);
  const unsafe=(await db.transact(f.t.org,tx=>tx.query("SELECT count(*) FROM integration_jobs WHERE message_id IN (SELECT message_id FROM history_sync_record_results WHERE run_id=$1) AND payload->>'historySyncVersion' IS DISTINCT FROM '2'",[run.id]))).rows[0];
  expect(unsafe.count).toBe('0');
});

it('recovers a lost remote acknowledgement with one canonical receipt and a durable retry, fencing a changed destination',async()=>{
  const {createHistorySyncProjector}=await import('../../src/modules/history-sync/projector.js');
  const f=await fixture();
  const destination={...f.t.scope,instanceId:f.scope.instanceId,historyAccountIdentity:f.scope.historyAccountIdentity!};
  let revision=1;
  const store=createHistorySyncStore({...f.options,resolveDestination:async()=>({destination:{...destination,destinationRevision:revision},authorityFingerprint:'f'.repeat(64)})});
  const run=await f.admit();await store.acceptChunk(f.scope,run.id,{...f.chunk([text]),isLast:true},now);await store.persistNext(f.scope,run.id,now);
  await db.transact(f.t.org,tx=>tx.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,message_id,dedupe_key,payload,status)
    SELECT $1,$2,'MIRROR_MESSAGE',message_id,'synthetic-v2-contract',
      '{"historical":true,"historySyncVersion":2,"operation":"IMPORT_HISTORY"}'::jsonb,'HISTORY_PENDING'
    FROM history_sync_receipts WHERE organization_id=$1 AND channel_id=$3 LIMIT 1
    ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING`,[f.t.org,f.t.integration,f.t.channel]));
  let remoteMessageCount=0,posts=0;const receipts=new Map<string,unknown>();
  const {createHistoryConsumer}=await import('../../src/modules/history-sync/consumer.js');
  const {historyConsumerRequestHash}=await import('../../src/modules/history-sync/consumer.js');
  const consumer=createHistoryConsumer(async(_method,path,body)=>{
    const b=body as Record<string,unknown>;
    if(path.includes('?'))return {protocol:'jrc-history-sync/2',account_id:destination.accountId,inbox_id:destination.inboxId,
      organization_id:destination.organizationId,integration_id:destination.integrationId,history_account_identity:destination.historyAccountIdentity,
      destination_revision:1,supports_text:true,supports_groups:true,supports_media:true,supports_silent_bootstrap:true,max_media_bytes:16777216};
    const hash=historyConsumerRequestHash(b),old=receipts.get(hash);
    if(old)return old;
    const isMessage=path.endsWith('/messages');
    const ack={protocol:'jrc-history-sync/2',...Object.fromEntries(Object.entries(b).filter(([k])=>['organization_id','integration_id','history_account_identity','destination_revision'].includes(k))),
      account_id:destination.accountId,inbox_id:destination.inboxId,receipt_id:randomUUID(),request_hash:hash,state:'PERSISTED',
      conversation_id:501,contact_id:601,source_id:'synthetic-source',broker_conversation_id:b.broker_conversation_id,
      broker_message_id:isMessage?b.broker_message_id:null,message_id:isMessage?701:null};
    receipts.set(hash,ack);
    if(isMessage){remoteMessageCount++;posts++;throw Error('SYNTHETIC_LOST_ACK_AFTER_COMMIT');}
    return ack;
  });
  const projector=createHistorySyncProjector({store,consumer:()=>consumer,media:async()=>{throw Error('UNEXPECTED_MEDIA');}});
  expect(await projector.runOnce(f.scope,run.id,now)).toMatchObject({kind:'RETRY'});
  expect(remoteMessageCount).toBe(1);
  expect(await projector.runOnce(f.scope,run.id,new Date(now.getTime()+60000))).toMatchObject({kind:'DONE'});
  expect({remoteMessageCount,posts}).toEqual({remoteMessageCount:1,posts:1});
  expect((await db.transact(f.t.org,tx=>tx.query(`SELECT (SELECT count(*) FROM chatwoot_conversations WHERE integration_id=$1) conversations,
    (SELECT count(*) FROM chatwoot_messages WHERE integration_id=$1) messages`,[f.t.integration]))).rows[0]).toEqual({conversations:'1',messages:'1'});
  expect((await store.get(f.t.org,run.id))?.state).toBe('COMPLETED');
  expect((await db.transact(f.t.org,tx=>tx.query("SELECT status FROM integration_jobs WHERE dedupe_key='synthetic-v2-contract'"))).rows[0]?.status).toBe('SUCCEEDED');
  const next=await f.admit();await store.acceptChunk(f.scope,next.id,{...f.chunk([text]),isLast:true},now);await store.persistNext(f.scope,next.id,now);
  const claim=await store.claimProjection(f.scope,next.id,now);
  expect(claim?.kind).toBe('CLAIMED');revision=2;
  if(claim?.kind!=='CLAIMED')throw Error('Expected synthetic claim');
  await expect(store.finishProjection(f.scope,next.id,claim,undefined,now)).rejects.toThrow('HISTORY_SYNC_DESTINATION_CHANGED');
  const changed=await f.admit();await store.acceptChunk(f.scope,changed.id,{...f.chunk([text]),isLast:true},now);await store.persistNext(f.scope,changed.id,now);
  await expect(store.claimProjection(f.scope,changed.id,now)).rejects.toThrow('HISTORY_SYNC_LIVE_MAP_UNPROVEN');
});

async function live(f:Awaited<ReturnType<typeof fixture>>) {
  return db.transact(f.t.org,async tx=>{
    const channel=await createPostgresMessagingRepository().findChannel(tx,f.t.org,f.t.channel,{lock:true});
    if(!channel)throw Error('Synthetic channel missing');
    return persistQrContactEvent(tx,channel,{kind:'message',upstreamMessageId:'synthetic-history-fact',externalId:jid.split('@')[0]!,
      displayName:null,content:{type:'TEXT',text:'Synthetic historical fact'},occurredAt:new Date(1600000000000)});
  });
}

it('adopts a live native message only with a capture proof correlated to the logical owner',async()=>{
  const f=await fixture(),run=await f.admit();
  await live(f);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:0,duplicates:1,blocked:0});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('1');
});

it('does not schedule a bot or duplicate native data when live follows history',async()=>{
  const f=await fixture(),run=await f.admit();
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  await f.store.persistNext(f.scope,run.id,now);
  expect(await live(f)).toBe(false);
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_bot_jobs'))).rows[0].count).toBe('0');
});

it('records an immutable conflict when the same proved provider ID arrives with changed content',async()=>{
  const f=await fixture(),run=await f.admit();await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  await f.store.persistNext(f.scope,run.id,now);
  const next=await f.admit();
  const changed={...text,content:{type:'TEXT',text:'Synthetic altered fact'}} as HistorySyncRecord;
  await f.store.acceptChunk(f.scope,next.id,f.chunk([changed]),now);
  expect(await f.store.persistNext(f.scope,next.id,now)).toMatchObject({created:0,duplicates:0,blocked:1});
});

it('converges concurrent workers, a new run and same-owner reconnection to the same canonical message',async()=>{
  const f=await fixture(),run=await f.admit();
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  const turns=await Promise.all([f.store.persistNext(f.scope,run.id,now),f.store.persistNext(f.scope,run.id,now)]);
  expect(turns.map(r=>r.kind).sort()).toEqual(['IDLE','PERSISTED']);
  const reconnect={...f.scope,sessionGeneration:randomUUID(),identityScopeId:randomUUID(),engineGeneration:2};
  const next=await f.admit(reconnect);
  await f.store.acceptChunk(reconnect,next.id,f.chunk([text],0,reconnect),now);
  expect(await createHistorySyncStore(f.options).persistNext(reconnect,next.id,now)).toMatchObject({created:0,duplicates:1});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('1');
});

it('preserves the whole page when a transaction aborts and resumes after restart',async()=>{
  const f=await fixture(),run=await f.admit();await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  const crashing=createHistorySyncStore({...f.options,transact:(org,work)=>db.transact(org,async tx=>{await work(tx);throw Error('SYNTHETIC_PRE_COMMIT_CRASH');})});
  await expect(crashing.persistNext(f.scope,run.id,now)).rejects.toThrow('SYNTHETIC_PRE_COMMIT_CRASH');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_receipts'))).rows[0].count).toBe('0');
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:1});
});

it('does not falsely adopt an unproved legacy live message or duplicate a conflicting provider fact',async()=>{
  const f=await fixture(),run=await f.admit();
  await db.transact(f.t.org,async tx=>{
    const contact=(await tx.query(`INSERT INTO messaging_contacts(organization_id,external_id) VALUES($1,$2) RETURNING id`,[f.t.org,jid.split('@')[0]])).rows[0];
    const conversation=(await tx.query(`INSERT INTO messaging_conversations(organization_id,channel_id,contact_id) VALUES($1,$2,$3) RETURNING id`,[f.t.org,f.t.channel,contact.id])).rows[0];
    await tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at)
      VALUES($1,$2,$3,'INCOMING','CONTACT',$4,$5,'DELIVERED',to_timestamp(1600000000))`,[f.t.org,f.t.channel,conversation.id,text.kind==='MESSAGE'?text.providerMessageId:'',JSON.stringify({type:'TEXT',text:'Different or unproved legacy data'})]);
  });
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:0,blocked:1});
  const r=(await db.transact(f.t.org,tx=>tx.query(`SELECT (SELECT count(*) FROM messaging_messages WHERE channel_id=$1) messages,
    (SELECT count(*) FROM history_sync_receipts WHERE channel_id=$1) receipts`,[f.t.channel]))).rows[0];
  expect(r).toEqual({messages:'1',receipts:'0'});
});

it('does not claim an unproved legacy peer when the current-owner history has a different provider ID',async()=>{
  const f=await fixture(),run=await f.admit();
  await db.transact(f.t.org,async tx=>{
    const contact=(await tx.query('INSERT INTO messaging_contacts(organization_id,external_id) VALUES($1,$2) RETURNING id',[f.t.org,jid.split('@')[0]])).rows[0];
    const conversation=(await tx.query('INSERT INTO messaging_conversations(organization_id,channel_id,contact_id) VALUES($1,$2,$3) RETURNING id',[f.t.org,f.t.channel,contact.id])).rows[0];
    await tx.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state)
      VALUES($1,$2,$3,'INCOMING','CONTACT','synthetic-unproved-older-id',$4,'DELIVERED')`,[f.t.org,f.t.channel,conversation.id,JSON.stringify({type:'TEXT',text:'Synthetic unproved older owner'})]);
  });
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:0,blocked:1});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_native_peers'))).rows[0].count).toBe('0');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('1');
});

it('materializes groups separately, keeps participant LIDs and never invents a phone for an unresolved LID',async()=>{
  const f=await fixture(),run=await f.admit();
  await db.transact(f.t.org,tx=>tx.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)',[f.t.org,f.t.channel]));
  const group={...text,recipientKind:'GROUP',chatJid:'100-200@g.us',participantJid:'123456789012345@lid'} as HistorySyncRecord;
  const lid={...text,providerMessageId:'synthetic-lid',chatJid:'123456789012345@lid'} as HistorySyncRecord;
  await f.store.acceptChunk(f.scope,run.id,f.chunk([group,lid]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:2,blocked:0});
  const conversations=(await db.transact(f.t.org,tx=>tx.query(`SELECT c.recipient_kind,c.group_jid,p.external_id FROM messaging_messages m
    JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
    LEFT JOIN messaging_contacts p ON p.organization_id=c.organization_id AND p.id=c.contact_id WHERE m.channel_id=$1 ORDER BY c.recipient_kind`,[f.t.channel]))).rows;
  expect(conversations).toEqual([{recipient_kind:'GROUP',group_jid:'100-200@g.us',external_id:null},
    {recipient_kind:'INDIVIDUAL',group_jid:null,external_id:'lid:123456789012345@lid'}]);
});

it('records recoverability gaps instead of claiming completion, and fences paused/cross-tenant calls',async()=>{
  const f=await fixture(),run=await f.admit();
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{kind:'GAP',chatJid:jid,providerMessageId:'synthetic-missing',reason:'MEDIA_UNAVAILABLE'}]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:0,blocked:1});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT blocked_records,state FROM history_sync_runs WHERE id=$1',[run.id]))).rows[0]).toEqual({blocked_records:'1',state:'RUNNING'});
  await f.store.command(f.scope,run.id,1,'PAUSE');
  await expect(f.store.persistNext(f.scope,run.id,now)).rejects.toThrow('HISTORY_SYNC_NOT_RUNNING');
  const other=await seedAttendanceTenant(db.database);
  await expect(f.store.persistNext({...f.scope,organizationId:other.org},run.id,now)).rejects.toThrow('CHANNEL_NOT_FOUND');
});

it('leaves a page pending while a media reference is unavailable, then retries the whole page without partial receipts',async()=>{
  const f=await fixture(),run=await f.admit();
  const media={...text,providerMessageId:'synthetic-media',content:{type:'MEDIA',referenceId:randomUUID(),mediaType:'IMAGE',
    byteSize:123,sha256:'d'.repeat(64),mimeType:'image/png',filename:'synthetic.png',caption:'Synthetic caption'}} as HistorySyncRecord;
  await f.store.acceptChunk(f.scope,run.id,f.chunk([text,media]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({kind:'WAITING_MEDIA',pending:1});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_receipts'))).rows[0].count).toBe('0');
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT next_ordinal,pending_media FROM history_sync_runs WHERE id=$1',[run.id]))).rows[0])
    .toEqual({next_ordinal:'0',pending_media:'1'});
});

it('reuses historical group facts after an authorized same-owner epoch change without starting automation',async()=>{
  const f=await fixture(),run=await f.admit();
  await db.transact(f.t.org,tx=>tx.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,$3,1,$4,$5,$6)`,[f.t.org,f.t.channel,'e'.repeat(64),randomUUID(),now,new Date(now.getTime()+3600000)]));
  const group={...text,recipientKind:'GROUP',chatJid:'100-200@g.us',participantJid:'123456789012345@lid'} as HistorySyncRecord;
  await f.store.acceptChunk(f.scope,run.id,f.chunk([group]),now);await f.store.persistNext(f.scope,run.id,now);
  const reconnect={...f.scope,identityScopeId:randomUUID(),sessionGeneration:randomUUID(),engineGeneration:2};await f.admit(reconnect);
  await db.transact(f.t.org,async tx=>{
    await tx.query('UPDATE qr_identity_scopes SET scope_id=$3 WHERE organization_id=$1 AND channel_id=$2',[f.t.org,f.t.channel,reconnect.identityScopeId]);
    await tx.query('UPDATE whatsapp_group_catalogs SET identity_revision=2 WHERE organization_id=$1 AND channel_id=$2',[f.t.org,f.t.channel]);
  });
  const runtime=createGroupAutomationRuntime({transact:db.transact,encryptionKey:Buffer.alloc(32,75).toString('base64'),configurationScope:'synthetic',
    readIdentity:async()=>({connected:true,phone:null,groupsIgnore:false}),sendText:async()=>{throw Error('Synthetic send forbidden');}});
  const outcome=await db.transact(f.t.org,tx=>runtime.ingestWithinTransaction(tx,f.t.org,f.t.channel,{kind:'group-text',groupJid:'100-200@g.us',
    upstreamMessageId:'synthetic-history-fact',fromMe:false,participantJid:'123456789012345@lid',participantJidAlt:null,
    content:{type:'TEXT',text:'Synthetic historical fact'},occurredAt:new Date(1600000000000)}));
  expect(outcome).toMatchObject({duplicate:true,executionId:null,reason:'HISTORY_ALREADY_PERSISTED'});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('1');
});

it('reuses the first canonical media reference when the same provider fact is recaptured into a second verified object',async()=>{
  const f=await fixture(),run=await f.admit();
  const media=createMediaStore({transact:db.transact,encryptionKey:Buffer.alloc(32,83).toString('base64'),
    download:async()=>{throw Error('No provider download in this persistence regression');}});
  const bytes=Buffer.from('Synthetic media recapture'),sha256=createHash('sha256').update(bytes).digest('hex');
  const upload=()=>media.writeUpload(f.t.org,f.t.channel,{rootAutomationId:f.t.automation,idempotencyKey:randomUUID()},
    {bytes,mimeType:'text/plain',kind:'document',fileName:'synthetic.txt'});
  const first=await upload(),second=await upload();
  expect(second).not.toBe(first);
  const fact:Extract<HistorySyncRecord,{kind:'MESSAGE'}>={...text,kind:'MESSAGE',providerMessageId:'synthetic-media-recapture',
    content:{type:'MEDIA',referenceId:first,mediaType:'DOCUMENT',byteSize:bytes.length,sha256,
      mimeType:'text/plain',filename:'synthetic.txt',caption:'Synthetic recaptured media'}};
  await f.store.acceptChunk(f.scope,run.id,f.chunk([fact]),now);
  expect(await f.store.persistNext(f.scope,run.id,now)).toMatchObject({created:1,duplicates:0});
  if(fact.content.type!=='MEDIA')throw Error('Expected media fixture');
  const next=await f.admit();
  await f.store.acceptChunk(f.scope,next.id,f.chunk([{...fact,content:{...fact.content,referenceId:second}}]),now);
  expect(await f.store.persistNext(f.scope,next.id,now)).toMatchObject({created:0,duplicates:1,blocked:0});
  const destination={organizationId:f.t.org,channelId:f.t.channel,integrationId:f.t.integration,instanceId:f.scope.instanceId,
    historyAccountIdentity:f.scope.historyAccountIdentity!,accountId:7,inboxId:9,destinationRevision:1};
  const projecting=createHistorySyncStore({...f.options,resolveDestination:async()=>({destination,authorityFingerprint:'f'.repeat(64)})});
  const claim=await projecting.claimProjection(f.scope,next.id,now);
  expect(claim).toMatchObject({kind:'CLAIMED',record:{content:{referenceId:first}}});
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('1');
});
