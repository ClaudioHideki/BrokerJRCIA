import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService,createOutboxDispatcher} from '../../src/modules/automations/service.js';
import {createConversationEffectRuntime} from '../../src/modules/automations/conversation-runtime.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {conversationEffectRequestHash,type ConversationEffectRequest} from '../../src/modules/automations/conversation-effect-protocol.js';
import {initializeChatwootAttendanceMap,recordChatwootAttendanceEvent} from '../../src/modules/integrations/chatwoot-attendance-store.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();});afterAll(async()=>{await db?.dispose();});
async function fixture(supported=true){
 const t=await seedAttendanceTenant(db.database,false),origin=`https://${t.org}.example.test`;
 await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
 await db.database.pool.query("insert into chatwoot_destinations(organization_id,base_url,mode,approval_status) values($1,$2,'EXTERNAL','APPROVED')",[t.org,origin]);
 await db.database.pool.query("insert into chatwoot_accounts(organization_id,base_url,account_id,status) values($1,$2,7,'READY')",[t.org,origin]);
 await db.database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) values($1,$2,$3,9,'Synthetic','READY')",[t.integration,t.org,t.channel]);
 await db.database.pool.query("insert into chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) values($1,$2,$3,13,'synthetic',11)",[t.org,t.integration,t.conversation]);
 let posts=0,lookups=0,lost=false,malformed=false,outbox='',receipt:Record<string,unknown>|undefined,hook:(()=>Promise<void>)|undefined;
 const context=()=>({protocol:'jrc-conversation-effects/2',account_id:7,inbox_id:9,conversation_id:11,remote_contact_id:13,
  contact_inbox_id:15,actor_user_id:17,routing_source_hash:'b'.repeat(64),control_revision:10,status:'pending',assignee_id:null,assignee_agent_bot_id:null,team_id:null});
 const calls:Array<{path:string;method:string}>=[];
 const client=new ChatwootClient({baseUrl:origin,token:'synthetic',fetch:async(url,options)=>{
  const path=new URL(String(url)).pathname;calls.push({path,method:options?.method??'GET'});
  if(path.endsWith('/jrc_domain_commands/capabilities'))return Response.json({protocol:'jrc-domain-commands/1',account_id:7,inbox_id:9,
   organization_id:t.org,integration_id:t.integration,commands:supported?['create_lead','create_task','create_meeting']:[],owners:[{id:17,name:'Synthetic operator'}]});
  if(path.endsWith('/capabilities'))return Response.json({protocol:'jrc-conversation-effects/2',account_id:7,inbox_id:9,control_revision_supported:true,operations:['tag','attribute','note','resolve'],resources:[]});
  if(path.endsWith('/context'))return Response.json(context());
  if(options?.method==='POST'){
   expect(path).toBe('/api/v1/accounts/7/conversations/11/jrc_domain_commands');posts++;
   const request=JSON.parse(String(options.body)) as ConversationEffectRequest;
   expect(request).toMatchObject({operation:'domain',integration_id:t.integration});
   expect(JSON.parse(request.value_json)).toEqual({command:'create_lead'});
   const {control_revision:_revision,status:_status,assignee_id:_a,assignee_agent_bot_id:_b,team_id:_team,...pins}=context();
   receipt={...pins,state:'CONFIRMED',organization_id:t.org,operation_id:outbox,operation:'domain',resource_id:null,resource_revision:null,message_id:null,
    control_revision_before:10,control_revision_after:10,request_hash:conversationEffectRequestHash({accountId:7,remoteConversationId:11},request),
    dispatch_proof_hash:createHash('sha256').update(request.dispatch_proof).digest('hex'),domain_result:{command:'create_lead',resource_type:'JrcCrm::Lead',resource_id:71,created:true,
     delivery:'NOT_APPLICABLE',event:{id:outbox,causation_id:malformed?randomUUID():outbox,type:'crm.lead.ready'}}};
   await hook?.();if(lost)throw Error('synthetic lost domain ACK');return Response.json(receipt);
  }
  expect(path).toContain('/jrc_domain_commands/');lookups++;return Response.json(receipt);
 }});
 const runtime=createConversationEffectRuntime({client:()=>client,transact:db.transact});
 const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
 const graph={nodes:[node('start','start'),node('domain','domain',{conversationEffectVersion:2,operation:'domain',channelId:t.channel,
  command:'create_lead',target:'native.result',timeoutMs:1000}),node('end','end')],edges:[{id:'start',source:'start',target:'domain',port:'next'},
  ...['success','error','timeout'].map(port=>({id:port,source:'domain',target:'end',port}))]};
 const service=createAutomationService({transact:db.transact,enabled:true,conversationCatalog:runtime.catalog});
 const draft=await service.create(t.org,{name:'Synthetic domain command',graph});
 const publish=()=>service.publish(t.org,draft.id,draft.draft.revision);
 const start=async()=>{
  await publish();await service.bind(t.org,draft.id,{channelId:t.channel});
  await db.transact(t.org,tx=>initializeChatwootAttendanceMap(tx,{...t.scope,credentialRevision:1},{conversationId:t.conversation,remoteConversationId:11,
   canonical:{id:11,account_id:7,inbox_id:9,status:'pending',updated_at:1,meta:{assignee:null,assignee_type:null,team:null}}}));
  await db.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2",[t.org,t.conversation]);
  await createEventRouter({transact:db.transact,enabled:true}).route(t.org,{channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'Synthetic'});
  await createExecutionService({transact:db.transact,enabled:true}).runOnce(t.org);
  outbox=(await db.database.pool.query('select id from automation_outbox where organization_id=$1',[t.org])).rows[0].id;
 };
 return{...t,start,publish,runtime,calls,counts:()=>({posts,lookups}),loseAck:()=>{lost=true;},malformed:()=>{malformed=true;},hook:(callback:()=>Promise<void>)=>{hook=callback;},
  dispatch:()=>createOutboxDispatcher({transact:db.transact,enabled:true},runtime.dispatcher,['IO_CONVERSATION']).runOnce(t.org),
  state:async()=>(await db.database.pool.query('select e.status,r.state,r.confirmed_receipt from automation_executions e join automation_conversation_effects r on r.organization_id=e.organization_id and r.execution_id=e.id where e.organization_id=$1',[t.org])).rows[0],
  expire:()=>db.database.pool.query("update automation_outbox set lease_expires_at=now()-interval '1 second' where organization_id=$1",[t.org])};
}
it('confirms a typed native resource and causal event without a public message',async()=>{
 const t=await fixture();await t.start();expect(await t.dispatch()).toMatchObject({status:'SENT'});
 expect(await t.state()).toMatchObject({status:'QUEUED',state:'CONFIRMED',confirmed_receipt:{domain_result:{resource_id:71,delivery:'NOT_APPLICABLE'}}});
 expect(t.counts()).toEqual({posts:1,lookups:0});expect(t.calls.filter(call=>call.path.endsWith('/messages'))).toEqual([]);
});
it('recovers a lost domain acknowledgement by authenticated GET without another native mutation',async()=>{
 const t=await fixture();await t.start();t.loseAck();expect(await t.dispatch()).toMatchObject({status:'UNKNOWN'});
 await t.expire();await t.runtime.reconcileOnce(t.org);expect(t.counts()).toEqual({posts:1,lookups:1});expect(await t.state()).toMatchObject({status:'QUEUED',state:'CONFIRMED'});
});
it('rejects an unavailable native extension before admitting or dispatching a domain action',async()=>{
 const t=await fixture(false);await expect(t.publish()).rejects.toMatchObject({code:'AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE'});expect(t.counts().posts).toBe(0);
});
it('preserves a remote fact after human interruption without reviving the bot',async()=>{
 const t=await fixture();await t.start();t.hook(async()=>{await db.transact(t.org,tx=>recordChatwootAttendanceEvent(tx,{...t.scope,credentialRevision:1},
  {event:'message_created',id:999,account:{id:7},inbox:{id:9},conversation:{id:11,inbox_id:9},message_type:'outgoing',private:true,sender:{id:99,type:'user'},content:'Synthetic human note'}));});
 await t.dispatch();expect(await t.state()).toMatchObject({status:'CANCELED',state:'CONFIRMED'});expect(t.counts().posts).toBe(1);
});
it('keeps a malformed causal result uncertain rather than accepting a self-declared success',async()=>{
 const t=await fixture();await t.start();t.malformed();expect(await t.dispatch()).toMatchObject({status:'UNKNOWN'});
 expect(await t.state()).toMatchObject({status:'WAITING',state:'UNKNOWN'});expect(t.counts().posts).toBe(1);
});
