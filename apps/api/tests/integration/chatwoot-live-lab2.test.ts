import {createHash,createHmac,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {chatwootEnvironment,createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {initializeChatwootAttendanceMap} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {createMessagingWorker} from '../../src/modules/messaging/worker.js';
import {readChatwootAccount} from '../../src/modules/integrations/chatwoot-context.js';
import {groupCentralEnvelope} from '../../src/modules/whatsapp-groups/group-central-identity.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {createS3PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {createMediaStore,registerPendingMedia} from '../../src/modules/messaging/media-store.js';
import {initializeHistoryLabBucket} from '../../../../labs/history-sync-lab2/storage-fixture.mjs';

// Actual Rails HTTP + PostgreSQL; only the external provider ACK is simulated.
// This cannot homologate a WhatsApp session or physical handset delivery.
it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('keeps live human intents, outbox and provider receipts correlated through two isolated Rails accounts',async()=>{
  const origin=process.env.HISTORY_LAB2_ORIGIN;
  if(origin!=='http://127.0.0.1:54141'||process.env.HISTORY_LAB_RAILS_CONTAINER!=='jrc-history-v2-http-20261112')
    throw Error('Only dedicated synthetic laboratory permitted');
  const label=execFileSync('docker',['--context',process.env.HISTORY_LAB_DOCKER_CONTEXT??'desktop-linux','inspect','--format','{{index .Config.Labels "com.jrc.test"}}',process.env.HISTORY_LAB_RAILS_CONTAINER],{encoding:'utf8',timeout:30000}).trim();
  if(label!=='jrc-history-v2-complete-20261112')throw Error('Invalid synthetic container label');
  const lab=async(path:string,input:unknown)=>{
    const response=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error(`SYNTHETIC_FIXTURE_${response.status}`);
    return response.json();
  };
  const db=await attendanceDatabase();
  try{
    const sources=await Promise.all([seedAttendanceTenant(db.database,false),seedAttendanceTenant(db.database,false)]);
    const consumers=await lab('seed',sources.map(t=>({organizationId:t.org,integrationId:t.integration,instanceId:randomUUID()}))) as {accountId:number;inboxId:number;adminToken:string;agentToken:string}[];
    const sends:string[]=[];
    for(const [index,t]of sources.entries()){
      const consumer=consumers[index]!;
      const api=async(path:string,method='GET',body?:unknown,token=consumer.adminToken)=>{
        const response=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}${path}`,{method,headers:{api_access_token:token,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(!response.ok)throw Error(`SYNTHETIC_API_${method}_${response.status}`);
        return response.json();
      };
      const contact=await api('/contacts','POST',{name:`Synthetic live ${index}`,identifier:`synthetic-live-${randomUUID()}`});
      const contactId=contact.payload.contact.id as number;
      const linked=await api(`/contacts/${contactId}/contact_inboxes`,'POST',{inbox_id:consumer.inboxId});
      const remote=await api('/conversations','POST',{inbox_id:consumer.inboxId,contact_id:contactId,source_id:linked.source_id,status:'open'});
      const conversationId=remote.id as number;
      const sent=await api(`/conversations/${conversationId}/messages`,'POST',{content:'Synthetic live human intent',message_type:'outgoing',private:false},consumer.agentToken);
      const original=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:sent.id});
      expect(original.message.contentAttributes.jrc_broker_outbound).toMatchObject({version:1,state:'PENDING',intent_id:original.delivery.id,integration_id:t.integration,inbox_id:consumer.inboxId});
      await api(`/conversations/${conversationId}/assignments`,'POST',{assignee_id:original.callback.sender.id});
      const options:ChatwootOptions={baseUrl:origin,publicOrigin:'https://synthetic.example.test',allowLocal:true,encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined};
      const env=chatwootEnvironment(options),secret=`synthetic-${randomUUID()}`;
      await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')",[t.org,origin]);
      await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,$3,$4,'READY')",[t.org,origin,consumer.accountId,env.vault.encrypt(`${t.org}:chatwoot-account`,consumer.adminToken)]);
      await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,$4,'Synthetic live','READY',$5)",[t.integration,t.org,t.channel,consumer.inboxId,env.vault.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,secret)]);
      const local=randomUUID(),localContact=(await db.database.pool.query('INSERT INTO messaging_contacts(organization_id,external_id) VALUES($1,$2) RETURNING id',[t.org,`synthetic-live-${local}`])).rows[0].id;
      await db.database.pool.query('INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id) VALUES($1,$2,$3,$4)',[local,t.org,t.channel,localContact]);
      await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
        VALUES($1,$2,$3,$4,$5,$6),($1,$2,$7,987654,'synthetic-uncertain',987654)`,[t.org,t.integration,local,contactId,linked.source_id,conversationId,t.conversation]);
      await db.database.pool.query(`INSERT INTO attendance_owners(organization_id,channel_id,integration_id,executor,revision,automation_id,version) VALUES($1,$2,$3,'BROKER',1,$4,1)`,[t.org,t.channel,t.integration,t.automation]);
      const scope={...t.scope,accountId:consumer.accountId,inboxId:consumer.inboxId,credentialRevision:1};
      const current=await env.client((await db.transact(t.org,tx=>readChatwootAccount(tx,t.org)))!).attendanceConversation(consumer.accountId,conversationId);
      await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:local,remoteConversationId:conversationId,canonical:current}));
      // A fixture-only inbound opens the provider window. It is not a claimed HTTP mirror result.
      await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
        VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic prior inbound"}','DELIVERED')`,[t.org,t.channel,local]);
      await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE organization_id=$1",[t.org]);
      const uncertainMessage=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
        VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic unrelated uncertain mirror"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
      const uncertain=(await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,payload='{"operation":"SEND_MESSAGE","conversationId":987654}' WHERE message_id=$1 RETURNING id`,[uncertainMessage])).rows[0].id;
      const raw=Buffer.from(JSON.stringify(original.callback)),timestamp=String(Math.floor(Date.now()/1000));
      const signature='sha256='+createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
      const service=createChatwootService(options);
      await service.ingest(t.integration,raw,timestamp,signature);await service.ingest(t.integration,raw,timestamp,signature);
      await Promise.all([createChatwootWorker(options).runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
      expect((await db.database.pool.query("SELECT status,last_error FROM integration_jobs WHERE organization_id=$1 AND kind='CHATWOOT_REPLY'",[t.org])).rows)
        .toEqual([{status:'SUCCEEDED',last_error:null}]);
      const message=(await db.database.pool.query(`SELECT m.id,m.state FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id WHERE o.organization_id=$1`,[t.org])).rows;
      expect(message).toHaveLength(1);expect(message[0].state).toBe('ACCEPTED');
      const providerId=`synthetic-live-provider-${index}`;
      const worker=createMessagingWorker({repository:createPostgresMessagingRepository(),transact:db.transact,
        resolveMetaClient:async()=>({async sendText(_recipient,text){sends.push(text);return{upstreamMessageId:providerId};},async sendTemplate(){throw Error('Unexpected synthetic template');},async listTemplates(){return[];}}),
        async resolveTypebotClient(){throw Error('Unexpected external automation');}});
      await worker.runOnce(t.org);await worker.runOnce(t.org);
      const canonical=(await db.database.pool.query('SELECT state,upstream_message_id FROM messaging_messages WHERE id=$1',[message[0].id])).rows[0];
      expect(canonical).toEqual({state:'SENT',upstream_message_id:providerId});
      await createChatwootWorker(options).runOnce(t.org);
      const receipt=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:sent.id});
      expect(receipt.message).toMatchObject({status:'sent',contentAttributes:{jrc_broker_outbound:{canonical_message_id:message[0].id,provider_message_id:providerId,state:'SENT'}}});
      await api(`/conversations/${conversationId}/messages/${sent.id}`,'PATCH',{status:'read',broker_delivery:{version:1,canonical_message_id:message[0].id,provider_message_id:providerId,state:'READ'}});
      await api(`/conversations/${conversationId}/messages/${sent.id}`,'PATCH',{status:'failed'});
      const final=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:sent.id});
      expect(final.message.status).toBe('read');expect(final.delivery.id).toBe(original.delivery.id);
      expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[uncertain])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
      const visible=await api('/conversations?assignee_type=me&inbox_scope=member&status=all','GET',undefined,consumer.agentToken);
      expect(visible.data.payload.some((row:{id:number;inbox_id:number})=>row.id===conversationId&&row.inbox_id===consumer.inboxId)).toBe(true);
      const foreign=await fetch(`${origin}/api/v1/accounts/${consumers[1-index]!.accountId}/conversations`,{headers:{api_access_token:consumer.agentToken}});
      expect([401,403]).toContain(foreign.status);

      // Complement the scoped group-worker tests with actual Rails multipart
      // acceptance/private storage. This envelope grants no Broker authority.
      const envelope=groupCentralEnvelope({organizationId:t.org,channelId:t.channel,integrationId:t.integration,destinationRevision:1,
        instanceId:randomUUID(),identityRevision:1,identityFingerprint:'a'.repeat(64),groupJid:'100-200@g.us'},'Synthetic live group');
      // The private MinIO DNS name is reachable inside Docker only. Use Rails'
      // real signed-blob proxy route in this test instead of a fake file server
      // or relaxing the production media-origin allowlist.
      const client=new ChatwootClient({baseUrl:origin,token:consumer.adminToken,allowLocal:true,async fetch(input,init){
        const url=new URL(String(input));
        if(url.origin!==origin)throw Error('Synthetic file download escaped the Rails laboratory');
        if(url.pathname.startsWith('/rails/active_storage/blobs/redirect/'))
          url.pathname=url.pathname.replace('/blobs/redirect/','/blobs/proxy/');
        return fetch(url,init);
      }});
      const groupContactId=await client.createGroupContact(consumer.accountId,envelope.contact);
      const groupSource=await client.linkContactInbox(consumer.accountId,groupContactId,consumer.inboxId,envelope.sourceId);
      const groupConversation=await client.createConversation(consumer.accountId,{inboxId:consumer.inboxId,contactId:groupContactId,sourceId:groupSource,status:'pending'});
      for(const media of [{file:'sample.png',mime:'image/png',kind:'image' as const},
        {file:'sample.ogg',mime:'audio/ogg',kind:'audio' as const},{file:'sample.pdf',mime:'application/pdf',kind:'document' as const}]){
        const bytes=readFileSync(join(process.env.HISTORY_LAB2_CHECKOUT!,'spec/assets',media.file));
        const caption='c'.repeat(1024),presentationText=`[Participante: 12345@lid]\n${caption}`,brokerMessageId=randomUUID();
        const id=await client.sendMedia(consumer.accountId,groupConversation,{bytes,mimeType:media.mime,kind:media.kind,fileName:media.file,caption},
          {incoming:true,brokerMessageId,presentationText});
        const canonicalMedia=await client.canonicalMessage(consumer.accountId,consumer.inboxId,groupConversation,id);
        // Multipart text fields use CRLF on the wire. Preserve all content,
        // allowing only that specified newline encoding.
        expect(canonicalMedia).toMatchObject({id,message_type:'incoming',content_attributes:{jrc_broker_message_id:brokerMessageId}});
        expect(canonicalMedia.content?.replace(/\r\n/gu,'\n')).toBe(presentationText);
        expect(canonicalMedia.attachments).toHaveLength(1);
        expect(new URL(String((canonicalMedia.attachments![0] as {data_url:string}).data_url)).origin).toBe(origin);
        const attachmentId=(canonicalMedia.attachments![0] as {id:number}).id;
        const downloaded=await client.downloadAttachment(consumer.accountId,consumer.inboxId,groupConversation,id,attachmentId);
        expect(createHash('sha256').update(downloaded.bytes).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
        const stored=await lab('attachment-read',{protocol:'attachment-read/v1',accountId:consumer.accountId,messageId:id});
        expect(stored.message.content.replace(/\r\n/gu,'\n')).toBe(presentationText);
        expect(stored).toMatchObject({protocol:'attachment-read/v1',byteHashes:[createHash('sha256').update(bytes).digest('hex')],filenames:[media.file],
          message:{id,inboxId:consumer.inboxId,conversationId:groupConversation}});
      }
    }
    expect(sends).toEqual(['Synthetic live human intent','Synthetic live human intent']);
  }finally{await db.dispose();}
},420000);

it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('recovers native LIVE receipts and private files through real Rails and Sidekiq without a second message POST',async()=>{
 const origin=process.env.HISTORY_LAB2_ORIGIN,endpoint=process.env.HISTORY_LAB_MINIO_ENDPOINT;
 if(origin!=='http://127.0.0.1:54141'||!/^http:\/\/127[.]0[.]0[.]1:\d+$/u.test(endpoint??'')
  ||process.env.HISTORY_LAB_RAILS_CONTAINER!=='jrc-history-v2-http-20261112')throw Error('Only dedicated synthetic laboratory permitted');
 const label=execFileSync('docker',['--context',process.env.HISTORY_LAB_DOCKER_CONTEXT??'desktop-linux','inspect','--format','{{index .Config.Labels "com.jrc.test"}}',process.env.HISTORY_LAB_RAILS_CONTAINER],{encoding:'utf8',timeout:30000}).trim();
 if(label!=='jrc-history-v2-complete-20261112')throw Error('Invalid synthetic container label');
 const sidekiq='jrc-history-v2-sidekiq-20261112';let sidekiqPaused=false;
 const docker=(args:string[])=>execFileSync('docker',['--context',process.env.HISTORY_LAB_DOCKER_CONTEXT??'desktop-linux',...args],{encoding:'utf8',timeout:60000});
 if(docker(['inspect','--format','{{index .Config.Labels "com.jrc.test"}}',sidekiq]).trim()!==label)
  throw Error('Invalid synthetic Sidekiq label');
 const lab=async(path:string,input:unknown)=>{
  const response=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},
   body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error(`SYNTHETIC_FIXTURE_${response.status}`);return response.json();
 };
 const db=await attendanceDatabase();
 try{
  const sources=[];
  for(let n=0;n<2;n++){
   const t=await seedAttendanceTenant(db.database,false),instance=randomUUID();
   await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=(SELECT provider_account_id FROM messaging_channels WHERE id=$1)",[t.channel]);
   await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) SELECT $1::uuid,organization_id,provider_account_id,'Synthetic native',$1::text,'CONNECTED' FROM messaging_channels WHERE id=$2",[instance,t.channel]);
   await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
   sources.push({...t,instance});
  }
  const consumers=await lab('seed',sources.map(t=>({organizationId:t.org,integrationId:t.integration,instanceId:t.instance}))) as {accountId:number;inboxId:number;agentId:number;adminToken:string;agentToken:string}[];
  await initializeHistoryLabBucket({labOnly:true,endpoint:endpoint!,accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!});
  const objectStore=createS3PrivateObjectStore({endpoint:endpoint!,bucket:'synthetic-broker-history-20261112',profile:'synthetic-history',region:'us-east-1',
   accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!,dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000});
  const encryptionKey=Buffer.alloc(32,83).toString('base64');
  const privateStore=createDurablePrivateMediaStore({transact:db.transact,cleanupTransact:async()=>{throw Error('Cleanup outside test scope');},
   encryptionKey,profile:'synthetic-history',objectStore,maxStorageBytes:16777216,requestTimeoutMs:5000});
  const downloads=new Map<string,{bytes:Buffer;mimeType:string;kind:'image'|'audio'|'document';fileName:string}>();
  const media=createMediaStore({transact:db.transact,encryptionKey,privateStore,maxStorageBytes:16777216,download:async asset=>{
   const file=downloads.get(String(asset.descriptor.messageId));if(!file)throw Error('Synthetic source unavailable');return file;
  }});
  for(const [index,t]of sources.entries()){
   const consumer=consumers[index]!;
   const api=async(path:string,method='GET',body?:unknown,token=consumer.adminToken)=>{
    const response=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}${path}`,{method,headers:{api_access_token:token,'Content-Type':'application/json'},
     signal:AbortSignal.timeout(60000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok)throw Error(`SYNTHETIC_API_${method}_${response.status}`);return response.json();
   };
   const contact=await api('/contacts','POST',{name:`Synthetic native ${index}`,identifier:`synthetic-native-${randomUUID()}`});
   const contactId=contact.payload.contact.id as number;
   const linked=await api(`/contacts/${contactId}/contact_inboxes`,'POST',{inbox_id:consumer.inboxId});
   const remote=await api('/conversations','POST',{inbox_id:consumer.inboxId,contact_id:contactId,source_id:linked.source_id,status:'open'});
   await api(`/conversations/${remote.id}/assignments`,'POST',{assignee_id:consumer.agentId});
   await api(`/conversations/${remote.id}/update_last_seen`,'POST',{},consumer.agentToken);
   const posts=new Map<string,number>();let loseAck=true;
   const options:ChatwootOptions={baseUrl:origin,publicOrigin:'https://synthetic.example.test',allowLocal:true,encryptionKey,
    transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,media,
    async fetch(input,init){
     const response=await fetch(input,init),url=new URL(String(input));
     if(url.pathname.endsWith('/live-ingress/v1/messages')){
      const envelope=init?.body instanceof FormData?JSON.parse(String(init.body.get('envelope'))):JSON.parse(String(init?.body));
      posts.set(envelope.broker_message_id,(posts.get(envelope.broker_message_id)??0)+1);
      if(loseAck&&response.ok){loseAck=false;await response.arrayBuffer();throw Error('Synthetic ACK lost after receiver COMMIT');}
     }
     return response;
    }};
   const env=chatwootEnvironment(options);
   await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')",[t.org,origin]);
   await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,$3,$4,'READY')",[t.org,origin,consumer.accountId,env.vault.encrypt(`${t.org}:chatwoot-account`,consumer.adminToken)]);
   await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,$4,'Synthetic native','READY')",[t.integration,t.org,t.channel,consumer.inboxId]);
   await db.database.pool.query('INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,$4,$5,$6)',
    [t.org,t.integration,t.conversation,contactId,linked.source_id,remote.id]);
   const entries:({type:'TEXT';text:string}|{type:'MEDIA';mediaId:string;caption:string;sourceKey:string})[]=[{type:'TEXT',text:'Olá, sincronização 🙂'}];
   for(const fixture of [{file:'sample.png',mime:'image/png',kind:'image' as const},{file:'sample.ogg',mime:'audio/ogg',kind:'audio' as const},{file:'sample.pdf',mime:'application/pdf',kind:'document' as const}]){
    const sourceKey=`synthetic-native-${randomUUID()}`,bytes=readFileSync(join(process.env.HISTORY_LAB2_CHECKOUT!,'spec/assets',fixture.file));
    const fileName=fixture.kind==='document'?'界'.repeat(100)+'.pdf':fixture.file;
    downloads.set(sourceKey,{bytes,mimeType:fixture.mime,kind:fixture.kind,fileName});
    const mediaId=await db.transact(t.org,tx=>registerPendingMedia(tx,t.org,t.channel,{source:'QR',sourceKey,kind:fixture.kind,fileName,descriptor:{messageId:sourceKey}}));
    await media.runOnce(t.org);entries.push({type:'MEDIA',mediaId,caption:'Legenda íntegra 🙂',sourceKey});
   }
   for(const [ordinal,content]of entries.entries()){
    const sourceAt=1_600_000_100-ordinal; // Older arrivals cannot move the current list backwards.
    const canonical=(await db.database.pool.query("INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state,created_at) VALUES($1,$2,$3,'INCOMING','CONTACT',$4::jsonb,'DELIVERED',to_timestamp($5)) RETURNING id",
     [t.org,t.channel,t.conversation,JSON.stringify(content.type==='TEXT'?content:{type:'MEDIA',mediaId:content.mediaId,caption:content.caption}),sourceAt])).rows[0].id as string;
    if(index===0&&ordinal===1){docker(['stop','--time','3',sidekiq]);sidekiqPaused=true;}
    await createChatwootWorker(options).runOnce(t.org);
    let row=(await db.database.pool.query('SELECT status,payload,last_error FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,canonical])).rows[0];
    if(sidekiqPaused){
     const pending=await lab('native-read',{protocol:'native-read/v1',accountId:consumer.accountId,brokerMessageId:canonical});
     expect(row.status).toBe('UNKNOWN');expect(pending).toMatchObject({messages:0,publishedAt:null,receipt:{state:'MEDIA_PENDING',message_id:null}});
     expect(pending.stagedBytes).toBeGreaterThan(0);
     docker(['start',sidekiq]);sidekiqPaused=false;
    }
    for(let n=0;n<60&&row.status!=='SUCCEEDED';n++){
     if(row.status!=='UNKNOWN')throw Error(`SYNTHETIC_NATIVE_JOB_${row.status}_${row.last_error}`);
     await new Promise(resolve=>setTimeout(resolve,500));
     await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1 AND message_id=$2',[t.org,canonical]);
     await createChatwootWorker(options).runOnce(t.org);
     row=(await db.database.pool.query('SELECT status,payload,last_error FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,canonical])).rows[0];
    }
    expect(row).toMatchObject({status:'SUCCEEDED',payload:{mirrorProtocol:'jrc-live-ingress/1'}});
    expect(posts.get(canonical)).toBe(1);
    const proof=await lab('native-read',{protocol:'native-read/v1',accountId:consumer.accountId,brokerMessageId:canonical});
    expect(proof).toMatchObject({messages:1,outboundObligations:0,stagedBytes:null,receipt:{state:'PERSISTED',message_id:row.payload.remoteMessageId},
     message:{inboxId:consumer.inboxId,conversationId:remote.id,occurredAt:sourceAt,lastActivityAt:1_600_000_100}});
    expect(proof.publishedAt).toBeGreaterThan(sourceAt);
    if(content.type==='MEDIA'){
     const bytes=downloads.get(content.sourceKey)!.bytes;
     expect(proof.byteHashes).toEqual([createHash('sha256').update(bytes).digest('hex')]);
    }else expect(proof.byteHashes).toEqual([]);
    await createChatwootWorker(options).runOnce(t.org);expect(posts.get(canonical)).toBe(1);
   }
   const visible=await api('/conversations?assignee_type=me&inbox_scope=member&status=all','GET',undefined,consumer.agentToken);
   expect(visible.data.payload.find((item:{id:number;inbox_id:number})=>item.id===remote.id&&item.inbox_id===consumer.inboxId)).toMatchObject({unread_count:entries.length});
   const foreign=await fetch(`${origin}/api/v1/accounts/${consumers[1-index]!.accountId}/conversations`,{headers:{api_access_token:consumer.agentToken}});
   expect([401,403]).toContain(foreign.status);
  }
 }finally{if(sidekiqPaused)docker(['start',sidekiq]);await db.dispose();}
},420000);
