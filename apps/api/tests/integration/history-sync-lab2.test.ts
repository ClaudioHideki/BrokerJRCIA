import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { createHistorySyncProjector } from '../../src/modules/history-sync/projector.js';
import { createHistorySyncWorker } from '../../src/modules/history-sync/worker.js';
import { type HistorySyncRecord, type HistorySyncScope } from '../../src/modules/history-sync/contract.js';
import { createOriginJournal, installOriginJournal } from '../../../../integrations/evolution-origin-journal/src/journal.mjs';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
import { createS3PrivateObjectStore } from '../../src/modules/messaging/private-object-store.js';
import { createDurablePrivateMediaStore } from '../../src/modules/messaging/durable-private-media.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';

// Opt-in full local infrastructure test. No real source/socket/WhatsApp session.
it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('reconciles two isolated consumers through PostgreSQL, private MinIO, Rails HTTP and real Sidekiq',async()=>{
  const origin=process.env.HISTORY_LAB2_ORIGIN,endpoint=process.env.HISTORY_LAB_MINIO_ENDPOINT;
  if(origin!=='http://127.0.0.1:54141' || endpoint!=='http://127.0.0.1:54134'
    || process.env.HISTORY_LAB_RAILS_CONTAINER!=='jrc-history-v2-http-20261112')throw Error('Only dedicated synthetic laboratory permitted');
  const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:1024*1024});
  const label=docker(['inspect','--format','{{index .Config.Labels "com.jrc.test"}}',process.env.HISTORY_LAB_RAILS_CONTAINER]).trim();
  if(label!=='jrc-history-v2-complete-20261112')throw Error('Invalid synthetic container label');
  const db=await attendanceDatabase();
  try {
    // Only this disposable synthetic database. Reconstruct the source journal
    // between reads so worker memory cannot stand in for durable progress.
    await installOriginJournal(db.database.pool);
    const sourceJournal=()=>createOriginJournal({pool:db.database.pool,encryptionKey:Buffer.alloc(32,83),history:{maxStagedBytes:4000000}}).history!;
    const sources=[];
    for(let index=0;index<2;index++) {
      const t=await seedAttendanceTenant(db.database),instanceId=randomUUID();
      const scope:HistorySyncScope={organizationId:t.org,channelId:t.channel,instanceId,engineId:'synthetic-engine',engineGeneration:1,
        sessionGeneration:randomUUID(),bindingFingerprint:'a'.repeat(64),identityScopeId:randomUUID(),historyAccountIdentity:randomUUID(),ownerFingerprint:'b'.repeat(64)};
      await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
        SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`,[instanceId,t.channel]);
      await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=(SELECT provider_account_id FROM messaging_channels WHERE id=$1)",[t.channel]);
      await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instanceId]);
      await db.database.pool.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2)',[t.org,t.channel]);
      sources.push({t,scope});
    }
    // Tokens stay in this process only; never return them in test evidence.
    const lab=async(path:'seed'|'verify',input:unknown)=>{
      const response=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw Error(`SYNTHETIC_FIXTURE_${response.status}`);
      return response.json();
    };
    const consumers=await lab('seed',sources.map(s=>({organizationId:s.t.org,integrationId:s.t.integration,instanceId:s.scope.instanceId}))) as {accountId:number;inboxId:number;adminToken:string;agentToken:string}[];
    const bytes=readFileSync(join(process.env.HISTORY_LAB2_CHECKOUT!,'spec/assets/sample.png'));
    const sha256=createHash('sha256').update(bytes).digest('hex'),encryptionKey=Buffer.alloc(32,83).toString('base64');
    const objectStore=createS3PrivateObjectStore({endpoint,bucket:'synthetic-broker-history-20261112',profile:'synthetic-history',region:'us-east-1',
      accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!,dedicatedBucket:true,
      allowLoopbackHttpForTests:true,requestTimeoutMs:5000});
    const privateStore=createDurablePrivateMediaStore({transact:db.transact,cleanupTransact:async()=>{throw Error('Cleanup outside test scope');},
      encryptionKey,profile:'synthetic-history',objectStore,maxStorageBytes:16777216,requestTimeoutMs:5000});
    const media=createMediaStore({transact:db.transact,encryptionKey,privateStore,maxStorageBytes:16777216,download:async()=>{throw Error('No source URL allowed');}});
    const allSourceIds:string[][]=[];
    const expectedMediaHashes:string[]=[];
    const expectedMessageFacts:{broker_message_id:string;provider_message_id:string;content:string;direction:string;occurred_at:number}[]=[];
    for(const [index,{t,scope}] of sources.entries()) {
      const consumer=consumers[index]!,destination={organizationId:t.org,channelId:t.channel,integrationId:t.integration,instanceId:scope.instanceId,
        historyAccountIdentity:scope.historyAccountIdentity!,accountId:consumer.accountId,inboxId:consumer.inboxId,destinationRevision:1};
      // A measured host proof is synthetic here. Real engine ownership remains an independent gate.
      const store=createHistorySyncStore({transact:db.transact,encryptionKey:Buffer.alloc(32,83),maxStagedBytes:4000000,
        assertCurrentScope:async()=>{},resolveDestination:async()=>({destination,authorityFingerprint:'f'.repeat(64)})});
      const mediaId=await media.writeUpload(t.org,t.channel,{rootAutomationId:t.automation,idempotencyKey:randomUUID()},
        {bytes:new Uint8Array(bytes),mimeType:'image/png',kind:'image',fileName:'synthetic.png'});
      expect((await media.read(t.org,mediaId)).bytes).toEqual(new Uint8Array(bytes));
      expectedMediaHashes.push(sha256);
      const jid=`${'1'.repeat(11)}@s.whatsapp.net`,groupJid='100-200@g.us';
      const records:HistorySyncRecord[]=[
        {kind:'CHAT',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:'Synthetic customer',lastMessageAt:1600000001,unreadCount:0},
        {kind:'CHAT',recipientKind:'GROUP',chatJid:groupJid,displayName:'Synthetic group',lastMessageAt:1600000002,unreadCount:0},
        {kind:'MESSAGE',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:null,providerMessageId:'synthetic-text',participantJid:null,fromMe:false,
          messageTimestamp:1600000000,state:'DELIVERED',content:{type:'TEXT',text:'Synthetic <message> & unicode 🙂'}},
        {kind:'MESSAGE',recipientKind:'INDIVIDUAL',chatJid:jid,displayName:null,providerMessageId:'synthetic-media',participantJid:null,fromMe:false,
          messageTimestamp:1600000001,state:'DELIVERED',content:{type:'MEDIA',referenceId:mediaId,mediaType:'IMAGE',byteSize:bytes.length,sha256,mimeType:'image/png',filename:'synthetic.png',caption:'Synthetic physical caption'}},
        {kind:'MESSAGE',recipientKind:'GROUP',chatJid:groupJid,displayName:null,providerMessageId:'synthetic-group-outgoing',participantJid:null,fromMe:true,
          messageTimestamp:1600000002,state:'READ',content:{type:'TEXT',text:'Synthetic historical group outgoing'}},
      ];
      for(const fixture of [
        {file:'sample.pdf',mime:'application/pdf',kind:'document' as const,type:'DOCUMENT' as const,group:true,fromMe:true},
        {file:'sample.ogg',mime:'audio/ogg',kind:'audio' as const,type:'AUDIO' as const,group:true,fromMe:false},
        {file:'sample.mp4',mime:'video/mp4',kind:'video' as const,type:'VIDEO' as const,group:false,fromMe:true},
      ]) {
        const content=readFileSync(join(process.env.HISTORY_LAB2_CHECKOUT!,'spec/assets',fixture.file));
        const checksum=createHash('sha256').update(content).digest('hex');
        const reference=await media.writeUpload(t.org,t.channel,{rootAutomationId:t.automation,idempotencyKey:randomUUID()},
          {bytes:new Uint8Array(content),mimeType:fixture.mime,kind:fixture.kind,fileName:fixture.file});
        expect((await media.read(t.org,reference)).bytes).toEqual(new Uint8Array(content));
        expectedMediaHashes.push(checksum);
        records.push({kind:'MESSAGE',recipientKind:fixture.group?'GROUP':'INDIVIDUAL',chatJid:fixture.group?groupJid:jid,displayName:null,
          providerMessageId:`synthetic-${fixture.kind}`,participantJid:fixture.group&&!fixture.fromMe?'12345@lid':null,
          fromMe:fixture.fromMe,messageTimestamp:1600000003,state:'DELIVERED',content:{type:'MEDIA',referenceId:reference,
            mediaType:fixture.type,byteSize:content.length,sha256:checksum,mimeType:fixture.mime,filename:fixture.file,caption:'Synthetic media fixture'}});
      }
      const references=new Map(records.filter(r=>r.kind==='MESSAGE'&&r.content.type==='MEDIA').map(r=>[r.providerMessageId,r.content]));
      const now=new Date(),run=await store.admit(scope,randomUUID(),{mode:'FULL_AVAILABLE',categories:['INDIVIDUAL','GROUP','MEDIA']},now);
      const event={'messaging-history.set':{isLatest:true,progress:100,contacts:[],
        chats:records.filter(r=>r.kind==='CHAT').map(r=>({id:r.chatJid,name:r.displayName,conversationTimestamp:r.lastMessageAt})),
        messages:records.filter(r=>r.kind==='MESSAGE').map(r=>({key:{id:r.providerMessageId,remoteJid:r.chatJid,fromMe:r.fromMe,participant:r.participantJid},
          messageTimestamp:r.messageTimestamp,status:r.state==='READ'?4:3,
          message:r.content.type==='TEXT'?{conversation:r.content.text}:
            {[{IMAGE:'imageMessage',AUDIO:'audioMessage',VIDEO:'videoMessage',DOCUMENT:'documentMessage',STICKER:'stickerMessage'}[r.content.mediaType]]:{caption:r.content.caption}}})),
      }};
      const journal=sourceJournal();
      await journal.append(journal.prepare(scope,run.id,event,{provenance:'SOCKET',captureId:randomUUID(),capturedAt:now,startOrdinal:0,
        mediaReference:({providerMessageId}:{providerMessageId:string})=>references.get(providerMessageId)}));
      let drop=true;
      const transport:typeof fetch=async(input,init)=>{
        const response=await fetch(input,init);
        if(drop && String(input).endsWith('/messages') && response.ok){drop=false;await response.arrayBuffer();throw Error('SYNTHETIC_ACK_LOST');}
        return response;
      };
      const client=new ChatwootClient({baseUrl:origin,token:consumer.adminToken,allowLocal:true,fetch:transport,timeoutMs:30000});
      const projector=createHistorySyncProjector({store,consumer:()=>client.historySyncV2(),media:async(s,id)=>Buffer.from((await media.read(s.organizationId,id)).bytes)});
      let lostSourceAck=true;
      const worker=createHistorySyncWorker({enabled:true,store,projector,assertAdmission:async()=>{},source:{
        pending:(s,selection)=>sourceJournal().pending(s,selection),
        acknowledge:async(s,page,receipt)=>{
          if(lostSourceAck){lostSourceAck=false;throw Error('SYNTHETIC_SOURCE_ACK_LOST');}
          return sourceJournal().acknowledge(s,page,receipt);
        },
      }});
      for(let attempt=0;attempt<40;attempt++) {
        await worker.runOnce(scope,run.id,new Date(Date.now()+attempt*60000));
        const done=await db.transact(t.org,tx=>tx.query<{count:string}>("SELECT count(*)::text FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE'",[run.id]));
        if(done.rows[0]!.count==='8' && (await sourceJournal().pending(scope,{runId:run.id})).length===0)break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      const sourceIds=(await db.transact(t.org,tx=>tx.query<{message_id:string;provider_message_id:string}>('SELECT message_id,provider_message_id FROM history_sync_receipts WHERE channel_id=$1 ORDER BY message_id',[t.channel]))).rows;
      expect(sourceIds.map(row=>row.provider_message_id).sort()).toEqual(
        ['synthetic-group-outgoing','synthetic-media','synthetic-text','synthetic-document','synthetic-audio','synthetic-video'].sort());
      allSourceIds.push(sourceIds.map(row=>row.message_id));
      for(const row of sourceIds) {
        const original=records.find((r):r is Extract<HistorySyncRecord,{kind:'MESSAGE'}>=>r.kind==='MESSAGE'&&r.providerMessageId===row.provider_message_id)!;
        expectedMessageFacts.push({broker_message_id:row.message_id,provider_message_id:row.provider_message_id,
          content:original.content.type==='TEXT'?original.content.text:original.content.caption,
          direction:original.fromMe?'outgoing':'incoming',occurred_at:original.messageTimestamp});
      }
      const done=(await db.transact(t.org,tx=>tx.query<{count:string}>("SELECT count(*)::text FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE'",[run.id]))).rows[0]!.count;
      if(done!=='8') {
        const safe=(await db.transact(t.org,tx=>tx.query('SELECT state,attempts,last_error FROM history_sync_deliveries WHERE run_id=$1',[run.id]))).rows;
        throw Error(`SYNTHETIC_HISTORY_PROJECTION_INCOMPLETE ${JSON.stringify(safe)}`);
      }
      expect(drop).toBe(false);expect(lostSourceAck).toBe(false);
      // Progress=100/isLatest is not a coverage-close proof for the phone.
      expect(await store.get(t.org,run.id)).toMatchObject({state:'RUNNING',capture:'CAPTURING'});
      expect((await db.database.pool.query('SELECT state,octet_length(payload_ciphertext) AS bytes FROM jrc_evolution_origin.history_chunks WHERE run_id=$1',[run.id])).rows)
        .toEqual([expect.objectContaining({state:'DELIVERED',bytes:expect.any(Number)})]);
      expect(await sourceJournal().pending(scope,{runId:run.id})).toEqual([]);
      const rows=(await db.transact(t.org,tx=>tx.query<{receipt:{broker_message_id:string}}>("SELECT receipt FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE' AND receipt->>'broker_message_id' IS NOT NULL",[run.id]))).rows;
      expect(rows.map(row=>row.receipt.broker_message_id).sort()).toEqual(sourceIds.map(row=>row.message_id).sort());
      // Simulate a fresh capture whose private media copies have different
      // storage UUIDs. Canonical messages and immutable consumer requests must
      // still reuse the first facts/attachments, not merely avoid a SQL error.
      for(const record of records)if(record.kind==='MESSAGE' && record.content.type==='MEDIA') {
        const first=await media.read(t.org,record.content.referenceId);
        const second=await media.writeUpload(t.org,t.channel,{rootAutomationId:t.automation,idempotencyKey:randomUUID()},first);
        expect(second).not.toBe(record.content.referenceId);
        references.set(record.providerMessageId,{...record.content,referenceId:second});
      }
      const recaptured=await store.admit(scope,randomUUID(),{mode:'FULL_AVAILABLE',categories:['INDIVIDUAL','GROUP','MEDIA']},now);
      const again=sourceJournal();
      await again.append(again.prepare(scope,recaptured.id,event,{provenance:'SOCKET',captureId:randomUUID(),capturedAt:now,startOrdinal:0,
        mediaReference:({providerMessageId}:{providerMessageId:string})=>references.get(providerMessageId)}));
      for(let attempt=0;attempt<30;attempt++) {
        await worker.runOnce(scope,recaptured.id,new Date(Date.now()+attempt*60000));
        const completed=(await db.transact(t.org,tx=>tx.query<{count:string}>(
          "SELECT count(*)::text FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE'",[recaptured.id]))).rows[0]!.count;
        if(completed==='8')break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      expect((await db.transact(t.org,tx=>tx.query(`SELECT persisted_messages,duplicate_messages,blocked_records,
        (SELECT count(*) FROM history_sync_deliveries WHERE run_id=$1 AND state='DONE') AS done FROM history_sync_runs WHERE id=$1`,[recaptured.id]))).rows[0])
        .toEqual({persisted_messages:'0',duplicate_messages:'6',blocked_records:'0',done:'8'});
      const response=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}/conversations?assignee_type=me&inbox_scope=member&status=all`,{headers:{api_access_token:consumer.agentToken}});
      expect(response.status).toBe(200);
      const visible=await response.json() as {data:{payload:{id:number;inbox_id:number}[]}};
      expect(visible.data.payload).toHaveLength(2);
      expect(visible.data.payload.every(row=>row.inbox_id===consumer.inboxId)).toBe(true);
    }
    expect(allSourceIds[0]!.some(id=>allSourceIds[1]!.includes(id))).toBe(false);
    const foreign=await fetch(`${origin}/api/v1/accounts/${consumers[1]!.accountId}/conversations`,{headers:{api_access_token:consumers[0]!.agentToken}});
    expect([401,403]).toContain(foreign.status);
    const report=await lab('verify',consumers.map(c=>c.accountId));
    expect(report).toMatchObject({messages:12,attachments:8,all_resolved:true,all_unassigned:true});
    expect(report.byte_hashes.sort()).toEqual(expectedMediaHashes.sort());
    expect(report.message_facts.sort((a:{broker_message_id:string},b:{broker_message_id:string})=>a.broker_message_id.localeCompare(b.broker_message_id)))
      .toEqual(expectedMessageFacts.sort((a,b)=>a.broker_message_id.localeCompare(b.broker_message_id)));
  } finally {await db.dispose();}
},420000);
