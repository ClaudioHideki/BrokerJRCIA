import {createHash,createHmac,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {reconcileWhatsAppGroupParticipation} from '../../src/modules/whatsapp-groups/events.js';
import {createGroupAutomationRuntime,type GroupRuntimeOptions} from '../../src/modules/whatsapp-groups/automation-runtime.js';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
import {chatwootEnvironment,createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {readChatwootAccount} from '../../src/modules/integrations/chatwoot-context.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createS3PrivateObjectStore} from '../../src/modules/messaging/private-object-store.js';
import {createDurablePrivateMediaStore} from '../../src/modules/messaging/durable-private-media.js';
import {initializeHistoryLabBucket} from '../../../../labs/history-sync-lab2/storage-fixture.mjs';

type Consumer={accountId:number;inboxId:number;agentId:number;adminToken:string;agentToken:string};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

// Real group ingestion/authority, Broker PostgreSQL, Rails HTTP, Sidekiq and
// private MinIO. Only source bytes/identity and the final GROUP provider port
// are synthetic; this is not a Baileys socket or physical WhatsApp acceptance.
it.skipIf(process.env.HISTORY_LAB2_E2E!=='true')('mirrors native GROUP text and media into Minhas and returns human replies once to the exact group',async()=>{
 const origin=process.env.HISTORY_LAB2_ORIGIN,endpoint=process.env.HISTORY_LAB_MINIO_ENDPOINT;
 const checkout=process.env.HISTORY_LAB2_CHECKOUT,container=process.env.HISTORY_LAB_RAILS_CONTAINER;
 if(origin!=='http://127.0.0.1:54141'||!/^http:\/\/127[.]0[.]0[.]1:\d+$/u.test(endpoint??'')||!checkout||container!=='jrc-history-v2-http-20261112')
  throw Error('Only dedicated synthetic GROUP laboratory permitted');
 const label=execFileSync('docker',['--context',process.env.HISTORY_LAB_DOCKER_CONTEXT??'desktop-linux','inspect','--format',
  '{{index .Config.Labels "com.jrc.test"}}',container],{encoding:'utf8',timeout:30000}).trim();
 if(label!=='jrc-history-v2-complete-20261112')throw Error('Invalid synthetic container label');
 const lab=async(path:string,body:unknown)=>{
  const r=await fetch(`${origin}/__history_lab/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-History-Lab-Key':process.env.HISTORY_LAB_HTTP_KEY!},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error(`SYNTHETIC_GROUP_FIXTURE_${r.status}`);return r.json();
 };
 const db=await attendanceDatabase();
 try{
  const key=Buffer.alloc(32,85).toString('base64'),configurationScope='synthetic-live-group-http';
  const sources=[];
  for(let n=0;n<2;n++){
   const t=await seedAttendanceTenant(db.database,false),instance=randomUUID(),phone=String(n+1).repeat(11),group=`${n+100}-${n+200}@g.us`;
   const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0]!.user_id;
   const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
   await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
   await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic live group',$1::text,'CONNECTED')",[instance,t.org,provider]);
   await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
   await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
   await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='PUBLISHED',active_version=1 WHERE organization_id=$1 AND id=$2",[t.org,t.automation]);
   await db.database.pool.query('UPDATE automation_versions SET runtime_state_version=2 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation]);
   await createAutomationService({transact:db.transact}).bind(t.org,t.automation,{channelId:t.channel});
   const fingerprint=createHmac('sha256',Buffer.from(key,'base64')).update(`whatsapp-group-identity:v1:${t.org}:${t.channel}:${phone}`).digest('hex');
   const snapshot=randomUUID();
   await db.database.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_revision,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,1,$3,1,$4,clock_timestamp(),clock_timestamp()+interval '20 minutes')`,[t.org,t.channel,fingerprint,snapshot]);
   await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,announce,is_community,is_community_announce,selected)
    VALUES($1,$2,$3,'Synthetic live group',2,false,false,false,true)`,[t.org,t.channel,group]);
   await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
   await db.database.pool.query(`INSERT INTO whatsapp_group_webhook_operations(organization_id,channel_id,instance_id,actor_id,binding_fingerprint,expected_identity_revision,catalog_revision,identity_revision,identity_fingerprint,phase,observed_at)
    VALUES($1,$2,$3,$4,$5,1,1,1,$6,'CONFIRMED',clock_timestamp())`,[t.org,t.channel,instance,actor,
     createHmac('sha256',Buffer.from(key,'base64')).update('whatsapp-group-webhook-binding:v2\0').update(JSON.stringify([configurationScope,t.org,t.channel,instance,instance])).digest('hex'),fingerprint]);
   sources.push({...t,instance,phone,group});
  }
  const consumers=await lab('seed',sources.map(t=>({organizationId:t.org,integrationId:t.integration,instanceId:t.instance}))) as Consumer[];
  await initializeHistoryLabBucket({labOnly:true,endpoint:endpoint!,accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!});
  const objectStore=createS3PrivateObjectStore({endpoint:endpoint!,bucket:'synthetic-broker-history-20261112',profile:'synthetic-history',region:'us-east-1',
   accessKeyId:process.env.HISTORY_LAB_MINIO_ACCESS!,secretAccessKey:process.env.HISTORY_LAB_MINIO_SECRET!,dedicatedBucket:true,allowLoopbackHttpForTests:true,requestTimeoutMs:5000});
  const privateStore=createDurablePrivateMediaStore({transact:db.transact,cleanupTransact:async()=>{throw Error('Cleanup excluded');},encryptionKey:key,
   profile:'synthetic-history',objectStore,maxStorageBytes:64*1024*1024,requestTimeoutMs:5000});
  const bytes=readFileSync(join(checkout,'spec/assets/sample.png')),digest=sha(bytes),participant='12345@lid';
  for(const[index,t]of sources.entries()){
   const consumer=consumers[index]!;
   const api=async(path:string,method='GET',body?:unknown,token=consumer.adminToken)=>{
    const r=await fetch(`${origin}/api/v1/accounts/${consumer.accountId}${path}`,{method,headers:{api_access_token:token,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},
     ...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    if(!r.ok)throw Error(`SYNTHETIC_GROUP_API_${method}_${r.status}`);return r.json();
   };
   const sends:Array<{kind:'TEXT'|'MEDIA';groupJid:string;messageId:string;providerId:string;text?:string;hash?:string}>=[];
   await api(`/inboxes/${consumer.inboxId}`,'PUT',{greeting_enabled:false,enable_auto_assignment:false});
   const groupOptions:GroupRuntimeOptions={transact:db.transact,encryptionKey:key,configurationScope,requestTimeoutMs:30000,
    readIdentity:async()=>({connected:true,phone:t.phone,groupsIgnore:false}),
    sendText:async(ctx,instance,recipient,text)=>{
     expect(instance).toBe(t.instance);expect(recipient).toEqual({kind:'GROUP',groupJid:t.group});
     expect(ctx.engineIntent).toMatchObject({kind:'QR_DISPATCH'});
     if(ctx.engineIntent?.kind!=='QR_DISPATCH')throw Error('Synthetic GROUP dispatch intent missing');
     const providerId=`synthetic-group-text-${index}`;
     sends.push({kind:'TEXT',groupJid:recipient.groupJid,messageId:ctx.engineIntent.messageId,providerId,text});return{upstreamMessageId:providerId};
    },
    sendMedia:async(ctx,instance,recipient,file)=>{
     expect(instance).toBe(t.instance);expect(recipient).toEqual({kind:'GROUP',groupJid:t.group});expect(sha(file.bytes)).toBe(digest);
     expect(file.mimeType).toBe('image/png');expect(file.caption).toBe('Synthetic human GROUP attachment');
     expect(ctx.engineIntent).toMatchObject({kind:'QR_DISPATCH'});
     if(ctx.engineIntent?.kind!=='QR_DISPATCH')throw Error('Synthetic GROUP dispatch intent missing');
     const providerId=`synthetic-group-media-${index}`;
     sends.push({kind:'MEDIA',groupJid:recipient.groupJid,messageId:ctx.engineIntent.messageId,providerId,hash:sha(file.bytes)});return{upstreamMessageId:providerId};
    }};
   const posts=new Map<string,number>();let loseAck=true;
   const options:ChatwootOptions={baseUrl:origin,publicOrigin:'https://synthetic.example.test',allowLocal:true,encryptionKey:key,transact:db.transact,
    groupPolicy:groupOptions,resolveIntegration:async id=>id===t.integration?t.org:undefined,async fetch(input,init){
     const url=new URL(String(input));if(url.origin!==origin)throw Error('Synthetic GROUP HTTP escaped laboratory');
     if(url.pathname.startsWith('/rails/active_storage/blobs/redirect/'))url.pathname=url.pathname.replace('/blobs/redirect/','/blobs/proxy/');
     const response=await fetch(url,init);
     if(url.pathname.endsWith('/live-ingress/v1/messages')){
      const envelope=init?.body instanceof FormData?JSON.parse(String(init.body.get('envelope'))):JSON.parse(String(init?.body));
      posts.set(envelope.broker_message_id,(posts.get(envelope.broker_message_id)??0)+1);
      if(loseAck&&response.ok){loseAck=false;await response.arrayBuffer();throw Error('Synthetic GROUP ACK lost after COMMIT');}
     }
     return response;
    }};
   const env=chatwootEnvironment(options),secret=`synthetic-${randomUUID()}`;
   await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode,approval_status) VALUES($1,$2,'MANAGED','APPROVED')",[t.org,origin]);
   await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,$3,$4,'READY')",[t.org,origin,consumer.accountId,env.vault.encrypt(`${t.org}:chatwoot-account`,consumer.adminToken)]);
   await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,$4,'Synthetic GROUP HTTP','READY',$5)",
    [t.integration,t.org,t.channel,consumer.inboxId,env.vault.encrypt(`${t.org}:chatwoot-webhook:${t.integration}`,secret)]);
   const account=(await db.transact(t.org,tx=>readChatwootAccount(tx,t.org)))!;
   const client=env.client(account);
   const media=createMediaStore({transact:db.transact,encryptionKey:key,privateStore,maxStorageBytes:64*1024*1024,download:async asset=>{
    if(asset.source==='QR')return{bytes,mimeType:'image/png',kind:'image',fileName:'sample.png'};
    expect(asset.source).toBe('CHATWOOT');expect(asset.descriptor.groupReply).toBe(true);
    return client.downloadAttachment(consumer.accountId,consumer.inboxId,Number(asset.descriptor.conversationId),Number(asset.descriptor.messageId),Number(asset.descriptor.attachmentId));
   }});
   options.media=media;groupOptions.media=media;
   const runtime=createGroupAutomationRuntime(groupOptions);
   const service=createChatwootService(options);
   const runMirror=()=>createChatwootWorker(options).runOnce(t.org);
   const ingest=async(id:string,kind:'TEXT'|'MEDIA')=>{
    const event=normalizeQrEvent({instance:t.instance,event:'messages.upsert',data:{key:{id,remoteJid:t.group,fromMe:false,participant},
     message:kind==='TEXT'?{conversation:'Synthetic incoming GROUP text'}:{imageMessage:{fileName:'sample.png',mimetype:'image/png',caption:'Synthetic incoming GROUP attachment'}},
     messageTimestamp:Math.floor(Date.now()/1000)}},t.instance)[0]!;
    return db.transact(t.org,tx=>runtime.ingestWithinTransaction(tx,t.org,t.channel,event as never));
   };
   let remoteConversationId=0;
   for(const kind of ['TEXT','MEDIA'] as const){
    const sourceId=randomUUID();await ingest(sourceId,kind);await ingest(sourceId,kind);if(kind==='MEDIA')await media.runOnce(t.org);
    const canonical=(await db.database.pool.query("SELECT id,conversation_id FROM messaging_messages WHERE organization_id=$1 AND direction='INCOMING' AND upstream_message_id=$2",[t.org,sourceId])).rows;
    expect(canonical).toHaveLength(1);const message=canonical[0]!;
    let job;
    for(let tick=0;tick<60;tick++){
     await runMirror();job=(await db.database.pool.query("SELECT status,last_error,payload FROM integration_jobs WHERE organization_id=$1 AND message_id=$2 AND kind='MIRROR_MESSAGE'",[t.org,message.id])).rows[0];
     if(job?.status==='SUCCEEDED')break;
     if(job?.status==='FAILED')throw Error(`SYNTHETIC_GROUP_MIRROR_${job.last_error}`);
     await db.database.pool.query("UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1 AND message_id=$2 AND status IN('PENDING','UNKNOWN')",[t.org,message.id]);
     await new Promise(resolve=>setTimeout(resolve,500));
    }
    expect(job).toMatchObject({status:'SUCCEEDED',payload:{mirrorProtocol:'jrc-live-ingress/1'}});expect(posts.get(message.id)).toBe(1);
    const proof=await lab('native-read',{protocol:'native-read/v1',accountId:consumer.accountId,brokerMessageId:message.id});
    expect(proof).toMatchObject({stagedBytes:null,receipt:{state:'PERSISTED',message_id:job.payload.remoteMessageId},
     message:{inboxId:consumer.inboxId,content:`[Participante: ${participant}]\nSynthetic incoming GROUP ${kind==='TEXT'?'text':'attachment'}`}});
    expect(proof.byteHashes).toEqual(kind==='MEDIA'?[digest]:[]);
    if(remoteConversationId)expect(proof.message.conversationId).toBe(remoteConversationId);else remoteConversationId=proof.message.conversationId;
    await ingest(sourceId,kind);await runMirror();expect(posts.get(message.id)).toBe(1);
   }
   expect(loseAck).toBe(false);
   await api(`/conversations/${remoteConversationId}/assignments`,'POST',{assignee_id:consumer.agentId});
   const inbound=await api(`/conversations/${remoteConversationId}/messages`);
   expect(inbound.payload.filter((m:{message_type:number})=>m.message_type===0)).toHaveLength(2);
   for(const kind of ['TEXT','MEDIA'] as const){
    const content=kind==='TEXT'?'Synthetic human GROUP text':'Synthetic human GROUP attachment';
    const body=kind==='TEXT'?{content,message_type:'outgoing',private:false}:new FormData();
    if(body instanceof FormData){body.set('content',content);body.set('message_type','outgoing');body.set('private','false');body.append('attachments[]',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'sample.png');}
    const outgoing=await api(`/conversations/${remoteConversationId}/messages`,'POST',body,consumer.agentToken);
    const original=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:outgoing.id});
    expect(original.callback.sender).toMatchObject({id:consumer.agentId,type:'user'});
    const raw=Buffer.from(JSON.stringify(original.callback)),timestamp=String(Math.floor(Date.now()/1000)),signature='sha256='+createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
    await service.ingest(t.integration,raw,timestamp,signature);await service.ingest(t.integration,raw,timestamp,signature);
    for(let tick=0;tick<6;tick++)await runMirror();
    const mapped=(await db.database.pool.query(`SELECT m.id,m.state,m.media_id FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id
     WHERE cm.organization_id=$1 AND cm.integration_id=$2 AND cm.remote_message_id=$3`,[t.org,t.integration,outgoing.id])).rows;
    expect(mapped).toHaveLength(1);const canonical=mapped[0]!;expect(canonical.state).toBe('ACCEPTED');
    if(kind==='MEDIA'){
     await media.runOnce(t.org);expect(sha((await media.read(t.org,canonical.media_id)).bytes)).toBe(digest);
     await expect(media.read(sources[1-index]!.org,canonical.media_id)).rejects.toThrow('MEDIA_NOT_FOUND');
    }
    expect(await createGroupAutomationRuntime(groupOptions).dispatchOnce(t.org)).toMatchObject({status:'SENT'});
    expect(sends.filter(s=>s.messageId===canonical.id)).toEqual([expect.objectContaining({kind,groupJid:t.group})]);
    for(let tick=0;tick<6;tick++)await runMirror();
    const final=await lab('outbound-read',{protocol:'outbound-read/v1',accountId:consumer.accountId,messageId:outgoing.id});
    expect(final.delivery.id).toBe(original.delivery.id);expect(final.message.contentAttributes.jrc_broker_outbound).toMatchObject({state:'SENT',canonical_message_id:canonical.id,provider_message_id:sends.find(s=>s.messageId===canonical.id)!.providerId});
    await service.ingest(t.integration,raw,timestamp,signature);await runMirror();await createGroupAutomationRuntime(groupOptions).dispatchOnce(t.org);
    expect(sends.filter(s=>s.messageId===canonical.id)).toHaveLength(1);
   }
   expect(sends).toHaveLength(2);
   const visible=await api('/conversations?assignee_type=me&inbox_scope=member&status=all','GET',undefined,consumer.agentToken);
   expect(visible.data.payload.filter((row:{id:number;inbox_id:number})=>row.id===remoteConversationId&&row.inbox_id===consumer.inboxId)).toHaveLength(1);
   const foreign=await fetch(`${origin}/api/v1/accounts/${consumers[1-index]!.accountId}/conversations`,{headers:{api_access_token:consumer.agentToken},signal:AbortSignal.timeout(60000)});
   expect([401,403]).toContain(foreign.status);
  }
 }finally{await db.dispose();}
},420000);
