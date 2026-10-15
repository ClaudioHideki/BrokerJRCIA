import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService,createOutboxDispatcher} from '../../src/modules/automations/service.js';
import {createConversationEffectRuntime} from '../../src/modules/automations/conversation-runtime.js';
import {createConversationResourceService} from '../../src/modules/automations/conversation-resources.js';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
import {assertQueuedMediaAuthority,confirmQueuedMedia} from '../../src/modules/automations/conversation-media.js';
import {beginChatwootMirrorAttempt,confirmChatwootMirrorAttempt,initializeChatwootAttendanceMap} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';

describe('private media effects and scoped transport evidence',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{db=await attendanceDatabase();},60000);afterAll(async()=>{await db?.dispose();});
 async function fixture(central=false,subflow=false){
  const t=await seedAttendanceTenant(db.database,false),node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
  await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
  const media=createMediaStore({transact:db.transact,encryptionKey:Buffer.alloc(32,2).toString('base64'),download:async()=>{throw Error('NO_DOWNLOAD');}});
  const resources=createConversationResourceService({transact:db.transact,media}),service=createAutomationService({transact:db.transact,enabled:true,media});
  const draft=await service.create(t.org,{name:'Private media fixture',graph:{nodes:[node('start','start'),node('end','end')],edges:[{id:'a',source:'start',target:'end',port:'next'}]}});
  const asset=await resources.uploadMedia(t.org,draft.id,t.channel,{bytes:new TextEncoder().encode('Synthetic document'),kind:'document',mimeType:'text/plain',fileName:'synthetic.txt',idempotencyKey:randomUUID()});
  const graph={nodes:[node('start','start'),node('media','media',{mediaEffectVersion:2,channelId:t.channel,mediaId:asset.id,mediaRevision:1,caption:'Synthetic',target:'result',timeoutMs:1000}),node('end','end')],
   edges:[{id:'a',source:'start',target:'media',port:'next'},...['success','error','timeout'].map(port=>({id:port,source:'media',target:'end',port}))]};
  const saved=await service.save(t.org,draft.id,{name:draft.name,graph,revision:draft.draft.revision});
  await service.publish(t.org,draft.id,saved.draft.revision);
  let root=draft;
  if(subflow){
   root=await service.create(t.org,{name:'Parent media fixture',graph:{nodes:[node('start','start'),node('call','subflow',{automationId:draft.id,version:1}),node('end','end')],edges:[{id:'a',source:'start',target:'call',port:'next'},{id:'b',source:'call',target:'end',port:'next'}]}});
   await service.publish(t.org,root.id,root.draft.revision);
  }
  await service.bind(t.org,root.id,{channelId:t.channel});
  await db.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[t.org,t.conversation]);
  const first=await createEventRouter({transact:db.transact,enabled:true}).route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'Hello'});
  await createExecutionService({transact:db.transact,enabled:true}).runOnce(t.org);
  const scope={...t.scope,credentialRevision:1};
  if(central){
   const origin=`https://${t.org}.example.test`;
   await db.database.pool.query("insert into chatwoot_destinations(organization_id,base_url,mode,approval_status) values($1,$2,'EXTERNAL','APPROVED')",[t.org,origin]);
   await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,origin]);
   await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'Synthetic','READY')",[t.integration,t.org,t.channel]);
   await db.database.pool.query("insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) values($1,$2,$3,13,'synthetic',11)",[t.org,t.integration,t.conversation]);
   await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:t.conversation,remoteConversationId:11,
    canonical:{id:11,account_id:7,inbox_id:9,status:'pending',updated_at:1,meta:{assignee:null,assignee_type:null,team:null}}}));
  }
  const runtime=createConversationEffectRuntime({transact:db.transact,media,client:()=>new ChatwootClient({baseUrl:'https://synthetic.example.test',token:'synthetic',
   fetch:async()=>Response.json({protocol:'jrc-conversation-effects/2',account_id:7,inbox_id:9,control_revision_supported:true,operations:['tag','attribute','note','resolve'],resources:[]})})});
  const dispatcher=createOutboxDispatcher({transact:db.transact,enabled:true},runtime.dispatcher,['SEND_MEDIA']);
  const dispatch=await dispatcher.runOnce(t.org);
  expect(dispatch).toMatchObject({status:'UNKNOWN'});
  const intent=(await db.database.pool.query('select outbox_id,messaging_message_id from automation_conversation_effects where organization_id=$1',[t.org])).rows[0]!;
  const mirror=async(messageId:string)=>{
   const jobId=randomUUID(),leaseToken=randomUUID();
   await db.database.pool.query(`insert into integration_jobs(id,organization_id,integration_id,kind,dedupe_key,message_id,status,lease_token,lease_expires_at)
    values($1::uuid,$2,$3,'MIRROR_MESSAGE',$1::text,$4,'RUNNING',$5,now()+interval '2 minutes')`,[jobId,t.org,t.integration,messageId,leaseToken]);
   return db.transact(t.org,tx=>beginChatwootMirrorAttempt(tx,scope,{jobId,leaseToken,messageId,conversationId:t.conversation,remoteConversationId:11}));
  };
  return {...t,media,resources,asset,root:root.id,definition:draft.id,runtime,scope,mirror,intent,executionId:first.execution!.id};
 }
 it('keeps enqueue pending and confirms only the canonical transport fact',async()=>{
  const t=await fixture();
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('WAITING');
  await db.database.pool.query("update messaging_messages set state='SENT',upstream_message_id='synthetic-provider-1' where organization_id=$1 and id=$2",[t.org,t.intent.messaging_message_id]);
  await db.transact(t.org,tx=>confirmQueuedMedia(tx,t.org,t.intent.messaging_message_id));
  expect((await db.database.pool.query('select state from automation_conversation_effects where organization_id=$1',[t.org])).rows[0]?.state).toBe('CONFIRMED');
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('QUEUED');
 });
 it('admits a child subflow asset under its definition while retaining the root execution authority',async()=>{
  const t=await fixture(false,true);
  expect(t.definition).not.toBe(t.root);
  const row=(await db.database.pool.query(`select e.automation_id,o.payload->>'definitionAutomationId' as definition,a.root_automation_id
   from automation_conversation_effects e join automation_outbox o on o.organization_id=e.organization_id and o.id=e.outbox_id
   join automation_media_assets a on a.organization_id=e.organization_id and a.id=e.media_asset_id where e.organization_id=$1`,[t.org])).rows[0];
  expect(row).toMatchObject({automation_id:t.root,definition:t.definition,root_automation_id:t.definition});
  await db.database.pool.query("update messaging_messages set state='SENT',upstream_message_id='child-media-provider' where organization_id=$1 and id=$2",[t.org,t.intent.messaging_message_id]);
  await db.transact(t.org,tx=>confirmQueuedMedia(tx,t.org,t.intent.messaging_message_id));
  await createExecutionService({transact:db.transact,enabled:true}).runOnce(t.org);
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('COMPLETED');
 });
 it('settles a safely canceled queued message even after the Flow lost authority',async()=>{
  const t=await fixture();
  await db.database.pool.query("update automation_executions set status='CANCELED' where organization_id=$1",[t.org]);
  await db.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1",[t.org]);
  await db.database.pool.query("update messaging_messages set state='FAILED' where organization_id=$1 and id=$2",[t.org,t.intent.messaging_message_id]);
  await db.database.pool.query('delete from messaging_outbox where organization_id=$1',[t.org]);
  await db.transact(t.org,tx=>confirmQueuedMedia(tx,t.org,t.intent.messaging_message_id));
  expect((await db.database.pool.query('select state from automation_conversation_effects where organization_id=$1',[t.org])).rows[0]?.state).toBe('REJECTED');
  expect((await db.database.pool.query('select status from automation_outbox where organization_id=$1',[t.org])).rows[0]?.status).toBe('FAILED');
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('CANCELED');
 });
 it('records a late sent receipt while preserving HUMAN and the canceled execution',async()=>{
  const t=await fixture();
  await db.database.pool.query("update automation_executions set status='CANCELED' where organization_id=$1",[t.org]);
  await db.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1",[t.org]);
  await db.database.pool.query("update messaging_messages set state='SENT',upstream_message_id='late-provider-1' where organization_id=$1 and id=$2",[t.org,t.intent.messaging_message_id]);
  await db.transact(t.org,tx=>confirmQueuedMedia(tx,t.org,t.intent.messaging_message_id));
  expect((await db.database.pool.query('select state from automation_conversation_effects where organization_id=$1',[t.org])).rows[0]?.state).toBe('CONFIRMED');
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('CANCELED');
 });
 it('excludes only its own persisted mirror from media admission and blocks every other uncertain mirror',async()=>{
  const t=await fixture(true);await t.mirror(t.intent.messaging_message_id);
  await expect(db.transact(t.org,tx=>assertQueuedMediaAuthority(tx,t.org,t.intent.messaging_message_id))).resolves.toMatchObject({id:t.intent.outbox_id});
  const other=randomUUID();await db.database.pool.query(`insert into messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
   values($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Other"}','SENT',$1::uuid::text,$5)`,[other,t.org,t.channel,t.conversation,'c'.repeat(64)]);
  await t.mirror(other);
  await expect(db.transact(t.org,tx=>assertQueuedMediaAuthority(tx,t.org,t.intent.messaging_message_id))).rejects.toThrow('AUTOMATION_EFFECT_AUTHORITY_LOST');
 });
 it('reconciles confirmed transport after its pending mirror is confirmed without resending',async()=>{
  const t=await fixture(true),attempt=await t.mirror(t.intent.messaging_message_id);
  await db.database.pool.query("update messaging_messages set state='SENT',upstream_message_id='provider-before-mirror' where organization_id=$1 and id=$2",[t.org,t.intent.messaging_message_id]);
  await db.transact(t.org,tx=>confirmQueuedMedia(tx,t.org,t.intent.messaging_message_id));
  expect((await db.database.pool.query('select state from automation_conversation_effects where organization_id=$1',[t.org])).rows[0]?.state).toBe('CONFIRMED');
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('WAITING');
  await db.transact(t.org,tx=>confirmChatwootMirrorAttempt(tx,t.scope,{attemptId:attempt.id,remoteMessageId:77}));
  await t.runtime.reconcileOnce(t.org);
  expect((await db.database.pool.query('select status from automation_executions where organization_id=$1',[t.org])).rows[0]?.status).toBe('QUEUED');
  expect((await db.database.pool.query('select id from messaging_messages where organization_id=$1',[t.org])).rows).toHaveLength(1);
 });
 it('requires the0063 proof trigger and forced tenant policy for readiness',async()=>{
  expect(await db.transact((await seedAttendanceTenant(db.database,false)).org,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)))).toBe(true);
  await db.database.pool.query('alter table automation_conversation_effects disable trigger conversation_effect_v2_immutable');
  try{expect(await probeRequiredRuntimeSchema(sql=>db.database.pool.query(sql))).toBe(false);}
  finally{await db.database.pool.query('alter table automation_conversation_effects enable trigger conversation_effect_v2_immutable');}
 });
});
