import {createHmac,createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {liveIngressLookup} from '../../src/modules/integrations/chatwoot-live-ingress.js';
import {createChatwootGroupWorker,type GroupIntegrationJob} from '../../src/modules/integrations/chatwoot-group-worker.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {reconcileWhatsAppGroupParticipation} from '../../src/modules/whatsapp-groups/events.js';
import {createGroupAutomationRuntime,type GroupRuntimeOptions,type GroupControlInput} from '../../src/modules/whatsapp-groups/automation-runtime.js';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
import {createChatwootService,chatwootEnvironment,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {createWhatsAppGroupCatalog} from '../../src/modules/whatsapp-groups/service.js';
import {createPostgresObservabilityRepository} from '../../src/modules/observability/service.js';
const key=Buffer.alloc(32,13).toString('base64'),configurationScope='synthetic-g3-scope',phone='5511999990999',group='120363999000001@g.us',author='5511999990001@s.whatsapp.net',other='5511999990002@s.whatsapp.net';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('hello','message',{text:'Bem-vindo ao grupo'}),node('menu','menu',{text:'Escolha',variable:'opcao',options:[{value:'1',label:'Resposta'}]}),node('answer','message',{text:'Resposta do fluxo'}),node('end','end')],
  edges:[{id:'a',source:'start',target:'hello',port:'next'},{id:'b',source:'hello',target:'menu',port:'next'},{id:'c',source:'menu',target:'answer',port:'option-1'},{id:'d',source:'answer',target:'end',port:'next'}]};
