import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService,createOutboxDispatcher} from '../../src/modules/automations/service.js';
import {createConversationEffectRuntime} from '../../src/modules/automations/conversation-runtime.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {conversationEffectRequestHash,type ConversationEffectRequest} from '../../src/modules/automations/conversation-effect-protocol.js';
import {recordChatwootAttendanceEvent,initializeChatwootAttendanceMap} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import {readChatwootAttendanceGate} from '../../src/modules/attendance/control-service.js';

describe('protocol2 central effects with real tenant transactions',()=>{
 let db:Awaited<ReturnType<typeof attendanceDatabase>>;
 beforeAll(async()=>{db=await attendanceDatabase();},60000);
 afterAll(async()=>{await db?.dispose();});
 async function fixture(operation:'note'|'resolve'='note'){
  const t=await seedAttendanceTenant(db.database,false),origin=`https://${t.org}.example.test`;
  await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
  const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
  const graph={nodes:[node('start','start'),node('action',operation,{conversationEffectVersion:2,operation,channelId:t.channel,
   target:'result',timeoutMs:1000,...(operation==='note'?{text:'Private synthetic'}:{status:'RESOLVED'})}),...(operation==='note'?[node('end','end')]:[])],
   edges:[{id:'start',source:'start',target:'action',port:'next'},...(operation==='note'?['success','error','timeout'].map(port=>({id:port,source:'action',target:'end',port})):[])]};
  const service=createAutomationService({transact:db.transact,enabled:true}),draft=await service.create(t.org,{name:'Protocol2 test',graph});
  await service.publish(t.org,draft.id,draft.draft.revision);await service.bind(t.org,draft.id,{channelId:t.channel});
  await db.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[t.org,t.conversation]);
  const routed=await createEventRouter({transact:db.transact,enabled:true}).route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'Hello'});
  await createExecutionService({transact:db.transact,enabled:true}).runOnce(t.org);
  const outbox=(await db.database.pool.query('select id from automation_outbox where organization_id=$1',[t.org])).rows[0]!.id;
  await db.database.pool.query("insert into chatwoot_destinations(organization_id,base_url,mode,approval_status) values($1,$2,'EXTERNAL','APPROVED')",[t.org,origin]);
  await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,origin]);
  await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'Synthetic','READY')",[t.integration,t.org,t.channel]);
  await db.database.pool.query(`insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
   values($1,$2,$3,13,'synthetic',11)`,[t.org,t.integration,t.conversation]);
  const scope={...t.scope,credentialRevision:1};
  await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,scope,{conversationId:t.conversation,remoteConversationId:11,
   canonical:{id:11,account_id:7,inbox_id:9,status:'pending',updated_at:1,meta:{assignee:null,assignee_type:null,team:null}}}));
  let transactions=0,posts=0,gets=0,lost=false,hook:undefined|(()=>Promise<void>),revision=10;
  let receipt:Record<string,unknown>|undefined;
  const context=()=>({protocol:'jrc-conversation-effects/2',account_id:7,inbox_id:9,conversation_id:11,remote_contact_id:13,
   contact_inbox_id:15,actor_user_id:17,routing_source_hash:'b'.repeat(64),control_revision:revision,
   status:operation==='resolve'&&receipt?'resolved':'pending',assignee_id:null,assignee_agent_bot_id:null,team_id:null});
  const client=new ChatwootClient({baseUrl:origin,token:'synthetic',fetch:async(url,options)=>{
   expect(transactions).toBe(0);const path=new URL(String(url)).pathname;
   if(path.endsWith('/capabilities'))return Response.json({protocol:'jrc-conversation-effects/2',account_id:7,inbox_id:9,control_revision_supported:true,operations:['tag','attribute','note','resolve'],resources:[]});
   if(path.endsWith('/context'))return Response.json(context());
   if(options?.method==='POST'){
    posts++;const request=JSON.parse(String(options.body)) as ConversationEffectRequest;
    const {control_revision:before,status:_status,assignee_id:_a,assignee_agent_bot_id:_b,team_id:_t,...pins}=context();revision++;
    receipt={...pins,state:'CONFIRMED',organization_id:t.org,operation_id:outbox,operation,resource_id:null,resource_revision:null,
     request_hash:conversationEffectRequestHash({accountId:7,remoteConversationId:11},request),
     dispatch_proof_hash:createHash('sha256').update(request.dispatch_proof).digest('hex'),control_revision_before:before,
     control_revision_after:revision,message_id:operation==='note'?19:null};
    await hook?.();if(lost)throw Error('lost ACK');return Response.json(receipt);
   }
   gets++;return Response.json(receipt);
  }});
  const runtime=createConversationEffectRuntime({client:()=>client,transact:async(org,work)=>{
   transactions++;try{return await db.transact(org,work);}finally{transactions--;}
  }});
  const dispatch=()=>createOutboxDispatcher({transact:db.transact,enabled:true},runtime.dispatcher,['IO_CONVERSATION']).runOnce(t.org);
  const callback=(id=19,sender=17)=>db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,scope,{event:'message_created',id,account:{id:7},inbox:{id:9},
   conversation:{id:11,inbox_id:9},message_type:'outgoing',private:true,sender:{id:sender,type:'user'},content:'PRIVATE MUST NOT ENTER OBSERVATIONS',
   content_attributes:{jrc_flow_effect_id:outbox,jrc_flow_effect_organization_id:t.org}}));
  const state=async()=>(await db.database.pool.query('select e.status,r.state,r.confirmed_receipt from automation_executions e join automation_conversation_effects r on r.organization_id=e.organization_id and r.execution_id=e.id where e.organization_id=$1',[t.org])).rows[0];
  return {...t,outbox,runtime,dispatch,callback,state,executionId:routed.execution!.id,
   hook:(value:()=>Promise<void>)=>{hook=value;},loseAck:()=>{lost=true;},humanRevision:()=>{revision++;},counts:()=>({posts,gets}),
   expire:()=>db.database.pool.query("update automation_outbox set lease_expires_at=now()-interval '1 second' where organization_id=$1",[t.org])};
 }
 it('correlates the private note callback with the receipt without treating metadata as authority',async()=>{
  const t=await fixture();t.hook(async()=>{expect(await t.callback()).toMatchObject({disposition:'ECHO_PENDING'});});
  expect(await t.dispatch()).toMatchObject({status:'SENT'});
  expect(await t.state()).toMatchObject({status:'QUEUED',state:'CONFIRMED'});
  const observations=(await db.database.pool.query('select event,reply_payload,disposition from chatwoot_attendance_observations where organization_id=$1',[t.org])).rows;
  expect(observations).toHaveLength(1);expect(observations[0]?.disposition).toBe('IGNORED');expect(JSON.stringify(observations)).not.toContain('PRIVATE MUST');
 });
 it('recovers a lost ACK only through GET and never creates a second remote note',async()=>{
  const t=await fixture();t.loseAck();t.hook(async()=>{await t.callback();});
  expect(await t.dispatch()).toMatchObject({status:'UNKNOWN'});await t.expire();await t.runtime.reconcileOnce(t.org);
  expect(t.counts()).toEqual({posts:1,gets:1});expect(await t.state()).toMatchObject({status:'QUEUED',state:'CONFIRMED'});
 });
 it('records a confirmed fact after human interruption without reviving the execution',async()=>{
  const t=await fixture();t.hook(async()=>{await t.callback(20,99);t.humanRevision();});await t.dispatch();
  expect(await t.state()).toMatchObject({status:'CANCELED',state:'CONFIRMED'});
  expect(await db.transact(t.org,tx=>readChatwootAttendanceGate(tx,{organizationId:t.org,channelId:t.channel,conversationId:t.conversation})))
   .toMatchObject({allowed:false,state:'HUMAN'});
 });
 it('recovers a lost resolve ACK and ends the execution instead of repeating its POST',async()=>{
  const t=await fixture('resolve');t.loseAck();await t.dispatch();await t.expire();await t.runtime.reconcileOnce(t.org);
  expect(t.counts()).toEqual({posts:1,gets:1});expect(await t.state()).toMatchObject({status:'COMPLETED',state:'CONFIRMED'});
 });
 it('keeps request and established receipt immutable under jrc_app',async()=>{
  const t=await fixture();await t.dispatch();
  await expect(db.transact(t.org,tx=>tx.query("update automation_conversation_effects set request_body='{}' where organization_id=$1 and outbox_id=$2",[t.org,t.outbox])))
   .rejects.toMatchObject({code:'23514'});
  await expect(db.transact(t.org,tx=>tx.query("update automation_conversation_effects set confirmed_receipt='{}' where organization_id=$1 and outbox_id=$2",[t.org,t.outbox])))
   .rejects.toMatchObject({code:'23514'});
 });
});
