import {createHmac,randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {OrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {createFlowDelegationService} from '../../src/modules/flows/delegation/service.js';
import {createNativeFlowAdapter} from '../../src/modules/flows/delegation/native-adapter.js';
import {NativeOwnershipRequestSchema} from '../../src/modules/flows/delegation/native-ownership-contracts.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {ensureQrChannel} from '../../src/modules/messaging/qr-service.js';
import {createCentralCutoverService} from '../../src/modules/channels/central-cutover-service.js';
import {FLOW_GUARDED_PATHS} from '@jrc/contracts';
import {createChatwootHealth} from '../../src/modules/integrations/chatwoot-health.js';
import {createChatwootRuntimeIngress} from '../../src/modules/integrations/chatwoot-runtime-ingress.js';
import {approveOriginFixture} from './helpers/flow-origin-fixture.js';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {validatorCompiler,serializerCompiler} from 'fastify-type-provider-zod';
import {issueAccessToken} from '@jrc/security';
import {registerFlowDelegationRoutes} from '../../src/http/routes/flow-delegation.js';
import {createFlowSessionResolver} from '../../src/modules/flows/delegation/runtime.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const vault=createIntegrationSecrets(Buffer.alloc(32,29).toString('base64'));
const full=['flow:read','flow:edit','flow:publish','flow:bind'];
const graph={nodes:[{id:'s',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'e',type:'end',label:'End',position:{x:1,y:0},data:{}}],edges:[{id:'next',source:'s',target:'e',port:'next'}]};
beforeAll(async()=>{db=await attendanceDatabase();});
afterAll(async()=>{await db?.dispose();});
async function syntheticAuthorityRoundtrip(){
 // checkedAt is sampled before the HTTP adapter. The instantaneous fake must
 // wait for that instant on the SQL authority clock when Windows/PG differ.
 // Keep real clocks and deadlines; this bounded SQL barrier models the I/O.
 const receivedAt=Date.now(),deadline=performance.now()+1000;
 do{
  const sqlNow=Number((await db.database.pool.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
  if(sqlNow>=receivedAt)return;
 }while(performance.now()<deadline);
 throw new Error('Synthetic authority clocks did not converge within 1 second');
}
async function rowLockBarrier(fragment:string){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const waiting=(await db.database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS waiting",[`%${fragment}%`])).rows[0].waiting;
  if(waiting)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Expected PostgreSQL row-lock barrier was not observed');
}
async function expiresOnSqlClock(table:'flow_delegation_credentials'|'flow_delegation_sessions'|'flow_executor_cutovers',id:string,column:'expires_at'|'lease_expires_at'){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  if((await db.database.pool.query(`SELECT ${column}<=clock_timestamp() AS expired FROM ${table} WHERE id=$1`,[id])).rows[0].expired)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Expected SQL expiry was not observed');
}
async function fixture(origin?:string){
 const t=await seedAttendanceTenant(db.database,!origin);
 if(origin){
  await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode) VALUES($1,$2,'EXTERNAL')",[t.org,origin]);
  await db.database.pool.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,status) VALUES($1,$2,8,'READY')",[t.org,origin]);
  await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,9,'Shared real inbox mapping','READY')",[t.integration,t.org,t.channel]);
 }
 const actor=(await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1',[t.org])).rows[0].user_id;
 const authVersion=(await db.database.pool.query('SELECT auth_version FROM users WHERE id=$1',[actor])).rows[0].auth_version;
 const retainedOwner=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",[retainedOwner,`${retainedOwner}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[t.org,retainedOwner]);
 await db.database.pool.query("UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1",[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 let afterRead:(()=>Promise<void>)|undefined;
 const client=new ChatwootClient({baseUrl:`https://${t.org}.example.test`,token:'synthetic-token',fetch:async(url)=>{
  await afterRead?.();
  const path=new URL(String(url)).pathname;
  if(path==='/api/v1/profile')return Response.json({id:51,accounts:[{id:7,role:'administrator'}]});
  if(path.endsWith('/agent_bot'))return Response.json({agent_bot:null});
  if(path.endsWith('/inboxes/9'))return Response.json({id:9,name:'Synthetic inbox',channel_type:'Channel::Api',webhook_url:'https://broker.example.test/events'});
  throw new Error('Unexpected synthetic request');
 }});
 const principal={organizationId:t.org,actorId:actor,authVersion};
 const service=createFlowDelegationService({transact:db.transact,automation:{enabled:true},client:()=>client});
 const session=await service.issueBrokerSession(principal,{integrationIds:[t.integration],scopes:full});
 const access={organizationId:t.org,token:session.token};
 return {...t,actor,principal,service,session,access,client,
  serviceWith:(extra:any)=>createFlowDelegationService({transact:db.transact,automation:{enabled:true},client:()=>client,...extra}),
  onRead:(fn:()=>Promise<void>)=>{afterRead=fn;}};
}
it('projects only current canonical inbox grants and owner/profile revisions for the delegated UI',async()=>{
 const t=await fixture();
 const targets=await t.service.targets(t.access);
 expect(targets).toEqual({data:[{integrationId:t.integration,channelId:t.channel,accountId:7,inboxId:9,transport:'BROKER_TRANSPORT',scopes:full,ownerRevision:0,profileRevision:0}]});
 expect(JSON.stringify(targets)).not.toContain(t.session.token);
 const draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 expect(await t.service.scope(t.access,draft.id)).toEqual({revision:1,integrationIds:[t.integration]});
 await db.database.pool.query('UPDATE automation_definitions SET delegation_scope_revision=2 WHERE id=$1',[draft.id]);
 expect(await t.service.scope(t.access,draft.id)).toMatchObject({revision:2});
 await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);
 await expect(t.service.targets(t.access)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
it('rejects target projection when the Flow session expires while waiting for its executor profile lock',async()=>{
 const t=await fixture();await approveOriginFixture(db.database,t.org,'STOCK');await t.service.configureExecutorProfile(t.principal,{integrationId:t.integration,expectedRevision:0});
 const blocker=await db.database.pool.connect();try{
  await blocker.query('BEGIN');await blocker.query('SELECT integration_id FROM flow_executor_profiles WHERE organization_id=$1 FOR UPDATE',[t.org]);
   // Keep the initial guard alive until it reaches the profile lock; expiry is
   // then observed on the SQL clock while that lock is still held.
  await db.database.pool.query("UPDATE flow_delegation_sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",[t.session.id]);
  const pending=t.service.targets(t.access).then(value=>({value}),error=>({error}));await rowLockBarrier('SELECT integration_id,revision FROM flow_executor_profiles');await expiresOnSqlClock('flow_delegation_sessions',t.session.id,'expires_at');await blocker.query('COMMIT');
  expect(await pending).toMatchObject({error:{code:'FLOW_ACCESS_DENIED'}});
 }finally{await blocker.query('ROLLBACK');blocker.release();}
});
it('lists first-party target choices using current explicit operator inbox grants without editor authority',async()=>{
 const t=await fixture();expect((await t.service.availableTargets(t.principal)).data).toHaveLength(1);
 await t.service.setMemberGrant(t.principal,{userId:t.actor,integrationId:t.integration,scopes:['flow:read'],expectedRevision:0});
 await db.database.pool.query("UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);
 expect((await t.service.availableTargets(t.principal)).data[0]).toMatchObject({integrationId:t.integration,scopes:['flow:read']});
 await db.database.pool.query("UPDATE flow_member_grants SET scopes='{}' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);
 expect(await t.service.availableTargets(t.principal)).toEqual({data:[]});
});
it('creates a canonical scoped draft atomically and exposes no session digest in its response',async()=>{
 const t=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]},randomUUID());
 expect(draft).toMatchObject({name:'Scoped',draft:{revision:1},scopeRevision:1});
 const scopes=(await db.transact(t.org,tx=>tx.query('SELECT automation_id,integration_id,channel_id,account_id,inbox_id FROM automation_definition_scopes'))).rows;
 expect(scopes).toEqual([{automation_id:draft.id,integration_id:t.integration,channel_id:t.channel,account_id:'7',inbox_id:'9'}]);
 expect(JSON.stringify(draft)).not.toContain(t.session.token);
 expect((await createAutomationService({transact:db.transact}).get(t.org,draft.id)).draft.graph).toEqual(graph);
});
it('saves and publishes through canonical CAS and immutable versions',async()=>{
 const t=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 const saved=await t.service.save(t.access,draft.id,{name:'Edited',graph,revision:1,expectedScopeRevision:1});
 expect(saved.draft.revision).toBe(2);
 await expect(t.service.save(t.access,draft.id,{name:'Stale',graph,revision:1,expectedScopeRevision:1})).rejects.toMatchObject({code:'AUTOMATION_CHANGED'});
 const published=await t.service.publish(t.access,draft.id,{revision:2,expectedScopeRevision:1});
 expect(published).toMatchObject({automationId:draft.id,version:1,graph});
 expect((await db.transact(t.org,tx=>tx.query('SELECT runtime_state_version,checksum FROM automation_versions WHERE automation_id=$1',[draft.id]))).rows[0]).toMatchObject({runtime_state_version:2,checksum:expect.stringMatching(/^[a-f0-9]{64}$/)});
});
it('requires an explicit action scope and current membership for every operation',async()=>{
 const t=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 const read=await t.service.issueBrokerSession(t.principal,{integrationIds:[t.integration],scopes:['flow:read']});
 await expect(t.service.get({organizationId:t.org,token:read.token},draft.id)).resolves.toMatchObject({id:draft.id});
 await expect(t.service.save({organizationId:t.org,token:read.token},draft.id,{name:'Changed',graph,revision:1,expectedScopeRevision:1})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);
 await expect(t.service.get(t.access,draft.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT draft_revision FROM automation_definitions WHERE id=$1',[draft.id])).rows[0].draft_revision).toBe(1);
});
it('binds create idempotency to the persisted inbox set and leaves no partial graph on failure',async()=>{
 const t=await fixture(),key=randomUUID(),input={name:'Scoped',graph,integrationIds:[t.integration]};
 const a=await t.service.create(t.access,input,key),b=await t.service.create(t.access,input,key);
 expect(a.id).toBe(b.id);
 await expect(t.service.create(t.access,{...input,integrationIds:[randomUUID()]},key)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query("SELECT count(*)::int n FROM automation_definitions WHERE organization_id=$1 AND name='Scoped'",[t.org])).rows[0].n).toBe(1);
});
it('rejects a stale scope revision before canonical mutation',async()=>{
 const t=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 await db.database.pool.query('UPDATE automation_definitions SET delegation_scope_revision=2 WHERE organization_id=$1 AND id=$2',[t.org,draft.id]);
 await expect(t.service.publish(t.access,draft.id,{revision:1,expectedScopeRevision:1})).rejects.toMatchObject({code:'FLOW_SCOPE_CHANGED'});
 expect((await db.database.pool.query('SELECT count(*)::int n FROM automation_versions WHERE automation_id=$1',[draft.id])).rows[0].n).toBe(0);
});
async function secondInbox(t:Awaited<ReturnType<typeof fixture>>){
 const channel=randomUUID(),integration=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0].provider_account_id;
 await db.database.pool.query("INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference) VALUES($1,$2,$3,$4,'synthetic','vault://synthetic')",[channel,t.org,provider,`synthetic-${channel}`]);
 await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,19,'Synthetic second','READY')",[integration,t.org,channel]);
 return {channel,integration};
}
it('requires all persisted inboxes for a shared draft and filters before pagination',async()=>{
 const t=await fixture(),second=await secondInbox(t);
 const broad=await t.service.issueBrokerSession(t.principal,{integrationIds:[t.integration,second.integration],scopes:full});
 const access={organizationId:t.org,token:broad.token};
 const visible=await t.service.create(access,{name:'Visible',graph,integrationIds:[t.integration]});
 const hidden=await t.service.create(access,{name:'Shared hidden',graph,integrationIds:[t.integration,second.integration]});
 await expect(t.service.get(t.access,hidden.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 const page=await t.service.list(t.access,{pageSize:1});
 expect(page.data.map((row:any)=>row.id)).toEqual([visible.id]);expect(page.nextCursor).toBeNull();
 expect(JSON.stringify(page)).not.toContain(hidden.id);expect(JSON.stringify(page)).not.toContain(t.automation);
});
it.each(['auth','expiry','revocation','destination','credential','disabled'])('revokes a live delegated session after %s changes',async(change)=>{
 const t=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 if(change==='auth')await db.database.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[t.actor]);
 if(change==='expiry')await db.database.pool.query("UPDATE flow_delegation_sessions SET created_at=clock_timestamp()-interval '6 minutes',expires_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[t.session.id]);
 if(change==='revocation')await db.database.pool.query('UPDATE flow_delegation_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[t.session.id]);
 if(change==='destination')await db.database.pool.query('UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1',[t.org]);
 if(change==='credential')await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1',[t.org]);
 if(change==='disabled')await db.database.pool.query('UPDATE flow_features SET enabled=false WHERE organization_id=$1',[t.org]);
 await expect(t.service.get(t.access,draft.id)).rejects.toBeInstanceOf(Error);
 expect((await db.database.pool.query('SELECT draft_revision FROM automation_definitions WHERE id=$1',[draft.id])).rows[0].draft_revision).toBe(1);
});
it('rolls publication back when role is revoked during remote handoff readiness',async()=>{
 const t=await fixture();
 const handoffGraph={nodes:[graph.nodes[0],{id:'h',type:'handoff',label:'Human',position:{x:1,y:0},data:{handoffVersion:1,destination:{integrationId:t.integration,destinationRevision:1,accountId:7,inboxId:9,credentialRevision:1},target:{teamId:3,agentId:null}}}],edges:[{id:'next',source:'s',target:'h',port:'next'}]};
 const service=t.serviceWith({automation:{enabled:true,handoffReadiness:{prepare:async()=>{
  await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);return {assertCurrent:async()=>{}};
 }}}});
 const draft=await service.create(t.access,{name:'Handoff',graph:handoffGraph,integrationIds:[t.integration]});
 await expect(service.publish(t.access,draft.id,{revision:1,expectedScopeRevision:1})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT count(*)::int n FROM automation_versions WHERE automation_id=$1',[draft.id])).rows[0].n).toBe(0);
});
it('rejects foreign graph destinations and unscoped immutable subflows atomically',async()=>{
 const t=await fixture(),foreign=await fixture();
 const handoff={nodes:[graph.nodes[0],{id:'h',type:'handoff',label:'Human',position:{x:1,y:0},data:{handoffVersion:1,destination:{integrationId:foreign.integration,destinationRevision:1,accountId:7,inboxId:9,credentialRevision:1},target:{teamId:3,agentId:null}}}],edges:[{id:'next',source:'s',target:'h',port:'next'}]};
 await expect(t.service.create(t.access,{name:'Foreign',graph:handoff,integrationIds:[t.integration]})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 const subflow={nodes:[graph.nodes[0],{id:'sub',type:'subflow',label:'Child',position:{x:1,y:0},data:{automationId:t.automation,version:1}}],edges:[{id:'next',source:'s',target:'sub',port:'next'}]};
 await expect(t.service.create(t.access,{name:'Unscoped child',graph:subflow,integrationIds:[t.integration]})).rejects.toMatchObject({code:'FLOW_DEFINITION_NOT_FOUND'});
 expect((await db.database.pool.query("SELECT count(*)::int n FROM automation_definitions WHERE organization_id=$1 AND name IN ('Foreign','Unscoped child')",[t.org])).rows[0].n).toBe(0);
});
it('does not let another tenant replay an opaque session even with matching Account/Inbox IDs',async()=>{
 const t=await fixture(),foreign=await fixture();
 await expect(t.service.list({organizationId:foreign.org,token:t.session.token})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await expect(db.transact(t.org,tx=>tx.query('INSERT INTO automation_definition_scopes(organization_id,automation_id,integration_id,channel_id,account_id,inbox_id,destination_revision) VALUES($1,$2,$3,$4,7,9,1)',[t.org,t.automation,foreign.integration,foreign.channel]))).rejects.toMatchObject({code:'23503'});
 expect((await db.transact(foreign.org,tx=>tx.query('SELECT * FROM flow_delegation_sessions'))).rows.every(row=>row.organization_id===foreign.org)).toBe(true);
});
it('grants an operator only current explicit Flow read per inbox and revokes it immediately',async()=>{
 const t=await fixture(),operator=randomUUID();
 await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",[operator,`${operator}@example.test`]);
 await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,operator]);
 const draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 const grant=await t.service.setMemberGrant(t.principal,{userId:operator,integrationId:t.integration,scopes:['flow:read'],expectedRevision:0});
 const session=await t.service.issueBrokerSession({organizationId:t.org,actorId:operator,authVersion:0},{integrationIds:[t.integration],scopes:['flow:read']});
 const access={organizationId:t.org,token:session.token};
 expect(await t.service.get(access,draft.id)).toMatchObject({id:draft.id});
 await t.service.setMemberGrant(t.principal,{userId:operator,integrationId:t.integration,scopes:[],expectedRevision:grant.revision});
 await expect(t.service.get(access,draft.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await expect(t.service.issueBrokerSession({organizationId:t.org,actorId:operator,authVersion:0},{integrationIds:[t.integration],scopes:full})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
async function qrInbox(t:Awaited<ReturnType<typeof fixture>>){
 const q=await db.transact(t.org,async tx=>{
  const provider=(await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic QR') RETURNING id",[t.org])).rows[0].id;
  const instance=(await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'QR',$3,'CONNECTED') RETURNING id",[t.org,provider,`synthetic-${randomUUID()}`])).rows[0].id;
  return {instance,channel:(await ensureQrChannel(tx,t.org,instance)).id};
 });
 const integration=randomUUID();
 await db.database.pool.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,$3,19,'QR inbox','READY')",[integration,t.org,q.channel]);
 const health=createChatwootHealth({encryptionKey:Buffer.alloc(32,29).toString('base64'),transact:db.transact,readIdentity:async()=>({connected:true,phone:'15550000001'})});
 await db.transact(t.org,async tx=>{await health.enroll(tx,t.org,integration);await health.observe(tx,t.org,q.channel,{connected:true,phone:'15550000001'});});
 await db.database.pool.query('UPDATE chatwoot_connection_health SET approved_fingerprint=observed_fingerprint WHERE organization_id=$1 AND integration_id=$2',[t.org,integration]);
 return {...q,integration,health};
}
function remoteClient(t:Awaited<ReturnType<typeof fixture>>){
 let bot:any=null,posts=0,afterRead:(()=>Promise<void>)|undefined;
 const bots:any[]=[];
 const client=new ChatwootClient({baseUrl:`https://${t.org}.example.test`,token:'synthetic-token',fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(init?.method==='POST'){
   posts++;
   if(path.endsWith('/set_agent_bot')){bot=bots.find(b=>b.id===JSON.parse(String(init.body)).agent_bot)??null;return new Response(null,{status:200});}
   if(path.endsWith('/agent_bots')){const body=JSON.parse(String(init.body)),b={id:19,name:body.name,outgoing_url:body.outgoing_url,secret:'synthetic-bot'};bots.push(b);return Response.json(b);}
   throw new Error('Unexpected synthetic POST');
  }
  await afterRead?.();
  if(path==='/api/v1/profile')return Response.json({id:51,accounts:[{id:7,role:'administrator'}]});
  if(path.endsWith('/agent_bots'))return Response.json(bots);
  if(path.endsWith('/agent_bot'))return Response.json({agent_bot:bot});
  if(/\/inboxes\/19$/.test(path))return Response.json({id:19,name:'Synthetic inbox',channel_type:'Channel::Api',webhook_url:'https://broker.example.test/unchanged',greeting_enabled:false,enable_auto_assignment:false});
  throw new Error('Unexpected synthetic GET');
 }});
 return {client,posts:()=>posts,setBot:(value:any)=>{bot=value;},onRead:(fn:()=>Promise<void>)=>{afterRead=fn;}};
}
it('binds existing QR through canonical ownership without converting transport or adding a second remote feed',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 const draft=await service.create(access,{name:'QR scoped',graph,integrationIds:[qr.integration]});
 await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 const binding=await service.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0});
 expect(binding).toMatchObject({channelId:qr.channel,automationId:draft.id,ownerRevision:1});
 expect((await db.database.pool.query('SELECT transport,provider,instance_id,bot_origin_reference FROM messaging_channels WHERE id=$1',[qr.channel])).rows[0]).toEqual({transport:'BROKER_TRANSPORT',provider:'BAILEYS',instance_id:qr.instance,bot_origin_reference:'jrc-automation-v2'});
 expect((await db.database.pool.query('SELECT count(*)::int n FROM central_transport_bindings WHERE channel_id=$1',[qr.channel])).rows[0].n).toBe(0);
 expect(remote.posts()).toBe(0);
 const audit=(await db.database.pool.query("SELECT actor_id,resource_id,metadata FROM audit_logs WHERE organization_id=$1 AND event_type='FLOW_BOUND'",[t.org])).rows;
 expect(audit).toEqual([{actor_id:t.actor,resource_id:draft.id,metadata:{actorKind:'BROKER',scopeRevision:1,ownerRevision:1}}]);
});
it('serves the real scoped HTTP create/save/publish/QR-bind journey through the dedicated auth lookup and current membership',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});await approveOriginFixture(db.database,t.org,'STOCK');
 const url=new URL(db.database.connectionString);url.username='jrc_auth';url.password='';const authPool=new Pool({connectionString:url.href,max:1}),app=Fastify(),secret='synthetic-p9-http-pg-secret-32bytes';
 app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
 await app.register(async scope=>registerFlowDelegationRoutes(scope,{service,jwtSecret:secret,resolveFlowSession:createFlowSessionResolver(authPool),resolveCurrentRole:async()=> (await db.database.pool.query('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status=\'ACTIVE\'',[t.org,t.actor])).rows[0]?.role??null}));
 try{
  const jwt={authorization:`Bearer ${await issueAccessToken({organizationId:t.org,userId:t.actor,role:'OWNER',authVersion:t.principal.authVersion},secret)}`};
  const profile=await app.inject({method:'POST',url:'/v1/flow-delegations/executor-profiles',headers:jwt,payload:{integrationId:qr.integration,expectedRevision:0}});expect(profile.statusCode).toBe(200);
  const issued=await app.inject({method:'POST',url:'/v1/flow-delegations/sessions',headers:jwt,payload:{integrationIds:[qr.integration],scopes:full}});expect(issued.statusCode).toBe(201);const session=issued.json(),headers={authorization:`Bearer ${session.token}`};
  const created=await app.inject({method:'POST',url:'/v1/delegated-flows',headers:{...headers,'idempotency-key':'http-qr-create-fixture'},payload:{name:'HTTP scoped QR',graph,integrationIds:[qr.integration]}});expect(created.statusCode).toBe(201);expect(created.headers['cache-control']).toBe('no-store');const draft=created.json();expect(draft.scopeRevision).toBe(1);
  expect((await app.inject({method:'PUT',url:'/v1/delegated-flows/'+draft.id,headers,payload:{name:'HTTP saved QR',graph,revision:1,expectedScopeRevision:1}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/delegated-flows/'+draft.id+'/publish',headers,payload:{revision:2,expectedScopeRevision:1}})).statusCode).toBe(200);
  expect((await app.inject({url:'/v1/delegated-flows/'+draft.id+'/versions',headers})).json().data).toHaveLength(1);
  const prepared=await app.inject({method:'POST',url:'/v1/delegated-flows/integrations/'+qr.integration+'/cutover/prepare',headers,payload:{expectedOwnerRevision:0}});expect(prepared.statusCode).toBe(200);
  const reconciled=await app.inject({method:'POST',url:'/v1/delegated-flows/integrations/'+qr.integration+'/cutover/reconcile',headers,payload:{cutoverId:prepared.json().id,expectedCutoverRevision:1,expectedOwnerRevision:0}});expect(reconciled.statusCode).toBe(200);
  const bound=await app.inject({method:'POST',url:'/v1/delegated-flows/'+draft.id+'/bindings',headers,payload:{integrationId:qr.integration,cutoverId:prepared.json().id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0}});expect(bound.statusCode).toBe(201);expect(bound.json()).toMatchObject({channelId:qr.channel,ownerRevision:1});
  expect((await app.inject({url:'/v1/delegated-flows/'+draft.id+'/scope',headers})).json()).toEqual({revision:1,integrationIds:[qr.integration]});expect((await app.inject({url:'/v1/delegated-flows/targets',headers})).json().data[0]).toMatchObject({transport:'BROKER_TRANSPORT',ownerRevision:1});
  expect(remote.posts()).toBe(0);expect((await db.database.pool.query('SELECT transport,instance_id FROM messaging_channels WHERE id=$1',[qr.channel])).rows[0]).toEqual({transport:'BROKER_TRANSPORT',instance_id:qr.instance});
  expect((await app.inject({method:'DELETE',url:'/v1/flow-delegations/sessions/'+session.id,headers:jwt})).statusCode).toBe(200);expect((await app.inject({url:'/v1/delegated-flows/'+draft.id,headers})).statusCode).toBe(401);
  await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);expect((await app.inject({url:'/v1/flow-delegations/targets',headers:jwt})).statusCode).toBe(403);
 }finally{await app.close();await authPool.end();}
});
it('blocks a historical STOCK registry for a now positively known native origin at every profile/cutover/bind entry while drafting stays usable',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),old=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await old.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await old.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 const draft=await old.create(access,{name:'Before native origin inventory',graph,integrationIds:[qr.integration]});await old.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await old.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 const origin=(await db.database.pool.query('SELECT base_url FROM chatwoot_destinations WHERE organization_id=$1',[t.org])).rows[0].base_url;
 const current=t.serviceWith({client:()=>remote.client,identity:qr.health,knownNativeOrigins:new Set([origin])});
 await expect(current.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:1})).rejects.toMatchObject({code:'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED'});
 await expect(current.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED'});
 await expect(current.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED'});
 expect(await current.save(access,draft.id,{name:'Editing still works',graph,revision:1,expectedScopeRevision:1})).toMatchObject({draft:{revision:2}});
 expect(await current.publish(access,draft.id,{revision:2,expectedScopeRevision:1})).toMatchObject({version:2});
 const other=await fixture(origin);
 await expect(other.serviceWith({knownNativeOrigins:new Set([origin])}).configureExecutorProfile(other.principal,{integrationId:other.integration,expectedRevision:0})).rejects.toMatchObject({code:'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED'});
 expect((await db.database.pool.query('SELECT count(*)::int n FROM automation_bindings WHERE organization_id=$1',[t.org])).rows[0].n).toBe(0);expect(remote.posts()).toBe(0);
});
it('binds stock CENTRAL only after the existing durable bot cutover completes',async()=>{
 const t=await fixture(),remote=remoteClient(t),central=createCentralCutoverService({transact:db.transact,client:()=>remote.client,vault,callback:id=>`https://broker.example.test/v1/integrations/chatwoot/${id}/events`});
 const command={provider:'CENTRAL',name:'Synthetic central',inboxId:19,...await central.preview(t.org,t.actor,19),replaceExistingBot:false};
 let operation=await central.prepare(t.org,t.actor,command,randomUUID());
 for(let i=0;i<8&&operation.status!=='COMPLETE';i++)operation=await central.advance(t.org,t.actor,operation.id,operation.revision);
 expect(operation.status).toBe('COMPLETE');
 const ingress=createChatwootRuntimeIngress({transact:db.transact,secrets:vault,resolveIntegration:async()=>t.org});
 const raw=Buffer.from(JSON.stringify({event:'message_created',id:201,account:{id:7},inbox:{id:19},conversation:{id:101,inbox_id:19,contact_inbox:{contact_id:301}},private:false,message_type:'incoming',content:'Synthetic signed callback',sender:{id:301,type:'contact'}})),timestamp=String(Math.floor(Date.now()/1000));
 await ingress.receive({integrationId:operation.integrationId,raw,timestamp,signature:'sha256='+createHmac('sha256','synthetic-bot').update(timestamp+'.').update(raw).digest('hex')});
 const service=t.serviceWith({client:()=>remote.client});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:operation.integrationId,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[operation.integrationId],scopes:full}),access={organizationId:t.org,token:session.token};
 const draft=await service.create(access,{name:'Central scoped',graph,integrationIds:[operation.integrationId]});await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await service.prepareCutover(access,operation.integrationId,{expectedOwnerRevision:0});
 const before=remote.posts();
 const bound=await service.bind(access,draft.id,{integrationId:operation.integrationId,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0});
 expect(bound).toMatchObject({channelId:operation.channelId,ownerRevision:1});expect(remote.posts()).toBe(before);
 expect((await db.database.pool.query('SELECT owner_revision FROM central_transport_bindings WHERE integration_id=$1',[operation.integrationId])).rows[0].owner_revision).toBe(1);
});
function nativeAdapter(){
 let role='administrator',member=true,onFence:(()=>Promise<void>)|undefined;
 const fences=new Map<string,ReturnType<typeof proof>>();
 const proof=(request:any)=>({cutoverId:request.cutoverId,organizationId:request.organizationId,integrationId:request.integrationId,accountId:request.accountId,inboxId:request.inboxId,cutoverRevision:request.cutoverRevision,hostFenceRevision:request.cutoverRevision,expectedOwnerRevision:request.expectedOwnerRevision,admissionClosed:true,liveRuns:0,legacyJobs:0,uncertainEffects:0,guardedPaths:[...FLOW_GUARDED_PATHS],hostSourceSha:'a'.repeat(40),hostImageDigest:`sha256:${'b'.repeat(64)}`});
 async function currentLease(request:any){
  const row=(await db.database.pool.query('SELECT lease_token,lease_expires_at,lease_expires_at>clock_timestamp() AS lease_live FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2',[request.organizationId,request.cutoverId])).rows[0];
  if(!row||row.lease_token!==request.leaseToken||(row.lease_expires_at?.toISOString()??null)!==request.leaseExpiresAt||row.lease_token&&!row.lease_live)throw new Error('Synthetic host refused an outdated lease');
 }
  return {adapter:{introspect:async(request:any)=>{await syntheticAuthorityRoundtrip();return {...request,accountActive:true,member,featureEnabled:true,role};},fenceAndDrain:async(request:any)=>{await currentLease(request);await onFence?.();const value=proof(request);fences.set(request.cutoverId,value);return value;},observeFence:async(request:any)=>{await currentLease(request);const value=fences.get(request.cutoverId);if(!value||value.cutoverRevision!==request.cutoverRevision)throw new Error('Synthetic host has no accepted fence for this cutover');return value;}},setRole:(value:string)=>{role=value;},revoke:()=>{member=false;},onFence:(fn:()=>Promise<void>)=>{onFence=fn;}};
}
async function nativeBindFixture(remoteTimeoutMs=10000){
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),origin=`https://${t.org}.example.test`;
 const destination=(await db.database.pool.query('SELECT d.revision,a.account_id FROM chatwoot_destinations d JOIN chatwoot_accounts a ON a.organization_id=d.organization_id AND a.base_url=d.base_url WHERE d.organization_id=$1',[t.org])).rows[0];
 const registrationExpiresAt=new Date(Date.now()+3600000).toISOString();
 type OwnershipRequest=ReturnType<typeof NativeOwnershipRequestSchema.parse>;
 const observations:OwnershipRequest[]=[],fences:OwnershipRequest[]=[];
 let observeHook:((request:OwnershipRequest,index:number)=>Promise<void>)|undefined;
 let introspectionHook:(()=>Promise<void>)|undefined;
 const transactionScope=new AsyncLocalStorage<boolean>();
 const transact=<T>(org:string,work:OrganizationTransaction<T>)=>db.transact(org,tx=>transactionScope.run(true,()=>work(tx)));
 remote.onRead(async()=>{expect(transactionScope.getStore()).not.toBe(true);});
 const adapter=createNativeFlowAdapter({timeoutMs:10000,
  resolveRegistration:async()=>({organizationId:t.org,origin,accountId:Number(destination.account_id),destinationRevision:destination.revision,revision:1,callbackCredential:'c'.repeat(43),expiresAt:registrationExpiresAt}),
  fetch:async(url,init)=>{
    expect(transactionScope.getStore()).not.toBe(true);
   const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));
   if(path.endsWith('/introspect')){
     await syntheticAuthorityRoundtrip();
    await introspectionHook?.();
    return Response.json({...body,accountActive:true,member:true,featureEnabled:true,role:'administrator'});
   }
   const request=NativeOwnershipRequestSchema.parse(body),kind=path.endsWith('/ownership/observe')?'observe':'fence';
   expect(path).toBe('/api/v1/jrc_flow_native/ownership/'+kind);
   const locker=await db.database.pool.connect();
   try{
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2 FOR UPDATE NOWAIT',[t.org,request.cutoverId]);
    await locker.query('COMMIT');
   }finally{await locker.query('ROLLBACK');locker.release();}
   const lease=(await db.database.pool.query('SELECT lease_token,lease_expires_at,lease_expires_at>clock_timestamp() AS live FROM flow_executor_cutovers WHERE organization_id=$1 AND id=$2',[t.org,request.cutoverId])).rows[0];
   expect(lease).toMatchObject({lease_token:request.leaseToken,live:true});
   expect(lease.lease_expires_at.toISOString()).toBe(request.leaseExpiresAt);
   if(kind==='observe'){observations.push(request);await observeHook?.(request,observations.length);}else fences.push(request);
   // Synthetic host proof only; production schema, SQL and adapter remain real.
   return Response.json({organizationId:t.org,accountId:7,inboxId:19,integrationId:qr.integration,cutoverId:request.cutoverId,
    cutoverRevision:request.cutoverRevision,expectedOwnerRevision:0,hostFenceRevision:request.cutoverRevision,
    admissionClosed:true,liveRuns:0,legacyJobs:0,uncertainEffects:0,guardedPaths:[...FLOW_GUARDED_PATHS],hostSourceSha:'a'.repeat(40),hostImageDigest:'sha256:'+'b'.repeat(64)});
  }});
 const serviceOptions={transact,nativeAdapter:adapter,client:()=>remote.client,identity:qr.health,remoteTimeoutMs:10000};
 const service=t.serviceWith(serviceOptions);
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const credential=await service.issueNativeCredential(t.principal,{scopes:full,expiresInSeconds:3600});
 const session=await service.issueNativeSession({organizationId:t.org,token:credential.token},{externalActorId:'101',nonce:randomUUID(),integrationIds:[qr.integration],scopes:full});
 const access={organizationId:t.org,token:session.token},draft=await service.create(access,{name:'Strict native bind',graph,integrationIds:[qr.integration]});
 await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 // The short observation budget belongs to the bind under test; setup must
 // reach a committed DRAINED cutover before starting that timeout scenario.
 const bindingService=remoteTimeoutMs===10000?service:t.serviceWith({...serviceOptions,remoteTimeoutMs});
 return {t,qr,service:bindingService,credential,session,access,draft,cutover,observations,fences,
  bind:()=>bindingService.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0}),
  onObserve:(hook:NonNullable<typeof observeHook>)=>{observeHook=hook;},onIntrospection:(hook:NonNullable<typeof introspectionHook>)=>{introspectionHook=hook;}};
}
it('native bind nomination observes a live committed lease and consumes it with canonical ownership',async()=>{
 const h=await nativeBindFixture();
 expect((await db.database.pool.query('SELECT phase,lease_token,lease_expires_at FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toMatchObject({phase:'DRAINED',lease_token:null,lease_expires_at:null});
 await expect(h.bind()).resolves.toMatchObject({channelId:h.qr.channel,automationId:h.draft.id,ownerRevision:1});
 expect(h.fences).toHaveLength(1);expect(h.observations).toHaveLength(1);
 expect((await db.database.pool.query('SELECT phase,lease_token,lease_expires_at FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'ACTIVATED',lease_token:null,lease_expires_at:null});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',[h.t.org,h.qr.channel])).rows[0]).toEqual({n:1});
});
it('native bind nomination refuses a concurrent bind without releasing the active attempt',async()=>{
 const h=await nativeBindFixture();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
 h.onObserve(async(_request,index)=>{if(index===1){entered();await barrier;}});
 const first=h.bind();const firstOutcome=first.then(value=>({value}),error=>({error}));
 try{
  await Promise.race([started,firstOutcome.then(outcome=>{if('error' in outcome)throw outcome.error;throw new Error('Bind completed before host observation');})]);
  await expect(h.bind()).rejects.toMatchObject({code:'FLOW_CUTOVER_CHANGED'});
  expect(h.observations).toHaveLength(1);
  expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'DRAINED',lease_token:h.observations[0]!.leaseToken});
 }finally{release();}
 expect(await firstOutcome).toMatchObject({value:{ownerRevision:1}});
 expect(h.fences).toHaveLength(1);
});
it('native bind nomination expires on the SQL clock during host observation without activating',async()=>{
 const h=await nativeBindFixture();
 h.onObserve(async()=>{await db.database.pool.query("UPDATE flow_executor_cutovers SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h.cutover.id]);});
 await expect(h.bind()).rejects.toMatchObject({code:'FLOW_CUTOVER_CHANGED'});
 expect((await db.database.pool.query('SELECT phase,lease_token,admission_closed FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null,admission_closed:true});
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[h.qr.channel])).rows[0]).toEqual({bot_public_id:null});
});
it('native bind nomination revalidates revoked credentials after host observation',async()=>{
 const h=await nativeBindFixture();
 h.onObserve(async()=>{await db.database.pool.query('UPDATE flow_delegation_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[h.credential.id]);});
 await expect(h.bind()).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT phase,lease_token,admission_closed FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null,admission_closed:true});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',[h.t.org,h.qr.channel])).rows[0]).toEqual({n:0});
});
it('native bind nomination keeps UNKNOWN after timeout even when the host response arrives later',async()=>{
 const h=await nativeBindFixture(1000);let release!:()=>void,returned!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;}),late=new Promise<void>(resolve=>{returned=resolve;});
 h.onObserve(async()=>{await barrier;returned();});
 try{await expect(h.bind()).rejects.toMatchObject({code:'FLOW_CUTOVER_TIMEOUT'});}finally{release();}
 await late;await Promise.resolve();await Promise.resolve();
 expect((await db.database.pool.query('SELECT phase,lease_token,admission_closed FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null,admission_closed:true});
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[h.qr.channel])).rows[0]).toEqual({bot_public_id:null});
 expect(h.fences).toHaveLength(1);
});
it('native bind nomination does not let an expired attempt clear a newer live lease',async()=>{
 const h=await nativeBindFixture();let enteredA!:()=>void,enteredB!:()=>void,releaseA!:()=>void,releaseB!:()=>void;
 const seenA=new Promise<void>(resolve=>{enteredA=resolve;}),seenB=new Promise<void>(resolve=>{enteredB=resolve;});
 const barrierA=new Promise<void>(resolve=>{releaseA=resolve;}),barrierB=new Promise<void>(resolve=>{releaseB=resolve;});
 h.onObserve(async(_request,index)=>{if(index===1){enteredA();await barrierA;}else{enteredB();await barrierB;}});
 const first=h.bind().then(value=>({value}),error=>({error}));let second:Promise<unknown>|undefined;
 try{
  await Promise.race([seenA,first.then(outcome=>{if('error' in outcome)throw outcome.error;throw new Error('Bind completed before host observation');})]);
  await db.database.pool.query("UPDATE flow_executor_cutovers SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h.cutover.id]);
  second=h.bind().then(value=>({value}),error=>({error}));await Promise.race([seenB,second.then(outcome=>{if(outcome&&typeof outcome==='object'&&'error' in outcome)throw outcome.error;throw new Error('Replacement bind completed before observation');})]);
  releaseA();expect(await first).toMatchObject({error:{code:'FLOW_CUTOVER_CHANGED'}});
  expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'DRAINED',lease_token:h.observations[1]!.leaseToken});
  releaseB();expect(await second).toMatchObject({value:{ownerRevision:1}});
 }finally{releaseA();releaseB();await first;await second;}
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',[h.t.org,h.qr.channel])).rows[0]).toEqual({n:1});
});
it('native bind nomination releases only its own receipt when authority changes before final SQL',async()=>{
 const h=await nativeBindFixture();let afterObserve=0;
 h.onIntrospection(async()=>{
  if(h.observations.length===1&&++afterObserve===2)await db.database.pool.query('UPDATE flow_delegation_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[h.session.id]);
 });
 await expect(h.bind()).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect(afterObserve).toBe(2);
 expect((await db.database.pool.query('SELECT phase,lease_token,admission_closed FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null,admission_closed:true});
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[h.qr.channel])).rows[0]).toEqual({bot_public_id:null});
});
it('native bind nomination preserves an existing UNKNOWN fence without replaying it',async()=>{
 const h=await nativeBindFixture();await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE id=$1",[h.cutover.id]);
 await expect(h.bind()).rejects.toMatchObject({code:'FLOW_CUTOVER_CHANGED'});
 expect(h.observations).toHaveLength(0);expect(h.fences).toHaveLength(1);
 expect((await db.database.pool.query('SELECT phase,lease_token,admission_closed FROM flow_executor_cutovers WHERE id=$1',[h.cutover.id])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null,admission_closed:true});
});
it('uses a distinct native credential and live actor/inbox decision then consumes its fence in canonical bind',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const credential=await service.issueNativeCredential(t.principal,{scopes:full,expiresInSeconds:3600});
 const session=await service.issueNativeSession({organizationId:t.org,token:credential.token},{externalActorId:'101',nonce:randomUUID(),integrationIds:[qr.integration],scopes:full});
 const access={organizationId:t.org,token:session.token},draft=await service.create(access,{name:'Native scoped',graph,integrationIds:[qr.integration]});
 await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 const bound=await service.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0});
 expect(bound.ownerRevision).toBe(1);
 expect((await db.database.pool.query("SELECT actor_id,metadata FROM audit_logs WHERE organization_id=$1 AND event_type='FLOW_BOUND'",[t.org])).rows).toEqual([{actor_id:null,metadata:{actorKind:'JRC_NATIVE',externalActorId:'101',scopeRevision:1,ownerRevision:1}}]);
 expect((await db.database.pool.query('SELECT phase,host_fence_revision,guarded_paths FROM flow_executor_cutovers WHERE id=$1',[cutover.id])).rows[0]).toMatchObject({phase:'ACTIVATED',host_fence_revision:cutover.revision,guarded_paths:[...FLOW_GUARDED_PATHS]});
 native.revoke();await expect(service.get(access,draft.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
it('does not consume a cutover when current authority is revoked after remote IO',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 remote.onRead(async()=>{await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);});
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect((await db.database.pool.query('SELECT phase FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows[0].phase).toBe('ROLLED_BACK');
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[qr.channel])).rows[0].bot_public_id).toBeNull();
});
it('passes exact approved tenant and origin context to native introspection rather than numeric Account alone',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter();
 native.adapter.introspect=async(request:any,context:any)=>{
  expect(context).toEqual({organizationId:t.org,origin:`https://${t.org}.example.test`});
  return {...request,accountActive:true,member:true,featureEnabled:true,role:'administrator'};
 };
 const service=t.serviceWith({nativeAdapter:native.adapter});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const credential=await service.issueNativeCredential(t.principal,{scopes:full,expiresInSeconds:3600});
 await expect(service.issueNativeSession({organizationId:t.org,token:credential.token},{externalActorId:'101',nonce:randomUUID(),integrationIds:[qr.integration],scopes:full})).resolves.toMatchObject({token:expect.any(String)});
});
it('rejects a native-to-stock profile change that would bypass the persisted external fence',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),service=t.serviceWith({nativeAdapter:native.adapter});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 await expect(service.configureExecutorProfile(t.principal,{integrationId:qr.integration,hostKind:'STOCK',expectedRevision:1})).rejects.toMatchObject({name:'ZodError'});
 expect((await db.database.pool.query('SELECT host_kind,revision FROM flow_executor_profiles WHERE integration_id=$1',[qr.integration])).rows[0]).toEqual({host_kind:'JRC_NATIVE',revision:1});
});
it('bounds native fence IO and retains UNKNOWN without later activation when the adapter exceeds its deadline',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),fence=native.adapter.fenceAndDrain;
 let fenceCalls=0,signal:AbortSignal|undefined;
 native.adapter.fenceAndDrain=async(request:any,abortSignal?:AbortSignal)=>{fenceCalls++;signal=abortSignal;await new Promise(resolve=>setTimeout(resolve,1200));return fence(request);};
 const service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health,remoteTimeoutMs:1000});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_CUTOVER_TIMEOUT'});
 expect(fenceCalls).toBe(1);expect(signal?.aborted).toBe(true);
 await new Promise(resolve=>setTimeout(resolve,250));
 expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows[0]).toEqual({phase:'UNKNOWN',lease_token:null});
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[qr.channel])).rows[0].bot_public_id).toBeNull();
});
it('uses the current SQL clock to reject a lease that expires during native fence IO',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 native.onFence(async()=>{await db.database.pool.query("UPDATE flow_executor_cutovers SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE integration_id=$1",[qr.integration]);});
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_CUTOVER_CHANGED'});
 expect((await db.database.pool.query('SELECT phase FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows[0].phase).toBe('UNKNOWN');
});
it('refuses null native drain counts at the SQL boundary and does not blindly repeat unknown work',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await expect(db.database.pool.query('UPDATE flow_executor_cutovers SET live_runs=NULL WHERE id=$1',[cutover.id])).rejects.toMatchObject({code:'23514'});
 await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE id=$1",[cutover.id]);
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_CUTOVER_RECONCILIATION_REQUIRED'});
});
it('counts an unfinished external cutover as pending lifecycle work',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE id=$1",[cutover.id]);
 const pending=(await db.database.pool.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS n',[t.org,qr.channel])).rows[0].n;
 expect(pending).toBeGreaterThan(0);
});
it('preserves canonical owner CAS if another binding takes the QR channel after the proof',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},draft=await service.create(access,{name:'Scoped',graph,integrationIds:[qr.integration]});
 await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});const cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await createAutomationService({transact:db.transact}).bind(t.org,t.automation,{channelId:qr.channel,version:1,expectedOwnerRevision:0});
 await expect(service.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_OWNER_CHANGED'});
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[qr.channel])).rows[0].bot_public_id).toBe(t.automation);
 expect((await db.database.pool.query('SELECT phase FROM flow_executor_cutovers WHERE id=$1',[cutover.id])).rows[0].phase).toBe('DRAINED');
});
it('revokes a persisted session through current first-party authority and conceals foreign IDs',async()=>{
 const t=await fixture(),foreign=await fixture(),draft=await t.service.create(t.access,{name:'Scoped',graph,integrationIds:[t.integration]});
 await expect(t.service.revokeSession(t.principal,foreign.session.id)).rejects.toMatchObject({code:'FLOW_SESSION_NOT_FOUND'});
 expect(await t.service.revokeSession(t.principal,t.session.id)).toEqual({revoked:true});
 await expect(t.service.get(t.access,draft.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await expect(foreign.service.list(foreign.access)).resolves.toHaveProperty('data');
});
it('revokes all native sessions through their dedicated credential without touching QR or first-party sessions',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),service=t.serviceWith({nativeAdapter:native.adapter});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const credential=await service.issueNativeCredential(t.principal,{scopes:full,expiresInSeconds:3600});
 const session=await service.issueNativeSession({organizationId:t.org,token:credential.token},{externalActorId:'101',nonce:randomUUID(),integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 const draft=await service.create(access,{name:'Native scoped',graph,integrationIds:[qr.integration]});
 expect(await service.revokeNativeCredential(t.principal,credential.id)).toEqual({revoked:true});
 await expect(service.get(access,draft.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await expect(t.service.list(t.access)).resolves.toHaveProperty('data');
});

it.each([{pageSize:0},{pageSize:101},{pageSize:1.5},{pageSize:Infinity},{pageSize:1,organizationId:randomUUID()}])('strictly bounds delegated listing and rejects editor authority fields: %j',async input=>{
 const t=await fixture();
 await expect(t.service.list(t.access,input as any)).rejects.toMatchObject({name:'ZodError'});
});
it('audits canonical delegated create/save/publish with current authorship and no graph or token while idempotent replay adds no audit',async()=>{
 const t=await fixture(),key=randomUUID(),input={name:'Audited scoped draft',graph,integrationIds:[t.integration]};
 const draft=await t.service.create(t.access,input,key);await t.service.create(t.access,input,key);
 await t.service.save(t.access,draft.id,{name:'Audited edit',graph,revision:1,expectedScopeRevision:1});
 await t.service.publish(t.access,draft.id,{revision:2,expectedScopeRevision:1});
 const rows=(await db.database.pool.query("SELECT actor_id,event_type,resource_id,metadata FROM audit_logs WHERE organization_id=$1 AND event_type IN ('FLOW_DRAFT_CREATED','FLOW_DRAFT_SAVED','FLOW_PUBLISHED') ORDER BY created_at,id",[t.org])).rows;
 expect(rows.map(row=>row.event_type)).toEqual(['FLOW_DRAFT_CREATED','FLOW_DRAFT_SAVED','FLOW_PUBLISHED']);
 for(const row of rows){expect(row.actor_id).toBe(t.actor);expect(row.resource_id).toBe(draft.id);expect(row.metadata).toMatchObject({actorKind:'BROKER',scopeRevision:1});}
 expect(JSON.stringify(rows)).not.toContain(t.session.token);expect(JSON.stringify(rows)).not.toContain('nodes');expect(JSON.stringify(rows)).not.toContain('Synthetic inbox');
});
it('preserves a sanitized operational 403 after suspension during read-only cutover IO and retires the undispatched lease',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 remote.onRead(async()=>{await db.database.pool.query("UPDATE organizations SET status='DISABLED' WHERE id=$1",[t.org]);});
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'ORGANIZATION_NOT_ACTIVE',statusCode:403});
 expect((await db.database.pool.query('SELECT phase,lease_token,lease_expires_at FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows).toEqual([{phase:'ROLLED_BACK',lease_token:null,lease_expires_at:null}]);
});
it('observes and reconciles a persisted native UNKNOWN fence without replaying fenceAndDrain, then permits positive canonical binding',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 let fenceCalls=0;const originalFence=native.adapter.fenceAndDrain;native.adapter.fenceAndDrain=async request=>{fenceCalls++;return originalFence(request);};
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},draft=await service.create(access,{name:'Reconciled native draft',graph,integrationIds:[qr.integration]});
 await service.publish(access,draft.id,{revision:1,expectedScopeRevision:1});
 const cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN',proof_observed_at=clock_timestamp()-interval '60 seconds',proof_valid_until=clock_timestamp()-interval '31 seconds' WHERE id=$1",[cutover.id]);
 const status=await (service as any).getCutover(access,qr.integration);
 expect(status).toMatchObject({id:cutover.id,phase:'UNKNOWN',revision:cutover.revision,ready:false});expect(JSON.stringify(status)).not.toContain('leaseToken');expect(JSON.stringify(status)).not.toContain(session.token);
 const reconciled=await (service as any).reconcileCutover(access,qr.integration,{cutoverId:cutover.id,expectedCutoverRevision:cutover.revision,expectedOwnerRevision:0});
 expect(reconciled).toMatchObject({id:cutover.id,revision:cutover.revision,phase:'DRAINED'});expect(fenceCalls).toBe(1);
 expect(await service.bind(access,draft.id,{integrationId:qr.integration,cutoverId:cutover.id,version:1,expectedScopeRevision:1,expectedOwnerRevision:0})).toMatchObject({ownerRevision:1,channelId:qr.channel});
});
it('keeps UNKNOWN when reconciliation observes revoked authority after IO and never repeats a native mutation',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 let fenceCalls=0;const originalFence=native.adapter.fenceAndDrain;native.adapter.fenceAndDrain=async request=>{fenceCalls++;return originalFence(request);};
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},cutover=await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE id=$1",[cutover.id]);
 const originalObserve=native.adapter.observeFence;
 native.adapter.observeFence=async(request:any)=>{await db.database.pool.query("UPDATE memberships SET role='VIEWER' WHERE organization_id=$1 AND user_id=$2",[t.org,t.actor]);return originalObserve(request);};
 await expect((service as any).reconcileCutover(access,qr.integration,{cutoverId:cutover.id,expectedCutoverRevision:cutover.revision,expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect(fenceCalls).toBe(1);expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE id=$1',[cutover.id])).rows).toEqual([{phase:'UNKNOWN',lease_token:null}]);
});
it('bounds the complete sequential observation and fence journey rather than restarting a full timeout per stage',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health,remoteTimeoutMs:500});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 remote.onRead(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});
 const originalFence=native.adapter.fenceAndDrain;native.adapter.fenceAndDrain=async request=>{await new Promise(resolve=>setTimeout(resolve,300));return originalFence(request);};
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_CUTOVER_TIMEOUT'});
 await new Promise(resolve=>setTimeout(resolve,350));
 expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows).toEqual([{phase:'UNKNOWN',lease_token:null}]);
});
it('retires a rejected read-only preflight without fabricating a native fence or leaving pending lifecycle forever',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 let fenceCalls=0;const originalFence=native.adapter.fenceAndDrain;native.adapter.fenceAndDrain=async request=>{fenceCalls++;return originalFence(request);};
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 remote.setBot({id:99,name:'Synthetic competing bot',outgoing_url:'https://synthetic-competing.example.test/callback'});
 await expect(service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).rejects.toMatchObject({code:'FLOW_COMPETING_EXECUTOR'});
 expect(fenceCalls).toBe(0);
 expect((await db.database.pool.query('SELECT phase FROM flow_executor_cutovers WHERE integration_id=$1',[qr.integration])).rows).toEqual([{phase:'ROLLED_BACK'}]);
 expect((await db.database.pool.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS n',[t.org,qr.channel])).rows).toEqual([{n:0}]);
 remote.setBot(null);expect(await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0})).toMatchObject({phase:'DRAINED'});expect(fenceCalls).toBe(1);
});
it('closes a recovered pre-dispatch crash from the durable marker without claiming an unknown host epoch is drained',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 const cutover=randomUUID();
 await db.database.pool.query(`INSERT INTO flow_executor_cutovers(organization_id,id,integration_id,channel_id,host_kind,profile_revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,expected_owner_revision,phase,lease_token,lease_expires_at)
  SELECT organization_id,$3,integration_id,$4,host_kind,revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,0,'REQUESTED',$5,clock_timestamp()-interval '1 second' FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=$2`,[t.org,qr.integration,cutover,qr.channel,randomUUID()]);
 expect(await (service as any).reconcileCutover(access,qr.integration,{cutoverId:cutover,expectedCutoverRevision:1,expectedOwnerRevision:0})).toMatchObject({id:cutover,phase:'ROLLED_BACK'});
 expect((await db.database.pool.query('SELECT lifecycle_pending_count($1,$2,NULL)::int AS n',[t.org,qr.channel])).rows).toEqual([{n:0}]);
 expect((await db.database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE id=$1',[qr.channel])).rows).toEqual([{bot_public_id:null}]);
});
it('rejects the current lease when settlement waits during a row lock until after its SQL deadline',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter(),remote=remoteClient(t),service=t.serviceWith({nativeAdapter:native.adapter,client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token},locker=await db.database.pool.connect();
 let cutoverId:string|undefined;
 native.onFence(async()=>{
  cutoverId=(await db.database.pool.query("UPDATE flow_executor_cutovers SET lease_expires_at=clock_timestamp()+interval '600 milliseconds' WHERE integration_id=$1 RETURNING id",[qr.integration])).rows[0].id;
  await locker.query('BEGIN');await locker.query('SELECT id FROM flow_executor_cutovers WHERE id=$1 FOR UPDATE',[cutoverId]);
 });
 const pending=service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});const outcome=pending.then(value=>({value}),error=>({error}));
 try{await rowLockBarrier('flow_executor_cutovers');await expiresOnSqlClock('flow_executor_cutovers',cutoverId!,'lease_expires_at');await locker.query('COMMIT');
  expect(await outcome).toMatchObject({error:{code:'FLOW_CUTOVER_CHANGED'}});
  expect((await db.database.pool.query('SELECT phase,lease_token FROM flow_executor_cutovers WHERE id=$1',[cutoverId])).rows).toEqual([{phase:'UNKNOWN',lease_token:null}]);
 }finally{await locker.query('ROLLBACK');locker.release();}
});
it('denies status metadata when authority outlives a session lock and its persisted expiry',async()=>{
 const t=await fixture(),qr=await qrInbox(t),remote=remoteClient(t),service=t.serviceWith({client:()=>remote.client,identity:qr.health});
 await approveOriginFixture(db.database,t.org,'STOCK');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const session=await service.issueBrokerSession(t.principal,{integrationIds:[qr.integration],scopes:full}),access={organizationId:t.org,token:session.token};
 await service.prepareCutover(access,qr.integration,{expectedOwnerRevision:0});
 await db.database.pool.query("UPDATE flow_delegation_sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",[session.id]);
 const locker=await db.database.pool.connect();await locker.query('BEGIN');await locker.query('SELECT id FROM flow_delegation_sessions WHERE id=$1 FOR UPDATE',[session.id]);
 const outcome=service.getCutover(access,qr.integration).then(value=>({value}),error=>({error}));
 try{await rowLockBarrier('flow_delegation_sessions');await expiresOnSqlClock('flow_delegation_sessions',session.id,'expires_at');await locker.query('COMMIT');
  expect(await outcome).toMatchObject({error:{code:'FLOW_ACCESS_DENIED'}});
 }finally{await locker.query('ROLLBACK');locker.release();}
});
it('performs no native introspection when initial authority outlives a credential lock and its expiry',async()=>{
 const t=await fixture(),qr=await qrInbox(t),native=nativeAdapter();let introspections=0;
 const original=native.adapter.introspect;native.adapter.introspect=async request=>{introspections++;return original(request);};
 const service=t.serviceWith({nativeAdapter:native.adapter});await approveOriginFixture(db.database,t.org,'JRC_NATIVE');await service.configureExecutorProfile(t.principal,{integrationId:qr.integration,expectedRevision:0});
 const credential=await service.issueNativeCredential(t.principal,{scopes:full,expiresInSeconds:3600});
 await db.database.pool.query("UPDATE flow_delegation_credentials SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",[credential.id]);
 const locker=await db.database.pool.connect();await locker.query('BEGIN');await locker.query('SELECT id FROM flow_delegation_credentials WHERE id=$1 FOR UPDATE',[credential.id]);
 const outcome=service.issueNativeSession({organizationId:t.org,token:credential.token},{externalActorId:'101',nonce:randomUUID(),integrationIds:[qr.integration],scopes:full}).then(value=>({value}),error=>({error}));
 try{await rowLockBarrier('flow_delegation_credentials');await expiresOnSqlClock('flow_delegation_credentials',credential.id,'expires_at');await locker.query('COMMIT');
  expect(await outcome).toMatchObject({error:{code:'FLOW_ACCESS_DENIED'}});expect(introspections).toBe(0);
 }finally{await locker.query('ROLLBACK');locker.release();}
});