describe('PostgreSQL group integration',()=>{
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
async function fixture(overrides:Partial<GroupRuntimeOptions>={}) {
  const t=await seedAttendanceTenant(db.database,false),instance=randomUUID();
  const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0]!.user_id as string;
  const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic group',$1::text,'CONNECTED')",[instance,t.org,provider]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
  await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[t.org]);
  await db.database.pool.query("UPDATE automation_definitions SET lifecycle_status='PUBLISHED',active_version=1 WHERE organization_id=$1 AND id=$2",[t.org,t.automation]);
  await db.database.pool.query('UPDATE automation_versions SET graph=$3,runtime_state_version=2 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(graph)]);
  await createAutomationService({transact:db.transact}).bind(t.org,t.automation,{channelId:t.channel});
  const binding=(await db.database.pool.query('SELECT id,revision FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows[0]!;
  const owner=(await db.database.pool.query('SELECT revision FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',[t.org,t.channel])).rows[0]!;
  const fingerprint=createHmac('sha256',Buffer.from(key,'base64')).update(`whatsapp-group-identity:v1:${t.org}:${t.channel}:${phone}`).digest('hex');
  const snapshot=randomUUID();
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id,identity_revision,identity_fingerprint,catalog_revision,snapshot_id,observed_at,valid_until)
    VALUES($1,$2,1,$3,1,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[t.org,t.channel,fingerprint,snapshot]);
  await db.database.pool.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,announce,is_community,is_community_announce,selected)
    VALUES($1,$2,$3,'Synthetic group',2,false,false,false,true)`,[t.org,t.channel,group]);
  await db.transact(t.org,tx=>reconcileWhatsAppGroupParticipation(tx,t.org,t.channel));
  await db.database.pool.query(`INSERT INTO whatsapp_group_webhook_operations(organization_id,channel_id,instance_id,actor_id,binding_fingerprint,expected_identity_revision,catalog_revision,identity_revision,identity_fingerprint,phase,observed_at)
    VALUES($1,$2,$3,$4,$5,1,1,1,$6,'CONFIRMED',clock_timestamp())`,[t.org,t.channel,instance,actor,
      createHmac('sha256',Buffer.from(key,'base64')).update('whatsapp-group-webhook-binding:v2\0').update(JSON.stringify([configurationScope,t.org,t.channel,instance,instance])).digest('hex'),fingerprint]);
  const sends:Array<{groupJid:string;text:string}>=[];
  const options:GroupRuntimeOptions={transact:db.transact,encryptionKey:key,configurationScope,requestTimeoutMs:30000,
    readIdentity:async()=>({connected:true,phone,groupsIgnore:false}),sendText:async(_ctx,_instance,recipient,text)=>{sends.push({groupJid:recipient.groupJid,text});return{upstreamMessageId:'provider-'+sends.length};},...overrides};
  const runtime=createGroupAutomationRuntime(options),principal={organizationId:t.org,actorId:actor};
  const input:GroupControlInput={groupJid:group,triggerText:'/iniciar',expectedOwnerRevision:owner.revision,expectedBindingId:binding.id,
    expectedBindingRevision:binding.revision,expectedIdentityRevision:1,expectedIdentityFingerprint:fingerprint};
  const event=(text:string,id:string=randomUUID(),participant=author,fromMe=false)=>normalizeQrEvent({instance:instance,event:'messages.upsert',data:{key:{id,remoteJid:group,fromMe,participant},message:{conversation:text},messageTimestamp:Math.floor(Date.now()/1000)}},instance)[0]!;
  const ingest=(text:string,id?:string,participant?:string,fromMe?:boolean)=>db.transact(t.org,tx=>runtime.ingestWithinTransaction(tx,t.org,t.channel,event(text,id,participant,fromMe) as never));
  return{...t,actor,instance,principal,input,runtime,options,sends,ingest,event};
}
async function drain(t:Awaited<ReturnType<typeof fixture>>) {
  for(let i=0;i<10;i++){const result=await t.runtime.enqueueEffectsOnce(t.org);if(!result.processed)break;}
  for(let i=0;i<10;i++){const result=await t.runtime.dispatchOnce(t.org);if(!result.processed)break;}
}

async function central(t:Awaited<ReturnType<typeof fixture>>,unknown=false,inboxPolicy:Record<string,unknown>={},extra:Partial<ChatwootOptions>={},native:false|{lost?:boolean;pending?:boolean;revoke?:boolean;throttleOnce?:boolean}=false){
 const calls:Array<{path:string;method:string;body:any}>=[];let remoteId=100,canonicalMessage:Record<string,unknown>|undefined;const nativeReceipts=new Map<string,Record<string,unknown>>();let nativeRejected=false;
 const options:ChatwootOptions={baseUrl:'https://'+t.org+'.example.test',publicOrigin:'https://broker.example.test',encryptionKey:key,transact:db.transact,groupPolicy:t.options,
  ...extra,resolveIntegration:async id=>id===t.integration?t.org:undefined,fetch:async(input,init)=>{
   const path=new URL(String(input)).pathname,method=init?.method??'GET',body=init?.body instanceof FormData?init.body:init?.body?JSON.parse(String(init.body)):null;calls.push({path,method,body});
   let data:unknown;
   if(path.endsWith('/live-ingress/v1/capability'))return native?Response.json({...body,account_id:7,inbox_id:9,supports_text:true,supports_media:true,max_media_bytes:16*1024*1024}):new Response(null,{status:404});
   if(path.includes('/live-ingress/v1/messages')){
    const envelope=body instanceof FormData?JSON.parse(String(body.get('envelope'))):body;
    const stored=(await db.database.pool.query('SELECT payload FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,envelope.broker_message_id])).rows[0]!.payload;
    expect(stored.mirrorProtocol).toBe('jrc-live-ingress/1');expect(stored.liveIngressProof).toMatchObject({request_hash:envelope.request_hash,instance_id:t.instance,account_id:7,inbox_id:9});
    if(native&&native.throttleOnce&&!nativeRejected){nativeRejected=true;return new Response(null,{status:429});}
    const receipt={protocol:envelope.protocol,organization_id:envelope.organization_id,integration_id:envelope.integration_id,instance_id:envelope.instance_id,destination_revision:envelope.destination_revision,
     broker_message_id:envelope.broker_message_id,conversation_id:envelope.conversation_id,request_hash:envelope.request_hash,receipt_id:randomUUID(),account_id:7,inbox_id:9,
     state:native&&native.pending?'MEDIA_PENDING':'PERSISTED',message_id:native&&native.pending?null:901};
    nativeReceipts.set(envelope.broker_message_id,receipt);
    if(native&&native.revoke)await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[t.org]);
    if(native&&native.lost)throw Error('synthetic native group ACK lost');return Response.json(receipt);
   }
   if(path.includes('/live-ingress/v1/receipts/'))return Response.json(nativeReceipts.get(path.split('/').at(-1)!));
   if(path.endsWith('/contacts/search'))data={payload:[]};
   else if(path.endsWith('/contacts')&&method==='POST')data={payload:{contact:{id:41}}};
   else if(path.endsWith('/contact_inboxes'))data={source_id:body.source_id};
   else if(path.endsWith('/inboxes/9'))data={id:9,name:'Group central',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:false,...inboxPolicy};
   else if(path.endsWith('/agent_bot'))data={};
   else if(path.endsWith('/conversations')&&method==='POST')data={id:51};
   else if(path.endsWith('/conversations/51'))data={id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100,meta:{sender:{id:41},assignee:null,assignee_type:null,team:null}};
   else if(path.endsWith('/messages')&&method==='GET'&&canonicalMessage)data={payload:[canonicalMessage]};
   else if(path.endsWith('/messages')&&method==='POST'){if(unknown)throw Error('synthetic lost receipt');data={id:++remoteId};}
   else if(method==='PATCH')data={};
   else throw Error('Unexpected synthetic endpoint '+method+' '+path);
   return Response.json(data);
  }};
 const vault=chatwootEnvironment(options).vault,secret='synthetic-group-callback';
 await db.database.pool.query('INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status,encrypted_token) VALUES($1,$2,7,\'READY\',$3)',[t.org,options.baseUrl,vault.encrypt(t.org+':chatwoot-account','synthetic-token')]);
 await db.database.pool.query('INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,9,\'Group central\',\'READY\',$4)',[t.integration,t.org,t.channel,vault.encrypt(t.org+':chatwoot-webhook:'+t.integration,secret)]);
 let worker=createChatwootWorker(options);const service=createChatwootService(options);
 const receive=(patch:Record<string,unknown>={})=>{const raw=Buffer.from(JSON.stringify({event:'message_created',id:901,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},message_type:'outgoing',private:false,sender:{id:12,type:'user'},content:'Resposta humana no grupo',...patch})),timestamp=String(Math.floor(Date.now()/1000));return service.ingest(t.integration,raw,timestamp,'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex'));};
 const run=async()=>{for(let i=0;i<20;i++){if(!(await db.database.pool.query("SELECT 1 FROM integration_jobs WHERE organization_id=$1 AND status='PENDING' AND available_at<=now()",[t.org])).rowCount)break;await worker.runOnce(t.org);}
  return(await db.database.pool.query('SELECT kind,status,last_error FROM integration_jobs WHERE organization_id=$1 ORDER BY created_at,id',[t.org])).rows;};
 const restart=async()=>{worker=createChatwootWorker(options);await worker.runOnce(t.org);};
 return{calls,receive,run,restart,nativePersistenceCount:()=>nativeReceipts.size,reconcile:(id:string)=>service.reconcileJob(t.org,id,'Synthetic native group receipt reconciliation'),setNativeReceipt:(patch:Record<string,unknown>)=>{for(const receipt of nativeReceipts.values())Object.assign(receipt,patch);},enableNative:(config:{lost?:boolean;pending?:boolean;revoke?:boolean}={})=>{native=config;},setCanonical:(message:Record<string,unknown>)=>{canonicalMessage=message;}};
}
it('mirrors a selected group without an individual contact and returns an authenticated human reply to the same group',async()=>{
 const t=await fixture();await t.runtime.configure(t.principal,t.channel,t.input);const c=await central(t);
 await t.ingest('/iniciar');expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED'})]));
 const contact=c.calls.find(x=>x.path.endsWith('/contacts')&&x.method==='POST')!.body;
 expect(contact.phone_number).toBeUndefined();expect(contact.email).toBeUndefined();expect(contact.additional_attributes.jrc_broker_recipient_kind).toBe('GROUP');
 expect(await t.runtime.executeOnce(t.org)).toMatchObject({status:'WAITING'});await drain(t);expect(t.sends.length).toBe(3);await c.run();
 await c.receive();await c.receive();expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'SUCCEEDED'})]));
 expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'SENT'});expect(t.sends.at(-1)).toEqual({groupJid:group,text:'Resposta humana no grupo'});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_group_replies WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_contacts WHERE organization_id=$1',[t.org])).rows[0].n).toBe(1);
 await c.receive({id:902,private:true,content:'PRIVATE NEVER SEND'});await c.run();expect(await t.runtime.dispatchOnce(t.org)).toEqual({processed:false});
 const otherTenant=await fixture();expect((await db.transact(otherTenant.org,tx=>tx.query('SELECT scope_key FROM chatwoot_group_scopes'))).rows).toEqual([]);
});
it('keeps a group mirror with an unknown receipt durable across worker restarts without another POST',async()=>{
 const t=await fixture();const c=await central(t,true);await t.ingest('observed only');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'UNKNOWN',last_error:'CHATWOOT_OUTCOME_UNKNOWN'})]));
 expect(await db.transact(t.org,tx=>createPostgresObservabilityRepository().snapshot(tx,t.org))).toMatchObject({integrationFailures:0,integrationUnknown:1});
 const posts=c.calls.filter(x=>x.path.endsWith('/messages')&&x.method==='POST').length;expect(posts).toBe(1);
 await c.restart();expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'UNKNOWN',last_error:'CHATWOOT_OUTCOME_UNKNOWN'})]));
 expect(c.calls.filter(x=>x.path.endsWith('/messages')&&x.method==='POST')).toHaveLength(posts);
});
it('carries canonical provider proof when confirming a human reply to its original group message',async()=>{
 const t=await fixture(),c=await central(t);await t.ingest('Group delivery proof');await c.run();
 await c.receive();await c.run();expect(await t.runtime.dispatchOnce(t.org)).toMatchObject({status:'SENT'});
 const message=(await db.database.pool.query(`SELECT m.id,m.upstream_message_id FROM messaging_messages m
  JOIN chatwoot_group_replies r ON r.organization_id=m.organization_id AND r.message_id=m.id
  WHERE m.organization_id=$1`,[t.org])).rows[0];
 expect(message?.upstream_message_id).toBeTruthy();await c.run();
 const receipt=c.calls.find(x=>x.method==='PATCH'&&x.path.endsWith('/messages/901'))?.body;
 expect(receipt).toMatchObject({status:'sent',broker_delivery:{version:1,canonical_message_id:message.id,
  provider_message_id:message.upstream_message_id,state:'SENT'}});
 expect(t.sends).toHaveLength(1);
});
it('does not dispatch a queued human group reply after destination authorization is revoked',async()=>{
 const t=await fixture();const c=await central(t);await t.ingest('observed only');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED',last_error:null})]));
 await c.receive();expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'SUCCEEDED',last_error:null})]));
 expect((await db.database.pool.query(`SELECT count(*)::int AS n FROM messaging_outbox o
  JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
  JOIN chatwoot_group_replies r ON r.organization_id=m.organization_id AND r.message_id=m.id
  WHERE o.organization_id=$1 AND m.source='OPERATOR' AND m.state='ACCEPTED'`,[t.org])).rows).toEqual([{n:1}]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[t.org]);
 expect(await t.runtime.dispatchOnce(t.org)).toEqual({processed:false});expect(t.sends).toEqual([]);
});

it('renews an expired selected group for central mirroring with Flow disabled and no group bot',async()=>{
 const t=await fixture();const c=await central(t);
 await db.database.pool.query('UPDATE flow_features SET enabled=false WHERE organization_id=$1',[t.org]);
 await db.database.pool.query("UPDATE whatsapp_group_catalogs SET observed_at=clock_timestamp()-interval '6 minutes',valid_until=clock_timestamp()-interval '1 minute',last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE organization_id=$1",[t.org]);
 let reads=0;
 const catalog=createWhatsAppGroupCatalog({encryptionKey:key,transact:db.transact,
  readIdentity:async()=>({connected:true,phone}),
  readGroups:async()=>{reads++;return[{groupJid:group,subject:'Synthetic group',participantCount:2,restrict:false,announce:false,isCommunity:false,isCommunityAnnounce:false,linkedParent:null}];}});
 expect(await catalog.refreshDueForCentral(t.org)).toMatchObject({processed:true,status:'CURRENT',channelId:t.channel});
 expect(reads).toBe(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM whatsapp_group_automation_controls WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
 await t.ingest('Selected group mirror after idle period');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED'})]));
 expect(t.sends).toEqual([]);
 expect(await catalog.refreshDueForCentral(t.org)).toEqual({processed:false});
 expect(reads).toBe(1);
});

it('does not publish a central group refresh after the destination is revoked during provider I/O',async()=>{
 const t=await fixture();await central(t);
 await db.database.pool.query("UPDATE whatsapp_group_catalogs SET observed_at=clock_timestamp()-interval '6 minutes',valid_until=clock_timestamp()-interval '1 minute',last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE organization_id=$1",[t.org]);
 const catalog=createWhatsAppGroupCatalog({encryptionKey:key,transact:db.transact,
  readIdentity:async()=>({connected:true,phone}),
  readGroups:async()=>{await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[t.org]);return[];}});
 expect(await catalog.refreshDueForCentral(t.org)).toMatchObject({processed:true,status:'FAILED',code:'GROUP_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT valid_until>clock_timestamp() AS current FROM whatsapp_group_catalogs WHERE organization_id=$1',[t.org])).rows[0].current).toBe(false);
});

it.each([
 "UPDATE chatwoot_connections SET status='DISABLED' WHERE organization_id=$1",
 "UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",
 "UPDATE instances SET status='DISCONNECTED' WHERE organization_id=$1",
])('does not poll a central group catalog outside current scope: %s',async sql=>{
 const t=await fixture();await central(t);
 await db.database.pool.query("UPDATE whatsapp_group_catalogs SET observed_at=clock_timestamp()-interval '6 minutes',valid_until=clock_timestamp()-interval '1 minute',last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query(sql,[t.org]);
 const catalog=createWhatsAppGroupCatalog({encryptionKey:key,transact:db.transact,
  readIdentity:async()=>{throw Error('Must not contact provider');},readGroups:async()=>{throw Error('Must not contact provider');}});
 expect(await catalog.refreshDueForCentral(t.org)).toEqual({processed:false});
});

it.each([
 ["UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1",'GROUP_NOT_SELECTED'],
 ["UPDATE whatsapp_group_catalogs SET observed_at=clock_timestamp()-interval '6 minutes',valid_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",'GROUP_CATALOG_STALE'],
 ["DELETE FROM whatsapp_group_participation WHERE organization_id=$1",'GROUP_PARTICIPATION_UNVERIFIED'],
 ["UPDATE whatsapp_group_webhook_operations SET phase='UNKNOWN',dispatched_at=clock_timestamp() WHERE organization_id=$1",'GROUP_WEBHOOK_UNCONFIRMED'],
])('retains the scope guard and records a safe actionable blocker: %s',async(sql,blocker)=>{
 const t=await fixture();const c=await central(t);await t.ingest('Synthetic blocked group message');
 await db.database.pool.query(sql,[t.org]);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'FAILED',last_error:'GROUP_CENTRAL_SCOPE_CHANGED'})]));
 const jobs=(await db.database.pool.query("SELECT payload FROM integration_jobs WHERE organization_id=$1 AND kind='MIRROR_MESSAGE'",[t.org])).rows;
 expect(jobs).toHaveLength(1);expect(jobs[0].payload.groupScopeBlocker).toBe(blocker);
 expect(c.calls).toEqual([]);expect(t.sends).toEqual([]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_group_scopes WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
});

it.each([
 [{id:10},'CHATWOOT_BINDING_MISMATCH'],
 [{channel_type:'Channel::Email'},'CHATWOOT_BINDING_MISMATCH'],
 [{greeting_enabled:true},'CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION'],
 [{enable_auto_assignment:true},'CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION'],
])('distinguishes wrong group inbox binding from attendance configuration: %j',async(policy,code)=>{
 const t=await fixture();const c=await central(t,false,policy);await t.ingest('Synthetic policy-guarded message');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'FAILED',last_error:code})]));
 expect(c.calls.filter(call=>call.method==='POST'&&(call.path.endsWith('/conversations')||call.path.endsWith('/messages')))).toEqual([]);
 expect(t.sends).toEqual([]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_group_scopes WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
});


const groupMediaTypes={image:'image/png',audio:'audio/ogg',video:'video/mp4',document:'application/pdf',sticker:'image/webp'} as const;
async function ingestGroupMedia(t:Awaited<ReturnType<typeof fixture>>,kind:keyof typeof groupMediaTypes,id:string,caption='Synthetic full caption',participant='12345@lid'){
 const event=normalizeQrEvent({instance:t.instance,event:'messages.upsert',data:{key:{id,remoteJid:group,fromMe:false,participant},
  message:{[kind+'Message']:{fileName:'synthetic-'+kind,mimetype:groupMediaTypes[kind],caption}},messageTimestamp:Math.floor(Date.now()/1000)}},t.instance)[0]!;
 return db.transact(t.org,tx=>t.runtime.ingestWithinTransaction(tx,t.org,t.channel,event as never));
}
function groupMediaStore(t:Awaited<ReturnType<typeof fixture>>,kind:keyof typeof groupMediaTypes){
 const bytes=new Uint8Array(Buffer.from('SYNTHETIC-GROUP-BYTES-'+kind));
 const media=createMediaStore({transact:db.transact,encryptionKey:key,download:async asset=>{
  expect(asset.organization_id).toBe(t.org);expect(asset.channel_id).toBe(t.channel);
  return{bytes,mimeType:groupMediaTypes[kind],kind,fileName:'synthetic-'+kind};
 }});return{media,bytes};
}
it.each(Object.keys(groupMediaTypes) as Array<keyof typeof groupMediaTypes>)('mirrors authorized live group %s as one private attachment preserving full caption and LID participant',async kind=>{
 const t=await fixture(),h=groupMediaStore(t,kind),c=await central(t,false,{}, {media:h.media}),id=randomUUID(),caption='c'.repeat(1024);
 await ingestGroupMedia(t,kind,id,caption);await ingestGroupMedia(t,kind,id,caption);await h.media.runOnce(t.org);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED',last_error:null})]));
 const posts=c.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'));expect(posts).toHaveLength(1);
 const form=posts[0]!.body as FormData;expect(form).toBeInstanceOf(FormData);
 expect(form.get('content')).toBe('[Participante: 12345@lid]\n'+caption);expect(form.get('message_type')).toBe('incoming');
 const blob=form.get('attachments[]') as File;expect(blob.type).toBe(groupMediaTypes[kind]);expect(blob.name).toBe('synthetic-'+kind);
 expect(new Uint8Array(await blob.arrayBuffer())).toEqual(h.bytes);
 const attributes=JSON.parse(String(form.get('content_attributes')));
 const message=(await db.database.pool.query("SELECT id FROM messaging_messages WHERE organization_id=$1 AND direction='INCOMING'",[t.org])).rows[0];
 expect(attributes).toEqual({jrc_broker_message_id:message.id});
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'CONFIRMED'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{n:1}]);
 const stored=(await db.database.pool.query('SELECT sha256,status FROM messaging_media WHERE organization_id=$1',[t.org])).rows[0];
 expect(stored).toEqual({sha256:createHash('sha256').update(h.bytes).digest('hex'),status:'READY'});
 const contact=c.calls.find(x=>x.method==='POST'&&x.path.endsWith('/contacts'))!.body;expect(contact.phone_number).toBeUndefined();
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_executions WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
 await c.restart();expect(c.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'))).toHaveLength(1);expect(t.sends).toEqual([]);
});
it('retains pending group media without sending a remote message or recording a mirror attempt, then retries the same bytes',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media});await ingestGroupMedia(t,'image',randomUUID());
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'PENDING',last_error:'MEDIA_NOT_READY'})]));
 expect(c.calls).toEqual([]);expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
 await h.media.runOnce(t.org);await db.database.pool.query("UPDATE integration_jobs SET available_at=now() WHERE organization_id=$1",[t.org]);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'SUCCEEDED'})]));
 expect(c.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'))).toHaveLength(1);
});
it('revalidates group authority after reading private media and refuses a revoked destination before external I/O',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'image');
 const media={...h.media,read:async(...args:Parameters<typeof h.media.read>)=>{const file=await h.media.read(...args);
  await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[t.org]);return file;}};
 const c=await central(t,false,{}, {media});await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'FAILED',last_error:'GROUP_CENTRAL_SCOPE_CHANGED'})]));expect(c.calls).toEqual([]);
});
it('keeps a group media POST with a lost receipt UNKNOWN and never retransmits it on restart',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'document'),c=await central(t,true,{}, {media:h.media});await ingestGroupMedia(t,'document',randomUUID());await h.media.runOnce(t.org);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'UNKNOWN',last_error:'CHATWOOT_OUTCOME_UNKNOWN'})]));
 await c.restart();expect(c.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'UNKNOWN'}]);
});

it('never falls back from historical group media to a live multipart message',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media});
 await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);
 await db.database.pool.query('UPDATE messaging_messages SET is_historical=true WHERE organization_id=$1',[t.org]);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'FAILED',last_error:'GROUP_CENTRAL_HISTORY_REQUIRES_HISTORY_SYNC'})]));
 expect(c.calls).toEqual([]);
});
it('presents a group attachment without a caption while preserving its private bytes',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'audio'),c=await central(t,false,{}, {media:h.media});
 await ingestGroupMedia(t,'audio',randomUUID(),'');await h.media.runOnce(t.org);await c.run();
 const posts=c.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'));expect(posts).toHaveLength(1);
 expect((posts[0]!.body as FormData).get('content')).toBe('[Participante: 12345@lid]\n[Anexo]');
 expect(new Uint8Array(await ((posts[0]!.body as FormData).get('attachments[]') as Blob).arrayBuffer())).toEqual(h.bytes);
});
it.each([
 "UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1",
 "DELETE FROM whatsapp_group_participation WHERE organization_id=$1",
 "UPDATE whatsapp_group_webhook_operations SET phase='UNKNOWN',dispatched_at=clock_timestamp() WHERE organization_id=$1",
])('refuses group media before plaintext read or network outside current authority: %s',async sql=>{
 const t=await fixture(),h=groupMediaStore(t,'image');let reads=0;
 const media={...h.media,read:async(...args:Parameters<typeof h.media.read>)=>{reads++;return h.media.read(...args);}};
 const c=await central(t,false,{}, {media});await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);
 await db.database.pool.query(sql,[t.org]);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'FAILED',last_error:'GROUP_CENTRAL_SCOPE_CHANGED'})]));
 expect(reads).toBe(0);expect(c.calls).toEqual([]);expect(t.sends).toEqual([]);
});

async function humanGroupMediaFixture(kind:keyof typeof groupMediaTypes='document',lost=false){
 const sent:Array<{recipient:{kind:string;groupJid:string};file:any;intent:any}>=[],t=await fixture(),h=groupMediaStore(t,kind);
 Object.assign(t.options,{media:h.media,sendMedia:async(context:any,_instance:string,recipient:any,file:any)=>{
  sent.push({recipient,file,intent:context.engineIntent});if(lost)throw Object.assign(Error('synthetic lost media receipt'),{code:'QR_SEND_UNKNOWN',uncertain:true});return{upstreamMessageId:sent.length===1?'human-group-media-receipt':'human-group-media-receipt-'+sent.length};
 }});
 const c=await central(t,false,{}, {media:h.media});await t.ingest('Human media bootstrap');await c.run();
 const intent=randomUUID(),caption=kind==='sticker'?'':kind==='image'?'c'.repeat(1024):'Original human media caption',remoteId=991;
 const marker={version:1,state:'PENDING',intent_id:intent,integration_id:t.integration,inbox_id:9};
 const attachment={id:801,file_type:kind==='document'?'file':kind==='sticker'?'image':kind};
 const canonical={id:remoteId,account_id:7,inbox_id:9,conversation_id:51,message_type:1,private:false,sender:{id:12,type:'user'},
  content:caption,content_attributes:{jrc_broker_outbound:marker},attachments:[attachment],created_at:1700000000};
 c.setCanonical(canonical);
 const enqueue=async(patch:Record<string,unknown>={})=>c.receive({id:remoteId,content:caption,content_attributes:{jrc_broker_outbound:marker},attachments:[attachment],...patch});
 return{t,h,c,sent,caption,canonical,enqueue};
}
it.each(Object.keys(groupMediaTypes) as Array<keyof typeof groupMediaTypes>)('enqueues and dispatches a proven human group %s attachment once through private custody and the dedicated group media port',async kind=>{
 const f=await humanGroupMediaFixture(kind);await f.enqueue();await f.enqueue();
 expect(await f.c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'SUCCEEDED'})]));
 const messages=(await db.database.pool.query("SELECT id,content,state,media_id FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR'",[f.t.org])).rows;
 expect(messages).toHaveLength(1);const message=messages[0]!;expect(message.content).toMatchObject({type:'MEDIA',kind:kind==='sticker'?'image':kind,...(f.caption?{caption:f.caption}:{})});expect(message.media_id).toBe(message.content.mediaId);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_group_replies WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:1}]);
 await f.t.runtime.dispatchOnce(f.t.org);expect(f.sent).toEqual([]);
 expect((await db.database.pool.query('SELECT state,canonical_error_code FROM messaging_messages WHERE id=$1',[message.id])).rows).toEqual([{state:'ACCEPTED',canonical_error_code:'MEDIA_NOT_READY'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:0}]);
 await f.h.media.runOnce(f.t.org);await db.database.pool.query('UPDATE messaging_outbox SET available_at=now() WHERE organization_id=$1',[f.t.org]);
 const restarted=createGroupAutomationRuntime(f.t.options);expect(await restarted.dispatchOnce(f.t.org)).toMatchObject({status:'SENT'});
 expect(f.sent).toHaveLength(1);expect(f.sent[0]!.recipient).toEqual({kind:'GROUP',groupJid:group});expect(f.sent[0]!.file).toMatchObject({bytes:f.h.bytes,mimeType:groupMediaTypes[kind],fileName:'synthetic-'+kind,...(f.caption?{caption:f.caption}:{})});
 expect(f.sent[0]!.intent).toMatchObject({kind:'QR_DISPATCH',messageId:message.id});
 expect((await db.database.pool.query('SELECT state,provider_message_id FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{state:'CONFIRMED',provider_message_id:'human-group-media-receipt'}]);
 await f.c.restart();await restarted.dispatchOnce(f.t.org);expect(f.sent).toHaveLength(1);expect(f.t.sends).toEqual([]);
});
it.each(['intent','sender','attachments','private','historical'] as const)('refuses human group media canonical %s drift before asset/outbox admission',async drift=>{
 const f=await humanGroupMediaFixture();await f.enqueue();
 const patch=drift==='intent'?{content_attributes:{jrc_broker_outbound:{...f.canonical.content_attributes.jrc_broker_outbound,intent_id:randomUUID()}}}:
  drift==='sender'?{sender:{id:99,type:'user'}}:drift==='attachments'?{attachments:[{id:802,file_type:'file'}]}:drift==='private'?{private:true}:{additional_attributes:{jrc_broker_historical:true}};
 f.c.setCanonical({...f.canonical,...patch});
 expect(await f.c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'FAILED',last_error:'CHATWOOT_HUMAN_INTENT_NOT_PROVEN'})]));
 expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR'",[f.t.org])).rows).toEqual([{n:0}]);
 expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_media WHERE organization_id=$1 AND source='CHATWOOT'",[f.t.org])).rows).toEqual([{n:0}]);expect(f.sent).toEqual([]);
});
it('refuses a human group attachment without durable version1 intent',async()=>{
 const f=await humanGroupMediaFixture();await f.enqueue({content_attributes:{}});
 expect(await f.c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'FAILED',last_error:'GROUP_CENTRAL_MEDIA_PROOF_REQUIRED'})]));expect(f.sent).toEqual([]);
});
it('keeps an uncertain human group media send UNKNOWN across runtime restart without another provider call',async()=>{
 const f=await humanGroupMediaFixture('document',true);await f.enqueue();await f.c.run();await f.h.media.runOnce(f.t.org);
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'UNKNOWN'});expect(f.sent).toHaveLength(1);
 expect(await createGroupAutomationRuntime(f.t.options).dispatchOnce(f.t.org)).toEqual({processed:false});expect(f.sent).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{state:'UNKNOWN'}]);
});
it('revalidates human group authority after private bytes are prepared and never claims or sends after revocation',async()=>{
 const f=await humanGroupMediaFixture();await f.enqueue();expect(await f.c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'SUCCEEDED'})]));await f.h.media.runOnce(f.t.org);
 Object.assign(f.t.options,{media:{...f.h.media,read:async(...args:Parameters<typeof f.h.media.read>)=>{const value=await f.h.media.read(...args);
  await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[f.t.org]);return value;}}});
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toEqual({processed:false});expect(f.sent).toEqual([]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:0}]);
});

async function multipleHumanGroupMedia(){
 const f=await humanGroupMediaFixture();f.canonical.attachments.push({id:802,file_type:'file'});f.c.setCanonical(f.canonical);
 await f.enqueue({attachments:f.canonical.attachments});await f.c.run();await f.h.media.runOnce(f.t.org);await f.h.media.runOnce(f.t.org);return f;
}
it('aggregates multiple human group attachments without early sent/read status and pins one stable canonical representative',async()=>{
 const f=await multipleHumanGroupMedia();
 expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR'",[f.t.org])).rows).toEqual([{n:2}]);
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'SENT'});await f.c.run();
 const statuses=()=>f.c.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/messages/991'));
 expect(statuses()).toEqual([]);
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'SENT'});await f.c.run();
 const representative=(await db.database.pool.query("SELECT id,upstream_message_id FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR' ORDER BY created_at,id",[f.t.org])).rows[0]!;
 expect(statuses().at(-1)!.body).toMatchObject({status:'sent',broker_delivery:{canonical_message_id:representative.id,provider_message_id:representative.upstream_message_id,state:'SENT'}});
 await db.database.pool.query("UPDATE messaging_messages SET state='READ' WHERE id=$1",[representative.id]);await f.c.run();expect(statuses().at(-1)!.body.status).toBe('sent');
 await db.database.pool.query("UPDATE messaging_messages SET state='READ' WHERE organization_id=$1 AND source='OPERATOR'",[f.t.org]);await f.c.run();
 expect(statuses().at(-1)!.body.status).toBe('read');expect(statuses().every(x=>x.body.broker_delivery.canonical_message_id===representative.id)).toBe(true);expect(f.sent).toHaveLength(2);
 expect(f.sent[0]!.file.caption).toBe(f.caption);expect(f.sent[1]!.file.caption).toBeUndefined();
});
it('never reports sent for multiple human group attachments when the second ACK is UNKNOWN and never replays it',async()=>{
 const f=await multipleHumanGroupMedia();expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'SENT'});await f.c.run();
 Object.assign(f.t.options,{sendMedia:async(context:any,_instance:string,recipient:any,file:any)=>{f.sent.push({recipient,file,intent:context.engineIntent});throw Object.assign(Error('lost second ACK'),{code:'QR_SEND_UNKNOWN',uncertain:true});}});
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'UNKNOWN'});await f.c.run();
 expect(f.c.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/messages/991'))).toEqual([]);
 expect(await createGroupAutomationRuntime(f.t.options).dispatchOnce(f.t.org)).toEqual({processed:false});expect(f.sent).toHaveLength(2);
 expect((await db.database.pool.query("SELECT state FROM qr_dispatch_attempts WHERE organization_id=$1 ORDER BY created_at,id",[f.t.org])).rows).toEqual([{state:'CONFIRMED'},{state:'UNKNOWN'}]);
});

it('retains private group bytes but refuses a human media dispatch after credential revision changes',async()=>{
 const f=await humanGroupMediaFixture();await f.enqueue();await f.c.run();await f.h.media.runOnce(f.t.org);
 await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[f.t.org]);
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toEqual({processed:false});expect(f.sent).toEqual([]);
 expect((await db.database.pool.query('SELECT status FROM messaging_media WHERE organization_id=$1',[f.t.org])).rows).toEqual([{status:'READY'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:0}]);
});
it('refuses corrupt private group media before leasing or provider POST and retains its durable obligation',async()=>{
 const f=await humanGroupMediaFixture();await f.enqueue();await f.c.run();await f.h.media.runOnce(f.t.org);
 await db.database.pool.query("UPDATE messaging_media SET sha256=repeat('0',64) WHERE organization_id=$1",[f.t.org]);
 expect(await f.t.runtime.dispatchOnce(f.t.org)).toMatchObject({status:'BLOCKED',code:'MEDIA_INTEGRITY_FAILED'});expect(f.sent).toEqual([]);
 expect((await db.database.pool.query("SELECT state,canonical_error_code FROM messaging_messages WHERE organization_id=$1 AND source='OPERATOR'",[f.t.org])).rows).toEqual([{state:'ACCEPTED',canonical_error_code:'MEDIA_INTEGRITY_FAILED'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:0}]);
});
it('fails closed for a human group caption beyond provider limits without truncating or registering an asset',async()=>{
 const f=await humanGroupMediaFixture();await f.enqueue({content:'x'.repeat(1025)});
 expect(await f.c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CHATWOOT_REPLY',status:'FAILED',last_error:'GROUP_CENTRAL_MEDIA_CAPTION_LIMIT'})]));
 expect((await db.database.pool.query("SELECT count(*)::int AS n FROM messaging_media WHERE organization_id=$1 AND source='CHATWOOT'",[f.t.org])).rows).toEqual([{n:0}]);expect(f.sent).toEqual([]);
});


it.each([{media:false,lost:false},{media:true,lost:true}])('commits a native GROUP receipt with one message POST across lost ACK and private media: %j',async mode=>{
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media},{lost:mode.lost});
 if(mode.media){await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);}else await t.ingest('Native group text');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED',last_error:null})]));
 expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);expect(c.calls[0]!.path).toContain('/capability');
 expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/receipts/'))).toHaveLength(mode.lost?1:0);
 expect(c.calls.some(x=>x.path==='/api/v1/accounts/7/conversations/51/messages')).toBe(false);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'CONFIRMED'}]);
 const payload=(await db.database.pool.query('SELECT payload FROM integration_jobs WHERE organization_id=$1',[t.org])).rows[0]!.payload;
 expect(payload.liveIngressProof).toMatchObject({instance_id:t.instance,account_id:7,inbox_id:9,credential_revision:1,receipt_id:expect.any(String)});
 await c.restart();expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);
});
it('keeps native GROUP media custody pending with one pinned receipt and no POST after restart',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media},{pending:true});
 await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'UNKNOWN',last_error:'CHATWOOT_LIVE_CONFIRMATION_PENDING'})]));
 const payload=(await db.database.pool.query('SELECT payload FROM integration_jobs WHERE organization_id=$1',[t.org])).rows[0]!.payload;expect(payload.liveIngressProof.receipt_id).toBeTruthy();
 await c.restart();expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
});
it('does not upgrade a legacy unknown GROUP mirror after native capability is installed',async()=>{
 const t=await fixture(),c=await central(t,true);await t.ingest('Legacy unknown group');await c.run();c.enableNative();await c.restart();
 expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toEqual([]);
 expect(c.calls.filter(x=>x.path==='/api/v1/accounts/7/conversations/51/messages')).toHaveLength(1);
 const payload=(await db.database.pool.query('SELECT payload FROM integration_jobs WHERE organization_id=$1',[t.org])).rows[0]!.payload;expect(payload.mirrorProtocol).toBe('GENERIC');expect(payload.liveIngressProof).toBeUndefined();
});
it('retains a native GROUP attempt as uncertain if destination authority changes during POST',async()=>{
 const t=await fixture(),c=await central(t,false,{}, {},{lost:true,revoke:true});await t.ingest('Native scope revoke');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({status:'UNKNOWN'})]));
 expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);expect(c.calls.filter(x=>x.path.includes('/live-ingress/v1/receipts/'))).toHaveLength(0);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
});


async function pendingNativeGroup(existingMap=false){
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media},existingMap?false:{pending:true});
 if(existingMap){await t.ingest('Existing group display map');await c.run();c.enableNative({pending:true});}
 await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);await c.run();
 const job=(await db.database.pool.query("SELECT id,payload FROM integration_jobs WHERE organization_id=$1 AND status='UNKNOWN'",[t.org])).rows[0]!;
 expect(job).toBeTruthy();return{t,h,c,job};
}
it.each([false,true])('reconciles native GROUP MEDIA_PENDING to its persisted receipt without any second message POST (existingMap=%s)',async existingMap=>{
 const f=await pendingNativeGroup(existingMap);await expect(f.c.reconcile(f.job.id)).rejects.toMatchObject({code:'CHATWOOT_LIVE_CUSTODY_PENDING'});
 f.c.setNativeReceipt({state:'PERSISTED',message_id:901});expect(await f.c.reconcile(f.job.id)).toEqual({ok:true});
 expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND job_id=$2',[f.t.org,f.job.id])).rows).toEqual([{state:'CONFIRMED',remote_message_id:'901'}]);
 await f.c.run();
 expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[f.job.id])).rows).toEqual([{status:'SUCCEEDED'}]);
 expect((await db.database.pool.query('SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND message_id=(SELECT message_id FROM integration_jobs WHERE id=$2)',[f.t.org,f.job.id])).rows).toEqual([{remote_message_id:'901'}]);
 expect(f.c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);
 expect(f.c.calls.filter(x=>x.path.includes('/live-ingress/v1/receipts/'))).toHaveLength(3);
 expect((await db.database.pool.query('SELECT payload FROM integration_jobs WHERE id=$1',[f.job.id])).rows[0]!.payload.liveIngressProof.receipt_id).toBe(f.job.payload.liveIngressProof.receipt_id);
});
it('refuses a changed native GROUP receipt identity and preserves its original uncertain proof without a new POST',async()=>{
 const f=await pendingNativeGroup();f.c.setNativeReceipt({state:'PERSISTED',message_id:901,receipt_id:randomUUID()});
 await expect(f.c.reconcile(f.job.id)).rejects.toMatchObject({code:'CHATWOOT_LIVE_RECEIPT_ID_CHANGED'});
 const row=(await db.database.pool.query('SELECT status,payload FROM integration_jobs WHERE id=$1',[f.job.id])).rows[0]!;expect(row.status).toBe('UNKNOWN');expect(row.payload.liveIngressProof.receipt_id).toBe(f.job.payload.liveIngressProof.receipt_id);
 expect(f.c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[f.t.org])).rows).toEqual([{state:'UNKNOWN'}]);
});
it.each([
 ["UPDATE whatsapp_group_catalog_items SET selected=false WHERE organization_id=$1",'GROUP_CENTRAL_SCOPE_CHANGED'],
 ["UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1",'CHATWOOT_LIVE_CONTEXT_CHANGED'],
])('refuses native GROUP receipt lookup after authority changes: %s',async(sql,code)=>{
 const f=await pendingNativeGroup();f.c.setNativeReceipt({state:'PERSISTED',message_id:901});await db.database.pool.query(sql,[f.t.org]);
 await expect(f.c.reconcile(f.job.id)).rejects.toMatchObject({code});
 expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[f.job.id])).rows).toEqual([{status:'UNKNOWN'}]);
 expect(f.c.calls.filter(x=>x.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);expect(f.c.calls.filter(x=>x.path.includes('/live-ingress/v1/receipts/'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[f.t.org])).rows).toEqual([{n:0}]);
});
it('keeps a legacy generic GROUP UNKNOWN without native proof unreconciled and never performs another POST',async()=>{
 const t=await fixture(),c=await central(t,true);await t.ingest('Legacy uncertain without immutable receipt');await c.run();
 const job=(await db.database.pool.query("SELECT id FROM integration_jobs WHERE organization_id=$1 AND status='UNKNOWN'",[t.org])).rows[0]!;
 await expect(c.reconcile(job.id)).rejects.toMatchObject({code:'CHATWOOT_MIRROR_EVIDENCE_REQUIRED'});
 expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[job.id])).rows).toEqual([{status:'UNKNOWN'}]);
 expect(c.calls.filter(x=>x.path==='/api/v1/accounts/7/conversations/51/messages')).toHaveLength(1);expect(c.calls.some(x=>x.path.includes('/live-ingress/v1/receipts/'))).toBe(false);
});


it('keeps the native GROUP job UNKNOWN if scope revokes at the first pin assertion after a successful receiver POST',async()=>{
 const t=await fixture();let c:Awaited<ReturnType<typeof central>>|undefined,afterPostTransactions=0;
 const transact:ChatwootOptions['transact']=async(org,work)=>{
  if(c?.calls.some(call=>call.path.includes('/live-ingress/v1/messages'))&&++afterPostTransactions===2)
   await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1",[org]);
  return db.transact(org,work);
 };
 c=await central(t,false,{}, {transact},{});await t.ingest('Pin-window revoked native group');
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'UNKNOWN'})]));
 expect(c.calls.filter(call=>call.path.includes('/live-ingress/v1/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'UNKNOWN'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{n:0}]);
});


it('retries only a known rejected native GROUP quota response with two HTTP POSTs and one durable persistence',async()=>{
 const t=await fixture(),h=groupMediaStore(t,'image'),c=await central(t,false,{}, {media:h.media},{throttleOnce:true});
 await ingestGroupMedia(t,'image',randomUUID());await h.media.runOnce(t.org);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'PENDING',last_error:'CHATWOOT_REQUEST_REJECTED'})]));
 const initial=(await db.database.pool.query("SELECT id,payload FROM integration_jobs WHERE organization_id=$1 AND kind='MIRROR_MESSAGE'",[t.org])).rows[0]!;
 expect(initial.payload.liveIngressProof.receipt_id).toBeUndefined();expect(c.nativePersistenceCount()).toBe(0);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1',[t.org])).rows).toEqual([{state:'REJECTED'}]);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[initial.id]);
 expect(await c.run()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'MIRROR_MESSAGE',status:'SUCCEEDED',last_error:null})]));
 const posts=c.calls.filter(call=>call.path.includes('/live-ingress/v1/messages'));expect(posts).toHaveLength(2);expect(c.nativePersistenceCount()).toBe(1);
 const requests=posts.map(call=>call.body instanceof FormData?JSON.parse(String(call.body.get('envelope'))):call.body);expect(requests[1]).toEqual(requests[0]);
 const canonical=(await db.database.pool.query('SELECT created_at FROM messaging_messages WHERE organization_id=$1 AND id=$2',[t.org,initial.payload.liveIngressProof.broker_message_id])).rows[0]!;
 expect(requests[0].occurred_at).toBe(Math.floor(canonical.created_at.getTime()/1000));expect(initial.payload.liveIngressProof.occurred_at).toBe(requests[0].occurred_at);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE organization_id=$1 ORDER BY created_at,id',[t.org])).rows).toEqual([{state:'REJECTED'},{state:'CONFIRMED'}]);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM chatwoot_messages WHERE organization_id=$1',[t.org])).rows).toEqual([{n:1}]);
});

});


describe('native group unit',()=>{
 function harness({media=false,lost=false,pending=false,prior=false,legacyOperation=false,recorded=false,revoke=false,stock=false,failProof=false,pinRevoke=false,throttleOnce=false,missingReceipt=false,legacyRejected=false}={}){
  const ids={org:'11111111-1111-4111-8111-111111111111',channel:'22222222-2222-4222-8222-222222222222',instance:'33333333-3333-4333-8333-333333333333',integration:'44444444-4444-4444-8444-444444444444',conversation:'55555555-5555-4555-8555-555555555555',message:'66666666-6666-4666-8666-666666666666',job:'77777777-7777-4777-8777-777777777777',attempt:'88888888-8888-4888-8888-888888888888',receipt:'99999999-9999-4999-8999-999999999999'};
  const baseUrl='https://central.example.test',calls:Array<{path:string;body:any}>=[],files:Uint8Array[]=[];
  let revoked=false,mapPresent=true,postSeen=false,postScopes=0,persistenceCount=0,transaction=0,activeTransaction=0,attemptTransaction=0,proofTransaction=0,attemptState:string|undefined=legacyRejected?'REJECTED':prior?'UNKNOWN':undefined,remoteMessageId:number|undefined,finished=false,durablePayload:Record<string,unknown>={};
  const job:GroupIntegrationJob={id:ids.job,organization_id:ids.org,integration_id:ids.integration,kind:'MIRROR_MESSAGE',attempts:1,message_id:ids.message,lease_token:ids.job,
   payload:{...(legacyOperation?{operation:'GROUP_SEND_MESSAGE'}:{}),...(recorded?{mirrorProtocol:'GENERIC'}:{})}};
  const message={id:ids.message,conversation_id:ids.conversation,channel_id:ids.channel,recipient_kind:'GROUP',direction:'INCOMING',source:'CONTACT',state:'DELIVERED',upstream_message_id:'synthetic-provider',provider_scope:'g3:'+group+':1',
   created_at:new Date('2026-01-02T03:04:05.987Z'),content:media?{type:'MEDIA',mediaId:ids.message,kind:'image',fileName:'synthetic.png',caption:'Native caption'}:{type:'TEXT',text:'Native participant text'},is_historical:false,participant_jid:'12345@lid'};
  let options:ChatwootOptions;
  const rows=(items:unknown[])=>({rows:items,rowCount:items.length});
  const query=async(sql:string,args:unknown[]=[])=>{
   const q=sql.toLowerCase().replace(/\s+/g,' ').trim();
   if(q.startsWith('select m.id,m.conversation_id'))return rows([message]);
   if(q.includes('group_central_scope_blocker'))return rows([{blocker:'GROUP_CONTEXT_UNAVAILABLE'}]);
   if(q.includes('group_central_current_scope')){if(pinRevoke&&postSeen&&++postScopes===2)revoked=true;return rows(revoked?[]:[{organization_id:ids.org,channel_id:ids.channel,instance_id:ids.instance,conversation_id:ids.conversation,group_jid:group,subject:'Synthetic native group',integration_id:ids.integration,inbox_id:9,account_id:7,credential_version:1,destination_revision:2,identity_revision:1,identity_fingerprint:'a'.repeat(64),snapshot_id:ids.instance,valid_until:new Date(Date.now()+60000),binding_fingerprint:'b'.repeat(64)}]);}
   if(q.includes('c.instance_id,i.upstream_instance_key'))return rows([{instance_id:ids.instance,upstream_instance_key:ids.instance}]);
   if(q.includes('clock_timestamp()')&&q.startsWith('select'))return rows([{current:true}]);
   if(q.includes('from chatwoot_destinations'))return rows([{organizationId:ids.org,baseUrl,mode:'EXTERNAL',approvalStatus:'APPROVED',mediaOrigins:[],revision:2}]);
   if(q.includes('from chatwoot_accounts'))return rows([{organization_id:ids.org,base_url:baseUrl,account_id:'7',encrypted_token:chatwootEnvironment(options).vault.encrypt(ids.org+':chatwoot-account','synthetic-only'),status:'READY',credential_version:1}]);
   if(q.includes('from chatwoot_group_scopes g'))return rows(mapPresent?[{contact_id:'41',source_id:'source',remote_conversation_id:'51'}]:[]);
   if(q.includes('from chatwoot_messages'))return rows(remoteMessageId?[{remote_message_id:String(remoteMessageId)}]:[]);
   if(q.startsWith('select')&&q.includes('from chatwoot_mirror_attempts'))return rows(attemptState?[{id:ids.attempt,state:attemptState,remote_conversation_id:'51',remote_message_id:null}]:[]);
   if(q.startsWith('insert into chatwoot_mirror_attempts')){attemptState='DISPATCHED';attemptTransaction=activeTransaction;return rows([{id:ids.attempt}]);}
   if(q.startsWith('update integration_jobs')){if(failProof)throw Error('synthetic proof rollback');const patch=JSON.parse(String(args[3]));durablePayload={...durablePayload,...patch};proofTransaction=activeTransaction;return rows([{id:ids.job}]);}
   if(q.startsWith('update chatwoot_mirror_attempts')){attemptState=q.includes("state='confirmed'")?'CONFIRMED':String(args[6]);return rows([{remote_conversation_id:'51'}]);}
   if(q.startsWith('insert into chatwoot_messages')){remoteMessageId=Number(args[3]);return rows([{id:ids.message}]);}
   if(q.includes('from chatwoot_attendance_observations')||q.includes('from chatwoot_attendance_controls'))return rows([]);
   if(q.includes('select c.channel_id,d.revision'))return rows([{channel_id:ids.channel,revision:2,account_id:'7',inbox_id:'9',credential_version:1}]);
   if(q.startsWith('select'))return rows([{id:ids.message}]);
   throw Error('Unexpected native group unit SQL '+q);
  };
  const transact:ChatwootOptions['transact']=async(_org,work)=>{const old={attemptState,durablePayload,proofTransaction,attemptTransaction};activeTransaction=++transaction;try{return await work({query} as unknown as TenantTransaction);}catch(error){({attemptState,durablePayload,proofTransaction,attemptTransaction}=old);throw error;}finally{activeTransaction=0;}};
  options={baseUrl,publicOrigin:'https://broker.example.test',encryptionKey:key,transact,groupPolicy:{encryptionKey:key,configurationScope:'native-unit'},
   ...(media?{media:{read:async()=>({bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image',fileName:'synthetic.png'})} as any}:{}),
   fetch:async(input,init)=>{
    const path=new URL(String(input)).pathname,body=init?.body instanceof FormData?JSON.parse(String(init.body.get('envelope'))):init?.body?JSON.parse(String(init.body)):null;calls.push({path,body});
    if(path.endsWith('/capability')){if(stock)return new Response(null,{status:404});return Response.json({protocol:'jrc-live-ingress/1',organization_id:ids.org,integration_id:ids.integration,instance_id:ids.instance,destination_revision:2,account_id:7,inbox_id:9,supports_text:true,supports_media:true,max_media_bytes:16*1024*1024});}
    if(path.includes('/live-ingress/v1/messages')){
     expect(attemptState).toBe('DISPATCHED');expect(durablePayload.mirrorProtocol).toBe('jrc-live-ingress/1');expect(proofTransaction).toBe(attemptTransaction);
     expect(durablePayload.liveIngressProof).toMatchObject({attempt_id:ids.attempt,account_id:7,inbox_id:9,credential_revision:1,base_url:baseUrl,request_hash:body.request_hash,instance_id:ids.instance});
     expect((durablePayload.liveIngressProof as {occurred_at?:number}).occurred_at).toBe(body.occurred_at);
     expect(JSON.stringify(durablePayload.liveIngressProof)).not.toMatch(/Native caption|Native participant text/);
     if(init?.body instanceof FormData)files.push(new Uint8Array(await (init.body.get('file') as Blob).arrayBuffer()));
     if(throttleOnce&&calls.filter(c=>c.path.includes('/live-ingress/v1/messages')).length===1)return new Response(null,{status:429});
     persistenceCount++;postSeen=true;if(revoke)revoked=true;
     if(lost)throw Error('synthetic lost native ACK');
     const{content:_content,media:_media,message_type:_type,message_origin:_origin,occurred_at:_occurredAt,...fields}=body;
     return Response.json({...fields,account_id:7,inbox_id:9,receipt_id:ids.receipt,state:pending?'MEDIA_PENDING':'PERSISTED',message_id:pending?null:901});
    }
    if(path.includes('/receipts/')){if(missingReceipt)return new Response(null,{status:404});if(revoked)throw Error('must not inspect after scope revoke');return Response.json({protocol:'jrc-live-ingress/1',organization_id:ids.org,integration_id:ids.integration,instance_id:ids.instance,destination_revision:2,broker_message_id:ids.message,conversation_id:51,request_hash:body.request_hash,account_id:7,inbox_id:9,receipt_id:ids.receipt,state:pending?'MEDIA_PENDING':'PERSISTED',message_id:pending?null:901});}
    if(path.endsWith('/messages'))return Response.json({id:901});
    throw Error('Unexpected unit HTTP '+path);
   }};
  if(legacyRejected){
   const old=new ChatwootClient({baseUrl,token:'synthetic-only'}).liveIngress().prepare({organization_id:ids.org,integration_id:ids.integration,instance_id:ids.instance,destination_revision:2},
    {broker_message_id:ids.message,conversation_id:51,message_type:'incoming',message_origin:'LIVE',content:'[Participante: 12345@lid]\nNative participant text'});
   Object.assign(job.payload,{mirrorProtocol:'jrc-live-ingress/1',operation:'GROUP_SEND_MESSAGE',conversationId:51,
    liveIngressProof:{...liveIngressLookup(old),attempt_id:ids.attempt,account_id:7,inbox_id:9,credential_revision:1,base_url:baseUrl}});
   durablePayload={...job.payload};
  }
  const hooks={before:async(_job:GroupIntegrationJob,operation:string)=>{job.payload.operation=operation;},progress:async(_job:GroupIntegrationJob,patch:Record<string,unknown>)=>{Object.assign(job.payload,patch);durablePayload={...durablePayload,...patch};},finish:async()=>{finished=true;}};
  return{ids,job,calls,files,dropMap:()=>{mapPresent=false;},changeTime:()=>{message.created_at=new Date('2026-01-02T03:04:06.987Z');},persistenceCount:()=>persistenceCount,changeText:()=>{(message.content as {text?:string}).text='Changed native text';},worker:()=>createChatwootGroupWorker(options,hooks),state:()=>({attemptState,remoteMessageId,finished,durablePayload}),nativePosts:()=>calls.filter(c=>c.path.includes('/live-ingress/v1/messages'))};
 }
 it.each([{media:false,lost:false},{media:true,lost:true}])('persists native selection and minimal proof atomically before one group POST, recovering lost ACK by lookup: %j',async config=>{
  const h=harness(config);expect(await h.worker().mirror(h.job)).toBe(true);expect(h.state()).toMatchObject({attemptState:'CONFIRMED',remoteMessageId:901,finished:true});expect(h.nativePosts()).toHaveLength(1);
  expect(h.calls[0]!.path).toContain('/capability');expect(h.calls.filter(c=>c.path.includes('/receipts/'))).toHaveLength(config.lost?1:0);
  const body=h.nativePosts()[0]!.body;expect(body.instance_id).toBe(h.ids.instance);expect(body.content).toBe('[Participante: 12345@lid]\n'+(config.media?'Native caption':'Native participant text'));
  expect(body.message_type).toBe('incoming');expect(body.message_origin).toBe('LIVE');expect(body.occurred_at).toBe(1767323045);
  expect(body.media).toEqual(config.media?{filename:'synthetic.png',mime_type:'image/png',byte_size:3,sha256:'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'}:null);
  if(config.media)expect(h.files).toEqual([new Uint8Array([1,2,3])]);
 });
 it('keeps MEDIA_PENDING proof pinned and never repeats a native POST after restart',async()=>{
  const h=harness({media:true,pending:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({code:'CHATWOOT_LIVE_CONFIRMATION_PENDING',uncertain:true});
  expect(h.state().durablePayload.liveIngressProof).toMatchObject({receipt_id:h.ids.receipt});expect(h.nativePosts()).toHaveLength(1);
  await expect(h.worker().mirror(h.job)).rejects.toMatchObject({code:'CHATWOOT_LIVE_CONFIRMATION_PENDING',uncertain:true});expect(h.nativePosts()).toHaveLength(1);
 });
 it('does not confirm or inspect after group authority is revoked during native POST',async()=>{
  const h=harness({lost:true,revoke:true});await expect(h.worker().mirror(h.job)).rejects.toBeTruthy();expect(h.state().remoteMessageId).toBeUndefined();expect(h.nativePosts()).toHaveLength(1);expect(h.calls.filter(c=>c.path.includes('/receipts/'))).toHaveLength(0);
 });
 it.each([{prior:true},{legacyOperation:true},{recorded:true}])('never upgrades an existing generic group attempt when capability is newly installed: %j',async config=>{
  const h=harness(config);await h.worker().mirror(h.job);expect(h.nativePosts()).toHaveLength(0);expect(h.calls.some(c=>c.path.endsWith('/capability'))).toBe(false);expect(h.state().durablePayload.mirrorProtocol).toBe('GENERIC');
 });
 it('uses stock generic compatibility only after definite capability absence',async()=>{
  const h=harness({stock:true});await h.worker().mirror(h.job);expect(h.calls[0]!.path).toContain('/capability');expect(h.nativePosts()).toHaveLength(0);expect(h.state().durablePayload.mirrorProtocol).toBe('GENERIC');
 });
 it('rolls back attempt/selection if native proof cannot commit and never sends a message',async()=>{
  const h=harness({failProof:true});await expect(h.worker().mirror(h.job)).rejects.toThrow('synthetic proof rollback');expect(h.nativePosts()).toHaveLength(0);expect(h.state().attemptState).toBeUndefined();
 });
 it('keeps an attempt UNKNOWN when group scope is revoked at the first receipt-pin assertion after a successful POST',async()=>{
  const h=harness({pinRevoke:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({uncertain:true});
  expect(h.nativePosts()).toHaveLength(1);expect(h.state().attemptState).toBe('UNKNOWN');expect(h.state().remoteMessageId).toBeUndefined();expect(h.state().finished).toBe(false);
 });

 it('retries a native GROUP 429 only after its exact attempt is REJECTED and keeps the request immutable',async()=>{
  const h=harness({throttleOnce:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({retrySafe:true,uncertain:false,httpStatus:429});
  expect(h.state().attemptState).toBe('REJECTED');expect(h.persistenceCount()).toBe(0);const original=h.nativePosts()[0]!.body;
  h.job.lease_token=randomUUID();h.job.attempts++;
  expect(await h.worker().mirror(h.job)).toBe(true);expect(h.nativePosts()).toHaveLength(2);expect(h.nativePosts()[1]!.body).toEqual(original);expect(h.persistenceCount()).toBe(1);expect(h.state().attemptState).toBe('CONFIRMED');
 });
 it('does not retry an UNKNOWN native GROUP attempt even without a receipt id',async()=>{
  const h=harness({lost:true,missingReceipt:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({uncertain:true});expect(h.state().attemptState).toBe('UNKNOWN');
  expect((h.state().durablePayload.liveIngressProof as Record<string,unknown>).receipt_id).toBeUndefined();h.job.lease_token=randomUUID();
  await expect(h.worker().mirror(h.job)).rejects.toMatchObject({uncertain:true});expect(h.nativePosts()).toHaveLength(1);
 });
 it('refuses a rejected native GROUP retry if its body changed instead of assigning a fresh hash',async()=>{
  const h=harness({throttleOnce:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({httpStatus:429});h.changeText();h.job.lease_token=randomUUID();
  await expect(h.worker().mirror(h.job)).rejects.toMatchObject({code:'CHATWOOT_LIVE_REQUEST_CONFLICT'});expect(h.nativePosts()).toHaveLength(1);
 });

 it('does not bootstrap a replacement group conversation for a rejected native retry if its original map disappeared',async()=>{
  const h=harness({throttleOnce:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({httpStatus:429});h.dropMap();h.job.lease_token=randomUUID();const priorCalls=h.calls.length;
  await expect(h.worker().mirror(h.job)).rejects.toMatchObject({code:'CHATWOOT_LIVE_REQUEST_CONFLICT'});expect(h.nativePosts()).toHaveLength(1);expect(h.calls).toHaveLength(priorCalls);
 });

 it('preserves the old request hash without occurred_at when retrying a previously rejected native GROUP proof',async()=>{
  const h=harness({legacyRejected:true}),proof=h.job.payload.liveIngressProof as {request_hash:string};
  expect(await h.worker().mirror(h.job)).toBe(true);expect(h.nativePosts()).toHaveLength(1);expect(h.nativePosts()[0]!.body.occurred_at).toBeUndefined();expect(h.nativePosts()[0]!.body.request_hash).toBe(proof.request_hash);
 });
 it('does not change a native GROUP request hash when the canonical timestamp changes after a known rejection',async()=>{
  const h=harness({throttleOnce:true});await expect(h.worker().mirror(h.job)).rejects.toMatchObject({httpStatus:429});const original=h.nativePosts()[0]!.body;h.changeTime();h.job.lease_token=randomUUID();
  expect(await h.worker().mirror(h.job)).toBe(true);expect(h.nativePosts()).toHaveLength(2);expect(h.nativePosts()[1]!.body).toEqual(original);expect(h.nativePosts()[1]!.body.occurred_at).toBe(1767323045);
 });

});
