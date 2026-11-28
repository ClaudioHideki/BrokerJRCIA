import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMessagingWorker} from '../../src/commands/messaging-worker.js';
import {connectionStringForRole} from './helpers/task7.js';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {chatwootEnvironment,createChatwootService,type ChatwootOptions} from '../../src/modules/integrations/chatwoot-service.js';
import {createChatwootWorker} from '../../src/modules/integrations/chatwoot-worker.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
import {persistQrContactEvent} from '../../src/modules/messaging/qr-contact-persistence.js';
import {inspectMirrorQueue,reviewPendingMirror} from '../../src/modules/integrations/review-pending-mirror.js';
import {createMediaStore,registerPendingMedia} from '../../src/modules/messaging/media-store.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60_000);
afterAll(async()=>{await db?.dispose();});
async function fixture(input:{admitted?:boolean;uniqueRemoteIds?:boolean;lostAck?:boolean;pending?:boolean;unavailable?:boolean;legacy?:boolean;mutate?:string;expireAfterPost?:boolean;rejectOnce?:boolean}={}){
 const t=await seedAttendanceTenant(db.database),instance=randomUUID(),calls:string[]=[],nativeBodies:Record<string,unknown>[]=[];
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0].provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1::uuid,$2,$3,'Synthetic native',$1::text,'CONNECTED')",[instance,t.org,provider]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1",[t.channel,instance]);
 await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
  VALUES($1,$2,$3,41,'synthetic-native-source',51)`,[t.org,t.integration,t.conversation]);
 let stored:Record<string,unknown>|undefined;
 const options:ChatwootOptions={baseUrl:`https://${t.org}.example.test`,publicOrigin:'https://broker.example.test',
  encryptionKey:Buffer.alloc(32,6).toString('base64'),transact:db.transact,resolveIntegration:async id=>id===t.integration?t.org:undefined,
  async fetch(url,init){
   const path=new URL(String(url)).pathname;calls.push(path);
   const encoded=init?.body instanceof FormData?init.body.get('envelope'):init?.body;
   const body=encoded===undefined?{}:JSON.parse(String(encoded));
   if(path.endsWith('/contacts/search'))return Response.json({payload:[]});
   if(path.endsWith('/contacts'))return Response.json({payload:{contact:{id:41}}});
   if(path.endsWith('/contact_inboxes'))return Response.json({source_id:'synthetic-native-source'});
   if(path.endsWith('/conversations'))return Response.json({id:51});
   if(path.endsWith('/capability'))return Response.json({...body,account_id:7,inbox_id:9,supports_text:true,supports_media:true,max_media_bytes:16*1024*1024});
   if(path.includes('/live-ingress/v1/messages')){
    nativeBodies.push(body);
    if(input.rejectOnce){input.rejectOnce=false;return new Response('',{status:429});}
    stored={protocol:body.protocol,organization_id:body.organization_id,integration_id:body.integration_id,instance_id:body.instance_id,
     destination_revision:body.destination_revision,broker_message_id:body.broker_message_id,conversation_id:body.conversation_id,
     request_hash:body.request_hash,account_id:7,inbox_id:9,message_id:input.pending?null:input.uniqueRemoteIds?900+nativeBodies.length:901,receipt_id:randomUUID(),state:input.pending?'MEDIA_PENDING':'PERSISTED'};
    if(input.expireAfterPost)await db.database.pool.query("UPDATE integration_jobs SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND status='RUNNING'",[t.org]);
    if(input.lostAck)throw Error('Synthetic response lost after COMMIT');
    return Response.json(stored);
   }
   if(path.includes('/live-ingress/v1/receipts/')){
    if(input.mutate)await db.database.pool.query(input.mutate,[t.org]);
    if(input.unavailable)return new Response('',{status:503});
    if(!stored)return new Response('',{status:404});
    return Response.json(stored);
   }
   if(init?.method==='PATCH'&&path.endsWith('/conversations/51/messages/901'))return Response.json({});
   if(path.endsWith('/conversations/51/messages')){
    if(input.lostAck)throw Error('Generic outcome must remain unknown');
    return Response.json({id:902});
   }
   throw Error('Unexpected synthetic endpoint');
  }};
 const vault=chatwootEnvironment(options).vault;
 await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic')]);
 const message=input.admitted?randomUUID():(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
  VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic received live"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id;
 if(input.admitted)await db.transact(t.org,tx=>createPostgresMessagingRepository().recordIncoming(tx,{id:message,organizationId:t.org,
   channelId:t.channel,conversationId:t.conversation,webhookEventKey:randomUUID(),upstreamMessageId:randomUUID(),
   content:{type:'TEXT',text:'Synthetic received live'},scheduleBot:false}));
 const job=(await db.database.pool.query('SELECT id FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,message])).rows[0].id;
 if(input.legacy)await db.database.pool.query("UPDATE integration_jobs SET payload=payload||'{\"operation\":\"SEND_MESSAGE\"}'::jsonb WHERE id=$1",[job]);
 const read=async()=>(await db.database.pool.query('SELECT status,payload,last_error FROM integration_jobs WHERE id=$1',[job])).rows[0];
 return{...t,instance,message,job,calls,nativeBodies,options,read,stored:()=>stored,complete:()=>{
  input.pending=false;input.unavailable=false;if(stored){stored.state='PERSISTED';stored.message_id=901;}
 }};
}
function pilot(t:Awaited<ReturnType<typeof fixture>>){
 return {organizationId:t.org,integrationId:t.integration,channelId:t.channel,instanceId:t.instance,origin:t.options.baseUrl!,
 accountId:7,inboxId:9,destinationRevision:1,credentialRevision:1};
}
async function fencedContact(observedBlocker=false) {
 const t=await fixture({legacy:true,lostAck:true});
 if(observedBlocker)await db.database.pool.query(`UPDATE messaging_messages SET direction='OUTGOING',source='EXTERNAL_OBSERVED',
   upstream_message_id=$2 WHERE id=$1`,[t.message,randomUUID()]);
 const worker=createChatwootWorker(t.options);
 await worker.runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
 const repository=createPostgresMessagingRepository();
 const event={id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,webhookEventKey:randomUUID(),
   upstreamMessageId:randomUUID(),content:{type:'TEXT' as const,text:'New entry'},scheduleBot:false};
 return {t,worker,repository,event};
}
it.each(['fresh','duplicate-before-release','missing-map','recovered-identity','history','changed-provider','changed-phone','wrong-remote'] as const)
 ('mirrors only a first live QR observation admitted for the same contact (%s)',async scenario=>{
  const {t,repository,event}=await fencedContact(true);
  const phone='15555550123';
  await db.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE organization_id=$1',[t.org,phone]);
  const channel=await db.transact(t.org,tx=>repository.findChannel(tx,t.org,t.channel));
  const qr={kind:'outbound' as const,upstreamMessageId:event.upstreamMessageId,externalId:phone,displayName:null,
    occurredAt:new Date(),content:event.content,historical:scenario==='history',recoveredIdentity:scenario==='recovered-identity'};
  if(scenario==='duplicate-before-release')await db.database.pool.query(`INSERT INTO qr_outbound_observations
    (organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [t.org,t.channel,t.conversation,qr.upstreamMessageId,qr.content,qr.occurredAt]);
  if(scenario==='missing-map')await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1',[t.org]);
  await db.transact(t.org,tx=>persistQrContactEvent(tx,channel!,qr));
  if(scenario==='missing-map')await db.database.pool.query(`INSERT INTO chatwoot_conversations
    (organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,41,'synthetic-native-source',51)`,
    [t.org,t.integration,t.conversation]);
  await db.transact(t.org,tx=>persistQrContactEvent(tx,channel!,qr));
  const {id}= (await db.database.pool.query('SELECT id FROM messaging_messages WHERE organization_id=$1 AND upstream_message_id=$2',[t.org,qr.upstreamMessageId])).rows[0];
  const capture=await db.database.pool.query(`SELECT j.payload ? 'qrObservationId' AS captured FROM integration_jobs j
    WHERE j.organization_id=$1 AND j.message_id=$2`,[t.org,id]);
  expect(capture.rows.some(row=>row.captured)).toBe(['fresh','changed-provider','changed-phone','wrong-remote'].includes(scenario));
  if(scenario==='changed-phone')await db.database.pool.query("UPDATE messaging_contacts SET external_id='15555550999' WHERE organization_id=$1",[t.org]);
  const paths:string[]=[];
  if(scenario==='fresh'){
    for(const state of ['DELIVERED','READ'] as const)await db.transact(t.org,tx=>repository.recordStatusEvent(tx,{
      organizationId:t.org,channelId:t.channel,upstreamMessageId:qr.upstreamMessageId,state}));
  }
  const worker=createChatwootWorker({...t.options,async fetch(url,init){
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/conversations/51'))return Response.json({id:51,account_id:7,inbox_id:9,
      contact_inbox:{id:11,contact_id:41,inbox_id:9,source_id:'synthetic-native-source'},meta:{sender:{id:41,phone_number:'+'+(scenario==='wrong-remote'?'15555550999':phone)}}});
    if(path.endsWith('/capability')&&scenario==='changed-provider')await db.database.pool.query(
      'UPDATE qr_outbound_observations SET provider_message_id=$2 WHERE message_id=$1',[id,randomUUID()]);
    if(init?.method==='POST'&&path.endsWith('/messages'))paths.push(path);
    return t.options.fetch!(url,init);
  }});
  for(let i=0;i<5;i++)await worker.runOnce(t.org);
  if(scenario==='fresh')expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE message_id=$1',[id])).rows)
    .toEqual(Array(3).fill({status:'SUCCEEDED',last_error:null}));
  expect(paths).toEqual(scenario==='fresh'?['/api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/messages']:[]);
  if(scenario==='fresh')expect(t.nativeBodies[0]).toMatchObject({broker_message_id:id,message_type:'outgoing',message_origin:'EXTERNAL_OBSERVED',conversation_id:51});
  expect(await t.read()).toMatchObject({status:'UNKNOWN'});
  expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toHaveLength(0);
});
it.each([{requestMs:10,expected:4},{requestMs:5200,expected:1}])(
 'bounds continuous delivery with a $requestMs ms receiver',
 async({requestMs,expected})=>{
  const t=await fixture();
  await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
    SELECT $1,$2,$3,'INCOMING','CONTACT',jsonb_build_object('type','TEXT','text','Batch '||i),'DELIVERED'
    FROM generate_series(1,4) i`,[t.org,t.channel,t.conversation]);
  let clock=0;
  const worker=createChatwootWorker({...t.options,async fetch(url,init){
    const response=await t.options.fetch!(url,init);
    if(!new URL(String(url)).pathname.endsWith('/live-ingress/v1/messages'))return response;
    clock+=requestMs;
    return Response.json({...await response.json(),message_id:901+t.nativeBodies.length});
  }});
  const timer=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  try {await worker.runOnce(t.org,true);} finally {timer.mockRestore();}
  expect(t.nativeBodies).toHaveLength(expected);
  expect(new Set(t.nativeBodies.map(body=>body.broker_message_id)).size).toBe(expected);
  const result=await db.database.pool.query(`SELECT count(*)::int AS done FROM integration_jobs
    WHERE organization_id=$1 AND integration_id=$2 AND status='SUCCEEDED'`,[t.org,t.integration]);
  expect(result.rows[0].done).toBe(expected);
 });
it.each(['mixed','only-live','only-reviewed'] as const)('shares claim opportunities across restarts (%s)',async scenario=>{
 const t=await fixture(),posted:string[]=[];
 const reviewed:string[]=[],live:string[]=[];
 const setup=async(isReviewed:boolean,index:number)=>{
   const msg=index===0?t.message:(await db.database.pool.query(`INSERT INTO messaging_messages
     (organization_id,channel_id,conversation_id,direction,source,content,state) VALUES($1,$2,$3,'INCOMING','CONTACT',
     '{"type":"TEXT","text":"Queue test"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation])).rows[0].id as string;
   await db.database.pool.query(`UPDATE integration_jobs SET created_at=timestamptz '2026-01-01 UTC'+$3::int*interval '1 minute',
     payload=CASE WHEN $2 THEN jsonb_build_object('reviewedInboxTarget',jsonb_build_object('inbox','9')) ELSE payload END
     WHERE message_id=$1`,[msg,isReviewed,index]);
   (isReviewed?reviewed:live).push(msg);
 };
 for(let i=0;i<(scenario==='mixed'?7:1);i++)await setup(scenario==='only-reviewed'||(scenario==='mixed'&&i<2),i);
 const order=scenario==='mixed'?[...live.slice(0,3),reviewed[0],...live.slice(3),reviewed[1]]:[...live,...reviewed];
 const options:ChatwootOptions={...t.options,async fetch(url,init){
   const response=await t.options.fetch!(url,init);
   if(!new URL(String(url)).pathname.endsWith('/live-ingress/v1/messages'))return response;
   const receipt=await response.json();posted.push(receipt.broker_message_id);
   return Response.json({...receipt,message_id:1000+posted.length});
 }};
 for(let i=0;i<order.length;i++){
   await Promise.all([createChatwootWorker(options).runOnce(t.org),createChatwootWorker(options).runOnce(t.org)]);
 }
 expect(posted).toEqual(order);
 expect((await db.database.pool.query("SELECT count(*)::int n FROM integration_jobs WHERE organization_id=$1 AND status='SUCCEEDED' AND attempts=1",[t.org])).rows[0].n)
   .toBe(order.length);
});
it('keeps a new receipt for pre-activation history out of live ingress while admitting fresh messages',async()=>{
 const t=await fixture();
 await db.database.pool.query(`UPDATE integration_jobs SET status='HISTORY_PENDING',available_at='infinity',
   last_error='PRE_ACTIVATION_HISTORY_HELD' WHERE id=$1`,[t.job]);
 await db.database.pool.query("UPDATE messaging_messages SET state='READ' WHERE id=$1",[t.message]);
 const worker=createChatwootWorker(t.options);
 await worker.runOnce(t.org);
 expect(t.calls).toHaveLength(0);
 const prior=await db.database.pool.query(`SELECT status,attempts,available_at='infinity' AS held FROM integration_jobs
   WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3`,[t.org,t.integration,t.message]);
 expect(prior.rows).toEqual(Array(2).fill({status:'HISTORY_PENDING',attempts:0,held:true}));
 const event={id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,webhookEventKey:randomUUID(),
   upstreamMessageId:randomUUID(),content:{type:'TEXT' as const,text:'New after activation'},scheduleBot:false};
 await db.transact(t.org,tx=>createPostgresMessagingRepository().recordIncoming(tx,event));
 await worker.runOnce(t.org);
 await worker.runOnce(t.org);
 expect(t.nativeBodies.map(body=>body.broker_message_id)).toEqual([event.id]);
});
it('delivers a newly accepted contact message once past an older uncertain mirror, leaving the backlog intact',async()=>{
 const {t,worker,repository,event}=await fencedContact();
 const backlog=await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
   VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Earlier entry"}','DELIVERED') RETURNING id`,[t.org,t.channel,t.conversation]);
 await db.transact(t.org,tx=>repository.recordIncoming(tx,event));
 await db.transact(t.org,tx=>repository.recordIncoming(tx,{...event,id:randomUUID(),webhookEventKey:randomUUID()}));
 await worker.runOnce(t.org);
 await worker.runOnce(t.org);
 expect(t.nativeBodies).toHaveLength(1);
 expect(t.nativeBodies[0]).toMatchObject({broker_message_id:event.id,conversation_id:51,message_type:'incoming'});
 expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE message_id=$1',[backlog.rows[0].id])).rows)
   .toEqual([{status:'PENDING',attempts:0}]);
 expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE message_id=$1',[event.id])).rows)
   .toEqual([{status:'SUCCEEDED',attempts:1}]);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
});
it('holds the fresh message when the mapped receiver cannot provide native receipts',async()=>{
 const {t,repository,event}=await fencedContact();
 await db.transact(t.org,tx=>repository.recordIncoming(tx,event));
 const requests:string[]=[];
 const worker=createChatwootWorker({...t.options,async fetch(url){
   requests.push(new URL(String(url)).pathname);
   return new Response('',{status:404});
 }});
 await worker.runOnce(t.org);
 expect(requests).toHaveLength(1);
 expect(requests[0]).toMatch(/\/capability$/);
 expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE message_id=$1',[event.id])).rows)
   .toEqual([{status:'PENDING',last_error:'CHATWOOT_NATIVE_RECEIPT_REQUIRED'}]);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
});
it.each(['success','missing-old-provider','empty-new-provider','provider-collision','operator','bot','candidate-operator','historical','wrong-inbox','unknown-route','second-attempt','post-claim-drift'] as const)
 ('isolates an observed outgoing mirror for a new received message (%s)',async scenario=>{
  const {t,repository,event}=await fencedContact(true);
  await db.transact(t.org,tx=>repository.recordIncoming(tx,event));
  const change=async(sql:string,params:unknown[])=>db.database.pool.query(sql,params);
  if(scenario==='missing-old-provider')await change('UPDATE messaging_messages SET upstream_message_id=NULL WHERE id=$1',[t.message]);
  if(scenario==='empty-new-provider')await change("UPDATE messaging_messages SET upstream_message_id='   ' WHERE id=$1",[event.id]);
  if(scenario==='provider-collision'){
    await expect(change('UPDATE messaging_messages SET upstream_message_id=$2 WHERE id=$1',[t.message,event.upstreamMessageId])).rejects.toMatchObject({code:'23505'});
    await change('UPDATE messaging_messages SET upstream_message_id=$2 WHERE id=$1',[t.message,' '+event.upstreamMessageId+' ']);
  }
  if(scenario==='operator')await change("UPDATE messaging_messages SET source='OPERATOR' WHERE id=$1",[t.message]);
  if(scenario==='bot')await change("UPDATE messaging_messages SET source='AUTOMATION' WHERE id=$1",[t.message]);
  if(scenario==='candidate-operator')await change("UPDATE messaging_messages SET direction='OUTGOING',source='OPERATOR' WHERE id=$1",[event.id]);
  if(scenario==='historical')await change('UPDATE messaging_messages SET is_historical=true WHERE id=$1',[t.message]);
  if(scenario==='wrong-inbox')await change('UPDATE chatwoot_mirror_attempts SET inbox_id=10 WHERE job_id=$1',[t.job]);
  if(scenario==='unknown-route')await change("UPDATE integration_jobs SET payload=jsonb_set(payload,'{conversationId}','99') WHERE id=$1",[t.job]);
  if(scenario==='second-attempt')await change(`INSERT INTO chatwoot_mirror_attempts(organization_id,integration_id,channel_id,destination_revision,
    account_id,inbox_id,conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
    SELECT organization_id,integration_id,channel_id,destination_revision,account_id,inbox_id,conversation_id,99,cycle,message_id,job_id,$2,'DISPATCHED'
    FROM chatwoot_mirror_attempts WHERE job_id=$1`,[t.job,randomUUID()]);
  const blocker=await t.read(),mutations:string[]=[];
  const worker=createChatwootWorker({...t.options,async fetch(url,init){
    const path=new URL(String(url)).pathname;
    if(scenario==='post-claim-drift'&&path.endsWith('/capability'))await change('UPDATE messaging_messages SET upstream_message_id=NULL WHERE id=$1',[t.message]);
    if(path.endsWith('/messages'))mutations.push(path);
    return t.options.fetch!(url,init);
  }});
  await worker.runOnce(t.org);await worker.runOnce(t.org);
  expect(await t.read()).toEqual(blocker);
  expect((await db.database.pool.query("SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1 AND state='UNKNOWN'",[t.job])).rows)
    .toEqual([{state:'UNKNOWN',remote_message_id:null}]);
  expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows).toHaveLength(0);
  if(scenario==='success'){
    expect(t.nativeBodies.map(body=>[body.broker_message_id,body.message_type])).toEqual([[event.id,'incoming']]);
    expect(mutations).toEqual(['/api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/messages']);
  }else{
    expect(mutations).toEqual([]);
    const job=(await db.database.pool.query('SELECT status,attempts,last_error FROM integration_jobs WHERE message_id=$1',[event.id])).rows[0];
    if(scenario==='post-claim-drift')expect(job.last_error).toBe('CHATWOOT_MIRROR_ISOLATION_CHANGED');
    else expect(job).toMatchObject({status:'PENDING',attempts:0});
  }
});
it.each([
 {observed:false,attachment:false,rebound:false},{observed:true,attachment:false,rebound:false},
 {observed:false,attachment:true,rebound:false},{observed:true,attachment:true,rebound:false},
 {observed:false,attachment:false,rebound:true},
 {observed:false,attachment:false,rebound:false,siblings:true},
 {observed:true,attachment:true,rebound:false,siblings:true},
 {observed:false,attachment:true,rebound:true,siblings:true},
 {observed:true,attachment:true,rebound:false,siblings:true,observedBlocker:true},
])('reviews a single mirror (observed=$observed, attachment=$attachment, rebound=$rebound, siblings=$siblings, observedBlocker=$observedBlocker)',async({observed,attachment,rebound,siblings,observedBlocker})=>{
 const {t}=await fencedContact(observedBlocker);
 const phone='15555550123';
 await db.database.pool.query('UPDATE messaging_contacts SET external_id=$2 WHERE organization_id=$1',[t.org,phone]);
 const binary={kind:'document' as const,fileName:'example.pdf',mimeType:'application/pdf',bytes:new TextEncoder().encode('%PDF-1.4 synthetic')};
 const media=createMediaStore({encryptionKey:t.options.encryptionKey,transact:t.options.transact,download:async()=>binary});
 const queued=async(text:string,file=false)=>{
  const sourceKey=randomUUID();
  const mediaId=file?await db.transact(t.org,tx=>registerPendingMedia(tx,t.org,t.channel,{source:'QR',sourceKey,
    descriptor:{messageId:sourceKey},kind:binary.kind,fileName:binary.fileName})):undefined;
  if(file)await media.runOnce(t.org);
  const content=mediaId?{type:'MEDIA',mediaId,kind:binary.kind,fileName:binary.fileName,caption:text}:{type:'TEXT',text};
  const row=await db.database.pool.query(`INSERT INTO messaging_messages
    (organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state)
    VALUES($1,$2,$3,$6,$7,$4,$5::jsonb,'DELIVERED') RETURNING id`,
    [t.org,t.channel,t.conversation,sourceKey,JSON.stringify(content),observed?'OUTGOING':'INCOMING',observed?'EXTERNAL_OBSERVED':'CONTACT']);
  const messageId=row.rows[0].id as string;
  const job=await db.database.pool.query('SELECT id FROM integration_jobs WHERE organization_id=$1 AND message_id=$2',[t.org,messageId]);
  return {messageId,jobId:job.rows[0].id as string};
 };
 const candidate=await queued('https://one.example.invalid/',attachment),other=await queued('https://two.example.invalid/path');
 const input={organizationId:t.org,integrationId:t.integration,accountId:7,inboxId:9,conversationId:51,...candidate};
 let remotePhone=phone;
 const receiver:ChatwootOptions={...t.options,media,async fetch(url,init){
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/conversations/51'))return Response.json({id:51,account_id:7,inbox_id:9,
     contact_inbox:{id:11,contact_id:41,inbox_id:9,source_id:'synthetic-native-source'},meta:{sender:{id:41,phone_number:'+'+remotePhone,name:null}}});
   if(path.endsWith('/conversations/51/messages')&&init?.method==='GET'){
     const params=new URL(String(url)).searchParams;
     const anchor={id:5,inbox_id:9,conversation_id:51,source_id:null,created_at:1,content_attributes:{}};
     return Response.json({payload:params.has('before')&&!params.has('after')?[]:[anchor]});
   }
   return t.options.fetch!(url,init);
 }};
 const options={transact:t.options.transact,client:chatwootEnvironment(receiver).client};
 const worker=createChatwootWorker(receiver);
 expect(await inspectMirrorQueue(options.transact,input)).toMatchObject({status:'PENDING',attempts:0,capturedTarget:false,
   ownAttempts:0,siblingJobs:0,mapped:false,uncertainInConversation:1,observation:'PENDING_WITHOUT_TARGET_BEHIND_UNKNOWN'});
 const preview=await reviewPendingMirror(options,input);
 expect(preview.state).toBe('ELIGIBLE');
 let digest=preview.digest;
 if(siblings){
   await db.database.pool.query("UPDATE messaging_messages SET state='READ' WHERE id=$1",[candidate.messageId]);
   await expect(reviewPendingMirror(options,input,digest)).rejects.toThrow('CHATWOOT_REVIEW_DIGEST_MISMATCH');
   const sibling=(await db.database.pool.query('SELECT id FROM integration_jobs WHERE message_id=$1 AND id<>$2',[candidate.messageId,candidate.jobId])).rows[0].id;
   await db.database.pool.query('UPDATE integration_jobs SET attempts=1 WHERE id=$1',[sibling]);
   await expect(reviewPendingMirror(options,input)).rejects.toThrow('CHATWOOT_REVIEW_NOT_ELIGIBLE');
   await db.database.pool.query('UPDATE integration_jobs SET attempts=0 WHERE id=$1',[sibling]);
   digest=(await reviewPendingMirror(options,input)).digest;
 }
 await expect(reviewPendingMirror(options,{...input,organizationId:randomUUID()})).rejects.toThrow();
 await expect(reviewPendingMirror(options,{...input,inboxId:10})).rejects.toThrow();
 await expect(reviewPendingMirror(options,{...input,jobId:t.job,messageId:t.message})).rejects.toThrow();
 await expect(reviewPendingMirror(options,{...input,...other},preview.digest)).rejects.toThrow();
 expect(t.nativeBodies).toHaveLength(0);
 await reviewPendingMirror(options,input,digest);
 await expect(reviewPendingMirror(options,input,digest)).rejects.toThrow();
 if(siblings){
   await db.database.pool.query("UPDATE integration_jobs SET available_at=now()+interval '1 hour' WHERE id=$1",[candidate.jobId]);
   await worker.runOnce(t.org);
   expect(t.nativeBodies).toHaveLength(0);
   expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE message_id=$1',[candidate.messageId])).rows)
     .toEqual([{status:'PENDING',attempts:0},{status:'PENDING',attempts:0}]);
   await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[candidate.jobId]);
 }
 if(rebound)remotePhone='15555550999';
 await worker.runOnce(t.org); await worker.runOnce(t.org);
 if(rebound){
   expect(t.nativeBodies).toHaveLength(0);
   expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE id=$1',[candidate.jobId])).rows)
     .toEqual([{status:'FAILED',last_error:'CHATWOOT_REVIEW_REMOTE_MISMATCH'}]);
   if(siblings)expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE message_id=$1 AND id<>$2',[candidate.messageId,candidate.jobId])).rows)
     .toEqual([{status:'PENDING',attempts:0}]);
 }else{
   expect(t.nativeBodies).toHaveLength(1);
   expect(t.nativeBodies[0]).toMatchObject({broker_message_id:candidate.messageId,message_type:observed?'outgoing':'incoming',
     message_origin:observed?'EXTERNAL_OBSERVED':'LIVE',conversation_id:51,media:attachment?{mime_type:'application/pdf'}:null});
   expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1',[candidate.jobId])).rows).toEqual([{status:'SUCCEEDED'}]);
   if(siblings){
     expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE message_id=$1',[candidate.messageId])).rows).toEqual([{status:'SUCCEEDED'},{status:'SUCCEEDED'}]);
     expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE message_id=$1',[candidate.messageId])).rows).toEqual([{state:'CONFIRMED'}]);
   }
 }
 expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1',[other.jobId])).rows)
   .toEqual([{status:'PENDING',attempts:0}]);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
});
it('does not send or create a conversation when the captured mapping changes',async()=>{
 const {t,worker,repository,event}=await fencedContact();
 await db.transact(t.org,tx=>repository.recordIncoming(tx,event));
 await db.database.pool.query('UPDATE chatwoot_conversations SET remote_conversation_id=52 WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
 const before=t.calls.length;
 await worker.runOnce(t.org);
 expect(t.calls).toHaveLength(before);
 expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE message_id=$1',[event.id])).rows)
   .toEqual([{status:'PENDING',attempts:0}]);
});
it('uses a bound native receipt for an individual mirror and durably records the selected protocol',async()=>{
 const t=await fixture();await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{mirrorProtocol:'jrc-live-ingress/1',remoteMessageId:901,
  liveIngressProof:{organization_id:t.org,integration_id:t.integration,instance_id:t.instance,broker_message_id:t.message,account_id:7,inbox_id:9}}});
 expect(t.calls.filter(path=>path.endsWith('/live-ingress/v1/messages'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows)
  .toEqual([{state:'CONFIRMED',remote_message_id:'901'}]);
});
it('uses the canonical source clock rather than mirror dispatch time',async()=>{
 const t=await fixture();
 await db.database.pool.query("UPDATE messaging_messages SET created_at='2026-01-02T03:04:05.987Z' WHERE id=$1",[t.message]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.nativeBodies).toHaveLength(1);expect(t.nativeBodies[0]).toMatchObject({occurred_at:1_767_323_045});
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{liveIngressProof:{occurred_at:1_767_323_045}}});
});
it('does not bootstrap or send another native request when its original conversation map was removed',async()=>{
 const t=await fixture({rejectOnce:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'PENDING'});
 const before=t.calls.length;
 await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.calls).toHaveLength(before);expect(await t.read()).not.toMatchObject({status:'SUCCEEDED'});
 expect(t.nativeBodies).toHaveLength(1);
});
it('settles a lost native ACK by receipt lookup and never emits another message POST',async()=>{
 const t=await fixture({lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{remoteMessageId:901}});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(1);
});
it('keeps an earlier reply at the head and recovers a dropped POST across two mirror-only workers',async()=>{
 const t=await fixture({admitted:true,lostAck:true,expireAfterPost:true});
 const reply=(await db.database.pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,payload,created_at)
   VALUES($1,$2,'CHATWOOT_REPLY','synthetic-head','{}',now()-interval '1 hour') RETURNING id`,[t.org,t.integration])).rows[0].id;
 const first=createChatwootWorker(t.options), second=createChatwootWorker(t.options);
 expect(await first.liveMirrorQueue(pilot(t))).toMatchObject({eligible_live_jobs:1,next_is_live:false});
 await Promise.all([first.runLiveMirrors(pilot(t)),second.runLiveMirrors(pilot(t))]);
 expect((await t.read()).status).toBe('PENDING');
 expect(t.calls).toHaveLength(0);
 expect((await db.database.pool.query('SELECT attempts,status FROM integration_jobs WHERE id=$1',[reply])).rows[0]).toEqual({attempts:0,status:'PENDING'});
 await db.database.pool.query("UPDATE integration_jobs SET status='SUCCEEDED' WHERE id=$1",[reply]);
 await Promise.all([first.runLiveMirrors(pilot(t)),second.runLiveMirrors(pilot(t))]);
 expect((await t.read()).status).toBe('UNKNOWN');
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await Promise.all([first.runLiveMirrors(pilot(t)),second.runLiveMirrors(pilot(t))]);
 expect((await t.read()).status).toBe('SUCCEEDED');
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(1);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM messaging_outbox WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM qr_dispatch_attempts WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);
 const timing=(await t.read()).payload.liveMirrorClaim;
 expect(Date.parse(timing.postGuardedAt)).toBeGreaterThanOrEqual(Date.parse(timing.claimedAt));
 expect(Date.parse(timing.claimedAt)).toBeGreaterThanOrEqual(Date.parse(timing.eligibleObservedAt));
});

it('measures synthetic polling latency with matching live text and preserves the other tenant',async()=>{
 const total=12,other=await fixture({admitted:true}),repo=createPostgresMessagingRepository();
 async function sample(dedicated:boolean){
  const t=await fixture({admitted:true,uniqueRemoteIds:true}),worker=createChatwootWorker(t.options);
  const add=()=>db.transact(t.org,tx=>repo.recordIncoming(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,
    conversationId:t.conversation,webhookEventKey:randomUUID(),upstreamMessageId:randomUUID(),content:{type:'TEXT',text:'Synthetic benchmark'},scheduleBot:false}));
  for(let i=1;i<total;i++)await add();
  await expect(worker.runLiveMirrors({...pilot(t),integrationId:other.integration})).rejects.toThrow('CHATWOOT_LIVE_PILOT_SCOPE_CHANGED');
  expect((await other.read()).status).toBe('PENDING');
  const normal=async()=>{
    for(let i=0;i<12&&t.nativeBodies.length<total;i++){
      // Simulate the same interval spent on other duties before each ordinary poll.
      await new Promise(resolve=>setTimeout(resolve,750));
      await worker.runOnce(t.org,true);
    }
  };
  const extra=async()=>{
    for(let i=0;i<60&&t.nativeBodies.length<total;i++){
      const n=await worker.runLiveMirrors(pilot(t));
      if(t.nativeBodies.length<total)await new Promise(resolve=>setTimeout(resolve,n?100:1000));
    }
  };
  await Promise.all([normal(),...(dedicated?[extra()]:[])]);
  expect(t.nativeBodies).toHaveLength(total);
  const measured=(await db.database.pool.query(`SELECT count(*)::int AS n,
    round((percentile_cont(.50) within group(order by extract(epoch FROM (a.created_at-j.created_at))*1000))::numeric,1)::float8 AS p50_ms,
    round((percentile_cont(.95) within group(order by extract(epoch FROM (a.created_at-j.created_at))*1000))::numeric,1)::float8 AS p95_ms,
    count(*) FILTER(WHERE j.payload ? 'liveMirrorClaim')::int AS dedicated_claims
    FROM integration_jobs j JOIN chatwoot_mirror_attempts a ON a.organization_id=j.organization_id AND a.job_id=j.id
    WHERE j.organization_id=$1 AND j.integration_id=$2 AND j.status='SUCCEEDED' AND a.state='CONFIRMED'`,[t.org,t.integration])).rows[0];
  expect(measured.n).toBe(total);
  return measured;
 }
 const normal=await sample(false),withDedicated=await sample(true);
 expect(withDedicated.dedicated_claims).toBeGreaterThan(0);
 expect(normal.dedicated_claims).toBe(0);
 console.info('SYNTHETIC_MIRROR_JOB_TO_ATTEMPT_MS',JSON.stringify({normal,withDedicated,normalPollDelayMs:750}));
},60000);

it('leaves a changed admitted destination and an unmarked old original to the ordinary worker',async()=>{
 for(const admitted of [false,true]){
   const t=await fixture({admitted});
   if(admitted)await db.database.pool.query('UPDATE chatwoot_conversations SET remote_conversation_id=77 WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
   expect(await createChatwootWorker(t.options).runLiveMirrors(pilot(t))).toBe(0);
   expect((await t.read()).status).toBe('PENDING');
   expect(t.calls).toHaveLength(0);
 }
});

it('probes the pinned queue and updates health only after a successful idle tick',async()=>{
 const t=await fixture({admitted:true});
 await db.database.pool.query("UPDATE integration_jobs SET available_at='infinity' WHERE id=$1",[t.job]);
 const dir=await mkdtemp(join(tmpdir(),'synthetic-live-worker-')),file=join(dir,'heartbeat');
 const env={DATABASE_URL:connectionStringForRole(db.database.connectionString,'jrc_app'),
   MESSAGING_WORKER_ORGANIZATIONS:t.org,MESSAGING_WORKER_LANE:'live-mirrors',
   MESSAGING_WORKER_MIRROR_TARGET_JSON:JSON.stringify(pilot(t)),CHATWOOT_BASE_URL:t.options.baseUrl,
   INTEGRATION_ENCRYPTION_KEY:t.options.encryptionKey,PUBLIC_ORIGIN:t.options.publicOrigin,WORKER_HEARTBEAT_FILE:file};
 try{
   await writeFile(file,'42');
   const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
   try{
     await runMessagingWorker(env,false,true);
     expect(stdout.mock.calls.some(([chunk])=>String(chunk).includes('"eligible_live_jobs":0'))).toBe(true);
   }finally{stdout.mockRestore();}
   expect(await readFile(file,'utf8')).toBe('42');
   await runMessagingWorker(env,false);
   expect(Number(await readFile(file,'utf8'))).toBeGreaterThan(42);
   await writeFile(file,'42');
   await db.database.pool.query('UPDATE chatwoot_connections SET inbox_id=19 WHERE id=$1',[t.integration]);
   await expect(runMessagingWorker(env,false)).rejects.toThrow('CHATWOOT_LIVE_PILOT_SCOPE_CHANGED');
   expect(await readFile(file,'utf8')).toBe('42');
 }finally{await unlink(file);await rmdir(dir);}
});
it.each(['pending','expired','receipt','pre-post'] as const)('pins a reused connection UUID across %s',async state=>{
 const t=await fixture({admitted:true,lostAck:state==='receipt',expireAfterPost:state==='receipt'});
 const redirect=()=>db.database.pool.query('UPDATE chatwoot_connections SET inbox_id=19 WHERE id=$1',[t.integration]);
 const worker=createChatwootWorker({...t.options,async fetch(url,init){
   const response=await t.options.fetch!(url,init);
   if(state==='pre-post'&&new URL(String(url)).pathname.endsWith('/capability'))await redirect();
   return response;
 }});
 if(state==='pre-post'){
   await worker.runLiveMirrors(pilot(t)).catch(error=>expect(error.message).toBe('CHATWOOT_LIVE_PILOT_SCOPE_CHANGED'));
   expect(t.calls.some(path=>path.endsWith('/capability'))).toBe(true);
   expect(t.nativeBodies).toHaveLength(0);
 }else{
   if(state==='receipt'){
     await worker.runLiveMirrors(pilot(t));expect((await t.read()).status).toBe('UNKNOWN');
     await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
   }
   if(state==='expired')await db.database.pool.query("UPDATE integration_jobs SET status='RUNNING',lease_token=$2,lease_expires_at=now()-interval '1 minute' WHERE id=$1",[t.job,randomUUID()]);
   await redirect();
 }
 const before=await t.read(),calls=t.calls.length;
 await expect(worker.runLiveMirrors(pilot(t))).rejects.toThrow('CHATWOOT_LIVE_PILOT_SCOPE_CHANGED');
 await expect(worker.liveMirrorQueue(pilot(t))).rejects.toThrow('CHATWOOT_LIVE_PILOT_SCOPE_CHANGED');
 expect(await t.read()).toEqual(before);expect(t.calls).toHaveLength(calls);
});
it('profiles idle and active claim plans with completed history and a separate uncertain inbox',async()=>{
 const t=await fixture({admitted:true,uniqueRemoteIds:true});
 const pool=db.database.pool,history=8000,held=256;
 const ch=(await pool.query(`INSERT INTO messaging_channels(organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
   SELECT organization_id,provider_account_id,$2,'synthetic','vault://synthetic' FROM messaging_channels WHERE id=$1 RETURNING id`,
   [t.channel,randomUUID()])).rows[0].id;
 const other=(await pool.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,19,'uncertain synthetic inbox','READY') RETURNING id",[t.org,ch])).rows[0].id;
 await pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,status,dedupe_key,payload)
   SELECT $1,$2,'MIRROR_MESSAGE','SUCCEEDED','completed:'||n,'{"historical":true}'::jsonb FROM generate_series(1,$3::int) n`,[t.org,t.integration,history]);
 await pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,status,dedupe_key,payload,available_at)
   SELECT $1,$2,'MIRROR_MESSAGE','HISTORY_PENDING','held:'||n,'{"historical":true}'::jsonb,'infinity' FROM generate_series(1,$3::int) n`,[t.org,t.integration,held]);
 await pool.query("INSERT INTO integration_jobs(organization_id,integration_id,kind,status,dedupe_key) VALUES($1,$2,'MIRROR_MESSAGE','UNKNOWN','uncertain')",[t.org,other]);
 await pool.query("UPDATE integration_jobs SET available_at='infinity' WHERE id=$1",[t.job]);
 await pool.query('ANALYZE integration_jobs');
 const plans:Record<string,unknown>={};let mode='',profiling=true;
 const observed:ChatwootOptions={...t.options,transact:(org,operation)=>t.options.transact(org,tx=>operation({
   query:async(sql:string,values:unknown[])=>{
     const kind=sql.includes('AS pending,')?'hint':sql.includes('FOR UPDATE OF pc SKIP LOCKED')?'pilot_lock':sql.includes('SELECT c.id FROM chatwoot_connections c')?'connection':
       sql.includes('AS live_text,')?'job':sql.includes("SET available_at=now()+interval '15 seconds'")?'receipt':null;
     const key=mode+'_'+kind;
     if(profiling&&kind&&!plans[key]){
       const raw=await tx.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,values);
       const detail=raw.rows[0]['QUERY PLAN'][0],plan=detail.Plan;
       plans[key]={execution_ms:detail['Execution Time'],shared_hits:plan['Shared Hit Blocks'],shared_reads:plan['Shared Read Blocks']};
     }
     return tx.query(sql,values);
   }
 } as typeof tx))};
 const worker=createChatwootWorker(observed);
 async function tick(lane:string){mode=lane;return lane.startsWith('normal')?worker.runOnce(t.org):worker.runLiveMirrors(pilot(t));}
 await tick('normal_idle');await tick('canary_idle');
 expect(plans.canary_idle_hint).toBeDefined();
 expect(plans.canary_idle_connection).toBeUndefined();
 expect(plans.canary_idle_receipt).toBeUndefined();
 profiling=false;
 const idle:Record<string,number[]>={normal_idle:[],canary_idle:[]};
 for(let n=0;n<20;n++)for(const lane of Object.keys(idle)){
   const begin=performance.now();await tick(lane);idle[lane]!.push(performance.now()-begin);
 }
 profiling=true;
 await pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await tick('canary_busy');
 expect(plans.canary_busy_connection).toBeDefined();expect(plans.canary_busy_job).toBeDefined();
 // Record the normal selector plans with the same history and an equivalent new original.
 await db.transact(t.org,tx=>createPostgresMessagingRepository().recordIncoming(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,
   conversationId:t.conversation,webhookEventKey:randomUUID(),upstreamMessageId:randomUUID(),content:{type:'TEXT',text:'synthetic control'},scheduleBot:false}));
 await tick('normal_busy');
 expect(plans.normal_busy_connection).toBeDefined();expect(plans.normal_busy_job).toBeDefined();
 const latency=Object.fromEntries(Object.entries(idle).map(([lane,ms])=>{ms.sort((a,b)=>a-b);
   return [lane,{n:ms.length,p50_ms:+ms[9]!.toFixed(2),p95_ms:+ms[18]!.toFixed(2)}];}));
 console.info('SYNTHETIC_MIRROR_CLAIM_PROFILE',JSON.stringify({history,held,unrelatedUnknown:1,latency,plans}));
},60000);
it('does not perform a receipt read after its dispatch lease expires during the message POST',async()=>{
 const t=await fixture({expireAfterPost:true,lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
 expect(t.calls.filter(path=>path.includes('/receipts/'))).toHaveLength(0);
});
it('retries a definitely rejected native request with the same hash, preserving uncertain barriers',async()=>{
 const t=await fixture({rejectOnce:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'PENDING',payload:{mirrorProtocol:'jrc-live-ingress/1'}});
 const first=await t.read();
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED',payload:{liveIngressProof:{request_hash:first.payload.liveIngressProof.request_hash}}});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(2);
 expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE job_id=$1 ORDER BY created_at,id',[t.job])).rows)
  .toEqual([{state:'REJECTED'},{state:'CONFIRMED'}]);
});
it.each(['pending','unavailable'] as const)('retains native %s uncertainty and can reconcile only from persisted immutable proof',async reason=>{
 const t=await fixture({lostAck:reason==='unavailable',pending:reason==='pending',unavailable:reason==='unavailable'});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'jrc-live-ingress/1'}});
 const before=await t.read();
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic receipt review')).rejects.toThrow();
 expect(await t.read()).toEqual(before);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('keeps an old generic mirror generic when native capability is introduced later',async()=>{
 const t=await fixture({legacy:true,lostAck:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'GENERIC'}});
 expect(t.calls.some(path=>path.includes('/live-ingress/'))).toBe(false);
});
it('does not erase a legacy generic protocol decision when bootstrap records a new phase',async()=>{
 const t=await fixture({legacy:true,lostAck:true});
 await db.database.pool.query('DELETE FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2',[t.org,t.integration]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN',payload:{mirrorProtocol:'GENERIC'}});
 expect(t.calls.some(path=>path.includes('/live-ingress/'))).toBe(false);
 expect(t.calls.filter(path=>path.endsWith('/conversations/51/messages'))).toHaveLength(1);
});
it('reconciles a crashed native operation from its immutable receipt without replaying POST',async()=>{
 const t=await fixture({lostAck:true,unavailable:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 const postCount=t.calls.filter(path=>path.endsWith('/messages')).length;
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic durable recovery')).resolves.toEqual({ok:true});
 expect(await t.read()).toMatchObject({status:'PENDING',payload:{remoteMessageId:901}});
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(postCount);
 expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows)
  .toEqual([{state:'CONFIRMED',remote_message_id:'901'}]);
});
it('automatically finishes a new native UNKNOWN only after the immutable custody receipt becomes persisted',async()=>{
 const t=await fixture({pending:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 const posts=t.calls.filter(path=>path.endsWith('/messages')).length;
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[t.job]);
 await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(posts);
 expect((await db.database.pool.query("SELECT action,reason FROM integration_audit WHERE organization_id=$1 AND resource_id=$2",[t.org,t.job])).rows)
  .toEqual([{action:'JOB_RECONCILED',reason:'NATIVE_PERSISTENCE_RECEIPT_RECOVERED'}]);
});
it('automatic receipt inspection does not release pending custody or generic UNKNOWN records',async()=>{
 const native=await fixture({pending:true});await createChatwootWorker(native.options).runOnce(native.org);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[native.job]);
 const posts=native.calls.filter(path=>path.endsWith('/messages')).length;
 await createChatwootWorker(native.options).runOnce(native.org);
 expect(await native.read()).toMatchObject({status:'UNKNOWN'});
 expect(native.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(posts);
 const legacy=await fixture({legacy:true,lostAck:true});await createChatwootWorker(legacy.options).runOnce(legacy.org);
 await db.database.pool.query('UPDATE integration_jobs SET available_at=now() WHERE id=$1',[legacy.job]);
 const before=await legacy.read(),calls=legacy.calls.length;
 await createChatwootWorker(legacy.options).runOnce(legacy.org);
 expect(await legacy.read()).toEqual(before);expect(legacy.calls).toHaveLength(calls);
});
it('does not accept a different receipt identity after observing pending media custody',async()=>{
 const t=await fixture({pending:true});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});t.complete();
 t.stored()!.receipt_id=randomUUID();const before=await t.read();
 await expect(createChatwootService(t.options).reconcileJob(t.org,t.job,'Synthetic replaced receipt')).rejects.toThrow();
 expect(await t.read()).toEqual(before);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
it('takes instance before channel locks so lifecycle cannot deadlock against a mirror',async()=>{
 const t=await fixture(),lifecycle=await db.database.pool.connect();let running:Promise<unknown>|undefined;
 let blocked=false,channelLockCode:string|undefined;
 try{
  await lifecycle.query('BEGIN');
  await lifecycle.query('SELECT id FROM instances WHERE id=$1 FOR UPDATE',[t.instance]);
  const lifecyclePid=(await lifecycle.query('SELECT pg_backend_pid() AS id')).rows[0].id;
  running=createChatwootWorker(t.options).runOnce(t.org);
  for(let n=0;n<100&&!blocked;n++){
   blocked=Boolean((await db.database.pool.query(`SELECT 1 FROM pg_locks waiter JOIN pg_locks holder
    ON holder.locktype=waiter.locktype AND holder.transactionid=waiter.transactionid
    WHERE holder.pid=$1 AND holder.granted AND NOT waiter.granted AND waiter.pid<>holder.pid LIMIT 1`,[lifecyclePid])).rowCount);
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
  }
  try{await lifecycle.query('SELECT id FROM messaging_channels WHERE id=$1 FOR NO KEY UPDATE NOWAIT',[t.channel]);}
  catch(error){channelLockCode=(error as {code?:string}).code;}
 }finally{await lifecycle.query('ROLLBACK');lifecycle.release();await running;}
 expect(blocked).toBe(true);expect(channelLockCode).toBeUndefined();
 expect(await t.read()).toMatchObject({status:'SUCCEEDED'});
});
it.each([
 ['credential','UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1'],
 ['destination','UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1'],
 ['inbox','UPDATE chatwoot_connections SET inbox_id=10 WHERE organization_id=$1'],
])('preserves uncertainty after %s changes during the receipt read',async(_kind,mutate)=>{
 const t=await fixture({lostAck:true,mutate});await createChatwootWorker(t.options).runOnce(t.org);
 expect(await t.read()).toMatchObject({status:'UNKNOWN'});
 const attempts=(await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE job_id=$1',[t.job])).rows;
 expect(attempts).toHaveLength(1);expect(attempts[0].remote_message_id).toBeNull();
 expect(['DISPATCHED','UNKNOWN']).toContain(attempts[0].state);
 expect(t.calls.filter(path=>path.endsWith('/messages'))).toHaveLength(1);
});
