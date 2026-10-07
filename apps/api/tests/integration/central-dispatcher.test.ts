import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createChatwootRuntimeIngress, createCentralTransportChannel } from '../../src/modules/integrations/chatwoot-runtime-ingress.js';
import { createAutomationService, createEventRouter, createExecutionService, createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { createAutomationEffectDispatcher } from '../../src/commands/automation-worker.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { transitionChannelOwner } from '../../src/modules/attendance/transition.js';
import { ChatwootClient, ChatwootError } from '../../src/modules/integrations/chatwoot-client.js';
import { AUTOMATION_ORIGIN } from '@jrc/contracts';
import { createChatwootAttendanceService } from '../../src/modules/integrations/chatwoot-attendance-service.js';
import { createNativeHandoffService } from '../../src/modules/attendance/handoff-service.js';
import { readCentralTransportContext } from '../../src/modules/messaging/central-transport.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
const codec=createIntegrationSecrets(Buffer.alloc(32,19).toString('base64'));
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
async function fixture(journey=false,ownBot=false) {
 const org=randomUUID(),channel=randomUUID(),integration=randomUUID(),origin=`https://${org}.example.test`,secret='synthetic-secret';
 const seed=await db.database.pool.connect();
 try{
  await seed.query('BEGIN');
  await seed.query("INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Central output',$1::text)",[org]);
  const user=randomUUID();await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-login')",[user,`${user}@example.test`]);
  await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,user]);
  await seed.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)',[org]);
  await seed.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status,encrypted_token) VALUES($1,$2,7,'READY',$3)",[org,origin,codec.encrypt(`chatwoot:${org}`,'synthetic-token')]);
  await seed.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[org]);await seed.query('COMMIT');
 }catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
 await db.transact(org,tx=>createCentralTransportChannel(tx,{organizationId:org,channelId:channel,integrationId:integration,origin,accountId:7,inboxId:9,destinationRevision:1,credentialVersion:1,ownerRevision:0,encryptedWebhookSecret:codec.encrypt(`${org}:chatwoot-webhook:${integration}`,secret),name:'Synthetic central'}));
 const automation=createAutomationService({transact:db.transact,enabled:true});
 const graph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'menu',type:'menu',label:'Menu',position:{x:100,y:0},data:{text:'Synthetic menu',variable:'choice',options:[{value:'1',label:'End'},{value:'2',label:'Finish'}]}},{id:'end',type:'end',label:'End',position:{x:200,y:0},data:{}}],edges:[{id:'next',source:'start',target:'menu',port:'next'},{id:'end',source:'menu',target:'end',port:'option-1'},{id:'finish',source:'menu',target:'end',port:'option-2'}]};
 const destination={integrationId:integration,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9};
 const draft=await automation.create(org,{name:'Central menu',graph});await automation.publish(org,draft.id,1);
 // Seed the already-published handoff definition; publication readiness is tested separately.
 if(journey){graph.nodes.push({id:'name',type:'input',label:'Name',position:{x:200,y:0},data:{text:'Synthetic name?',variable:'name'}} as typeof graph.nodes[number],
  {id:'handoff',type:'handoff',label:'Handoff',position:{x:300,y:0},data:{handoffVersion:1,destination,target:{teamId:4,agentId:null}}} as typeof graph.nodes[number]);
  graph.edges[1]!.target='name';graph.edges.push({id:'capture',source:'name',target:'handoff',port:'next'});
  await db.database.pool.query('UPDATE automation_versions SET graph=$2 WHERE organization_id=$1 AND automation_id=$3',[org,JSON.stringify(graph),draft.id]);}
 await db.transact(org,async tx=>{const own=await transitionChannelOwner(tx,org,{channelId:channel,botPublicId:draft.id,botOriginReference:AUTOMATION_ORIGIN,version:1});await tx.query('UPDATE central_transport_bindings SET owner_revision=$3 WHERE organization_id=$1 AND channel_id=$2',[org,channel,own.ownerRevision]);});
 if(ownBot)await db.transact(org,tx=>tx.query("UPDATE central_transport_bindings SET bot_id=19,bot_callback='https://broker.example.test/events' WHERE channel_id=$1",[channel]));
 const conversation={id:101,account_id:7,inbox_id:9,status:'pending',meta:{sender:{id:301},assignee:ownBot?{id:19,type:'agent_bot'}:null,assignee_type:ownBot?'AgentBot':null,team:null as null|{id:number}}};
 const incoming=new Map<number,string>([[201,'Synthetic greeting']]);
 let inboxBotId=19;
 const ingress=createChatwootRuntimeIngress({transact:db.transact,secrets:codec,resolveIntegration:async()=>org,router:createEventRouter({transact:db.transact,enabled:true}),readCanonical:async(_binding,conv,id)=>({inboxBot:ownBot?{id:inboxBotId,outgoing_url:'https://broker.example.test/events'}:null,conversation:{...conversation,id:conv},message:{id,conversation_id:conv,message_type:'incoming',private:false,content:incoming.get(id)!,sender:{id:301,type:'contact'},created_at:Math.floor(Date.now()/1000)}})});
 const callback=async(extra:Record<string,unknown>={})=>{if(extra.message_type!=='outgoing')incoming.set(Number(extra.id??201),String(extra.content??'Synthetic greeting'));const raw=Buffer.from(JSON.stringify({event:'message_created',id:201,account:{id:7},inbox:{id:9},conversation:{id:101,inbox_id:9,contact_inbox:{contact_id:301}},private:false,message_type:'incoming',content:'Synthetic greeting',sender:{id:301,type:'contact'},...extra})),timestamp=String(Math.floor(Date.now()/1000));return ingress.receive({integrationId:integration,raw,timestamp,signature:'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex')});};
 const received=await callback();await ingress.process(org,received.eventId!);
 await createExecutionService({transact:db.transact,enabled:true}).runOnce(org);
 const effects=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository()}));
 expect(await effects.runOnce(org)).toMatchObject({status:'SENT'});
 const message=(await db.transact(org,tx=>tx.query("SELECT id,content,state FROM messaging_messages WHERE source='AUTOMATION'"))).rows[0];
 const requests:string[]=[],remote:{id:number;content:string;content_attributes:Record<string,unknown>;conversation_id:number;senderId?:number}[]=[];
 let postHook:(()=>Promise<void>)|undefined,fail=false,blockedConversation:number|undefined;
 const client=new ChatwootClient({baseUrl:origin,token:'synthetic-token',fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname;requests.push(`${init?.method} ${path}`);
  if(path.endsWith('/messages')){
   const conv=Number(path.split('/').at(-2));
   if(init?.method==='POST'){const body=JSON.parse(String(init.body)),id=401+remote.length;remote.push({id,content:body.content,content_attributes:body.content_attributes,conversation_id:conv});await postHook?.();if(fail)throw new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN',false,true);return Response.json({id});}
   return Response.json({payload:remote.filter(m=>m.conversation_id===conv).map(m=>({...m,account_id:7,inbox_id:9,message_type:1,private:false,content_type:'text',status:'sent',sender:{id:m.senderId??501,type:'user'},created_at:Math.floor(Date.now()/1000)}))});
  }
  if(path==='/api/v1/profile')return Response.json({id:501,accounts:[{id:7,role:'administrator'}]});
  if(path.endsWith('/inboxes/9'))return Response.json({id:9,name:'Synthetic inbox',channel_type:'Channel::Whatsapp',greeting_enabled:false,enable_auto_assignment:false});
  if(path.endsWith('/agents'))return Response.json([{id:12,name:'Synthetic agent',email:'agent@example.test'}]);
  if(path.endsWith('/inbox_members/9'))return Response.json({payload:[{id:12,name:'Synthetic agent',email:'agent@example.test'}]});
  if(path.endsWith('/teams'))return Response.json([{id:4,name:'Synthetic team',account_id:7,allow_auto_assign:false}]);
  if(path.endsWith('/labels'))return Response.json({payload:[]});
  if(path.endsWith('/custom_attribute_definitions'))return Response.json([]);
  if(path.endsWith('/agent_bot'))return Response.json({agent_bot:ownBot?{id:inboxBotId,name:'Broker',outgoing_url:'https://broker.example.test/events',secret:'synthetic'}:null});
  if(path.endsWith('/toggle_status')){conversation.status='open';conversation.meta.assignee=null;conversation.meta.assignee_type=null;await callback({event:'conversation_updated',id:101,inbox_id:9,status:'open',meta:conversation.meta});return Response.json({});}
  if(path.endsWith('/assignments')){conversation.meta.team={id:4};await callback({event:'conversation_updated',id:101,inbox_id:9,status:'open',meta:conversation.meta});return Response.json({});}
  const conv=Number(path.split('/').at(-1));
  if(conv===blockedConversation)return new Response('',{status:503});
  return Response.json({...conversation,id:conv});
 }});
 const path='../../src/modules/messaging/central-dispatcher.js',module=await import(path).catch(()=>null);
 expect(module,'central dispatcher must exist').not.toBeNull();
 const dispatcher=()=>module!.createCentralDispatcher({transact:db.transact,client:()=>client,enabled:true});
 const catalog=createChatwootAttendanceService({transact:db.transact,client:()=>client});
 const handoff=createNativeHandoffService({transact:db.transact,client:()=>client,attendanceService:{catalog:catalog.catalog,validateTarget:catalog.validateTarget}});
 const journeyEffects=createOutboxDispatcher({transact:db.transact,enabled:true},createAutomationEffectDispatcher({transact:db.transact,messaging:createPostgresMessagingRepository(),handoff}));
 return {org,channel,integration,message,callback,requests,remote,dispatcher,ingress,catalog,journeyEffects,setInboxBot:(id:number)=>{inboxBotId=id;},worker:()=>createExecutionService({transact:db.transact,enabled:true}),blockConversation:(id:number)=>{blockedConversation=id;},setFail:()=>{fail=true;},setHook:(hook:()=>Promise<void>)=>{postHook=hook;}};
}
it('refuses sending when only the inbox bot changes but the conversation remains assigned to the Broker',async()=>{
 const t=await fixture(false,true);t.setInboxBot(20);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(0);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'FAILED'}]);
});
it('refuses admitting another Flow input after the inbox bot changes without changing the conversation assignee',async()=>{
 const t=await fixture(false,true);t.setInboxBot(20);const next=await t.callback({id:202,content:'1'});
 await expect(t.ingress.process(t.org,next.eventId!)).rejects.toThrow('CENTRAL_REMOTE_BOT_CHANGED');
 expect((await db.transact(t.org,tx=>tx.query('SELECT disposition FROM central_runtime_events WHERE id=$1',[next.eventId]))).rows).toEqual([{disposition:'RECEIVED'}]);
});
it('sends through the unique runtime when the canonical conversation is assigned to its own AgentBot',async()=>{
 const t=await fixture(false,true);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'SENT'}]);
});
it('sends once via central and proves a canonical receipt, without QR/Meta/mirror jobs',async()=>{
 const t=await fixture();expect(t.message.state).toBe('ACCEPTED');
 await Promise.all([t.dispatcher().runOnce(t.org),t.dispatcher().runOnce(t.org)]);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'SENT'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT kind FROM integration_jobs'))).rows).toEqual([]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state,transport,job_id FROM chatwoot_mirror_attempts'))).rows).toEqual([{state:'CONFIRMED',transport:'CENTRAL_TRANSPORT',job_id:null}]);
});
it('reconciles timeout after remote acceptance across restart without another POST',async()=>{
 const t=await fixture();t.setFail();await t.dispatcher().runOnce(t.org);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
 await db.database.pool.query("UPDATE chatwoot_mirror_attempts SET available_at=now()-interval '1 second' WHERE organization_id=$1",[t.org]);
 await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'SENT'}]);
});
it('blocks stale credential before dispatch, preserving no remote POST',async()=>{
 const t=await fixture();await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);
 await t.dispatcher().runOnce(t.org);expect(t.requests.filter(x=>x.startsWith('POST'))).toEqual([]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'FAILED'}]);
});
it('captures one locked credential snapshot and refuses the next read after rotation',async()=>{
 const t=await fixture();let rotated=false;let rotation:Promise<unknown>|undefined;
 try {
  await db.transact(t.org,async tx=>{
   const snapshot=await readCentralTransportContext(tx,t.org,t.integration);
   rotation=db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]).then(()=>{rotated=true;});
   await new Promise(resolve=>setTimeout(resolve,100));
   expect(rotated).toBe(false);
   expect(snapshot.account.credential_version).toBe(snapshot.binding.credentialVersion);
   expect(snapshot.account.base_url).toBe(snapshot.binding.origin);
   expect(Number(snapshot.account.account_id)).toBe(snapshot.binding.accountId);
  });
 } finally {await rotation;}
 expect(rotated).toBe(true);
 await expect(db.transact(t.org,tx=>readCentralTransportContext(tx,t.org,t.integration))).rejects.toThrow('CENTRAL_CONTEXT_CHANGED');
 await t.dispatcher().runOnce(t.org);expect(t.requests).toEqual([]);
});
it('never accepts a human message carrying a real reserved UUID as UNKNOWN send proof',async()=>{
 const t=await fixture();t.setFail();t.setHook(async()=>{t.remote.splice(0);});await t.dispatcher().runOnce(t.org);
 t.remote.push({id:499,content:t.message.content.text,conversation_id:101,senderId:999,content_attributes:{jrc_broker_message_id:t.message.id}});
 await t.callback({id:499,message_type:'outgoing',sender:{id:999,type:'user'},content_attributes:{jrc_broker_message_id:t.message.id}});
 await db.database.pool.query("UPDATE chatwoot_mirror_attempts SET available_at=now()-interval '1 second' WHERE organization_id=$1",[t.org]);
 await t.dispatcher().runOnce(t.org);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
});
it('backs off one failed preflight without starving another conversation in the same company',async()=>{
 const t=await fixture();const event=await t.callback({id:202,conversation:{id:102,inbox_id:9,contact_inbox:{contact_id:301}}});
 await t.ingress.process(t.org,event.eventId!);await t.worker().runOnce(t.org);await t.journeyEffects.runOnce(t.org);
 t.blockConversation(101);await t.dispatcher().runOnce(t.org);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toEqual(['POST /api/v1/accounts/7/conversations/102/messages']);
 expect((await db.transact(t.org,tx=>tx.query('SELECT remote_conversation_id,state FROM chatwoot_mirror_attempts ORDER BY remote_conversation_id'))).rows).toEqual([{remote_conversation_id:'101',state:'RESERVED'},{remote_conversation_id:'102',state:'CONFIRMED'}]);
});
it('does not confirm an ACK after credential rotation during IO and never replays',async()=>{
 const t=await fixture();t.setHook(async()=>{await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=2 WHERE organization_id=$1',[t.org]);});
 await t.dispatcher().runOnce(t.org);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
});
it('holds echo until exact persisted send proof, while a forged marker remains human',async()=>{
 const t=await fixture();t.setHook(async()=>{await t.callback({id:401,message_type:'outgoing',sender:{id:501,type:'user'},content:t.message.content.text,content_attributes:t.remote[0]!.content_attributes});});
 await t.dispatcher().runOnce(t.org);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'READY'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT disposition,event FROM chatwoot_attendance_observations'))).rows).toEqual([expect.objectContaining({disposition:'IGNORED',event:expect.objectContaining({kind:'BROKER_ECHO'})})]);
 await t.callback({id:402,message_type:'outgoing',sender:{id:501,type:'user'},content_attributes:{jrc_broker_message_id:randomUUID()}});
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
});
it('human takeover prevents an undispatched message and survives canonical pending',async()=>{
 const t=await fixture();await t.callback({id:402,message_type:'outgoing',sender:{id:501,type:'user'}});
 await t.dispatcher().runOnce(t.org);expect(t.requests.filter(x=>x.startsWith('POST'))).toEqual([]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
});
it('observes native WhatsApp inbox membership and validates its human target',async()=>{
 const t=await fixture();const catalog=await t.catalog.catalog(t.org,t.integration);
 expect(catalog.agents).toEqual([{id:12,name:'Synthetic agent',inboxMember:true}]);
 expect(await t.catalog.validateTarget(catalog.scope,{teamId:4,agentId:null})).toMatchObject({target:{teamId:4,agentId:null}});
});
it.each([false,true])('runs menu, capture and canonical human transfer with own AgentBot=%s through the actual runtime with synthetic HTTP only',async own=>{
 const t=await fixture(true,own);await t.dispatcher().runOnce(t.org);
 const choice=await t.callback({id:202,content:'1'});await t.ingress.process(t.org,choice.eventId!);
 expect(await t.worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
 expect(await t.journeyEffects.runOnce(t.org)).toMatchObject({status:'SENT'});
 const name=await t.callback({id:203,content:'Synthetic person'});await t.ingress.process(t.org,name.eventId!);
 expect(await t.worker().runOnce(t.org)).toMatchObject({status:'HANDOFF'});
 expect(await t.journeyEffects.runOnce(t.org)).toMatchObject({status:'NOT_SENT'});
 expect(t.requests.filter(x=>x.includes('toggle_status'))).toEqual([]);
 await t.dispatcher().runOnce(t.org);
 await db.database.pool.query("UPDATE automation_outbox SET available_at=now() WHERE organization_id=$1 AND kind='HANDOFF'",[t.org]);
 const transferred=await t.journeyEffects.runOnce(t.org);
 const evidence=(await db.transact(t.org,tx=>tx.query('SELECT state,phase,last_error FROM attendance_handoff_operations'))).rows;
 expect(transferred,JSON.stringify({evidence,requests:t.requests})).toMatchObject({status:'SENT'});
 expect(t.requests.filter(x=>x.startsWith('POST')).map(x=>x.split('/').at(-1))).toEqual(['messages','messages','toggle_status','assignments']);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM attendance_sessions'))).rows).toEqual([{state:'WAITING_HUMAN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT mode FROM messaging_conversations'))).rows).toEqual([{mode:'HUMAN'}]);
});
it('terminates revoked ingress context and allows a newer event to progress',async()=>{
 const t=await fixture();await t.callback({id:202,content:'1'});
 await db.database.pool.query('UPDATE central_runtime_events SET credential_version=2 WHERE organization_id=$1 AND remote_message_id=202',[t.org]);
 await t.callback({id:203,content:'2'});
 expect(await t.ingress.runOnce(t.org)).toMatchObject({disposition:'FAILED'});
 expect(await t.ingress.runOnce(t.org)).toMatchObject({disposition:'ROUTED'});
});
it('keeps an expired dispatch lease UNKNOWN and never submits a new POST',async()=>{
 const t=await fixture();await db.database.pool.query("UPDATE chatwoot_mirror_attempts SET state='DISPATCHED',sender_id=501,lease_expires_at=now()-interval '1 second' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND id=$2",[t.org,t.message.id]);
 await t.dispatcher().runOnce(t.org);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toEqual([]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
});
it('does not promote an ACK with mismatched canonical text to SENT',async()=>{
 const t=await fixture();t.setHook(async()=>{t.remote[0]!.content='Different synthetic text';});await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
});
it('rejects a canonical ACK and callback with the proof but a different author',async()=>{
 const t=await fixture();t.setHook(async()=>{
  t.remote[0]!.senderId=999;
  await t.callback({id:401,message_type:'outgoing',sender:{id:999,type:'user'},content_attributes:t.remote[0]!.content_attributes});
 });await t.dispatcher().runOnce(t.org);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'UNKNOWN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
});
it.each(['before','during'] as const)('invalidates owner revision %s remote IO without replay',async phase=>{
 const t=await fixture();const change=()=>db.transact(t.org,tx=>transitionChannelOwner(tx,t.org,{channelId:t.channel,botPublicId:null,botOriginReference:null}));
 if(phase==='before')await change();else t.setHook(async()=>{await change();});
 await t.dispatcher().runOnce(t.org);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(phase==='before'?0:1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:phase==='before'?'FAILED':'UNKNOWN'}]);
});
it.each(['before','during'] as const)('invalidates destination revision %s remote IO without replay',async phase=>{
 const t=await fixture();const change=()=>db.database.pool.query('UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1',[t.org]);
 if(phase==='before')await change();else t.setHook(async()=>{await change();});
 await t.dispatcher().runOnce(t.org);await t.dispatcher().runOnce(t.org);
 expect(t.requests.filter(x=>x.startsWith('POST'))).toHaveLength(phase==='before'?0:1);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:phase==='before'?'FAILED':'UNKNOWN'}]);
});
it('records the real receipt after takeover without changing HUMAN back to BOT',async()=>{
 const t=await fixture();t.setHook(async()=>{await t.callback({id:402,message_type:'outgoing',sender:{id:501,type:'user'}});});await t.dispatcher().runOnce(t.org);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[t.message.id]))).rows).toEqual([{state:'SENT'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT state FROM chatwoot_attendance_controls'))).rows).toEqual([{state:'HUMAN'}]);
 expect((await db.transact(t.org,tx=>tx.query('SELECT mode FROM messaging_conversations'))).rows).toEqual([{mode:'HUMAN'}]);
});
it('isolates two companies with the same remote IDs and progresses while the other is UNKNOWN',async()=>{
 const a=await fixture(),b=await fixture();a.setFail();await a.dispatcher().runOnce(a.org);await b.dispatcher().runOnce(b.org);
 expect((await db.transact(b.org,tx=>tx.query('SELECT id FROM chatwoot_mirror_attempts WHERE organization_id=$1',[a.org]))).rows).toEqual([]);
 expect((await db.transact(b.org,tx=>tx.query('SELECT state FROM messaging_messages WHERE id=$1',[b.message.id]))).rows).toEqual([{state:'SENT'}]);
 expect(a.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);expect(b.requests.filter(x=>x.startsWith('POST'))).toHaveLength(1);
});
