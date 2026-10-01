import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { runMigrations } from '../../src/db/migrate.js';
import { PlatformService } from '../../src/modules/platform/service.js';
import { digest } from '../../src/modules/platform/crypto.js';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { readOperationalLimits } from '../../src/modules/tenancy/operational-limits.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
import { welcomeFlow } from '@jrc/contracts';
import { createAutomationImporter } from '../../src/modules/automation-integrations/importer.js';
import { createLifecycleService, withLifecyclePlatformTransaction, withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';

let db:IsolatedPostgresDatabase, platform:Pool, app:Pool, service:PlatformService;
const token=randomBytes(32).toString('base64url'), supportToken=randomBytes(32).toString('base64url');
const limits={maxInstances:2,maxUsers:3,messagesPerDay:5,maxPendingMessages:4};
beforeAll(async()=>{
 const url=requireTestDatabaseAdminUrl(); db=await createIsolatedPostgresDatabase(url);
 await withGlobalRoleLock(url,()=>runMigrations(db.connectionString));
 platform=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_platform')});
 app=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
 service=new PlatformService(platform,Buffer.alloc(32,7));
 for(const [credential,role] of [[token,'SUPER_ADMIN'],[supportToken,'SUPPORT']]){
  const user=(await db.pool.query("INSERT INTO platform_users(email,password_hash,role,mfa_seed) VALUES($1,'fixture',$2,'fixture') RETURNING id",[`${randomUUID()}@example.test`,role])).rows[0];
  await db.pool.query("INSERT INTO platform_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-csrf',now()+interval '1 hour')",[digest(credential!),user.id]);
 }
});
afterAll(async()=>{await app?.end();await platform?.end();await db?.dispose();});
async function waitForAssignmentLock(blockerPid:number){
 for(let attempt=0;attempt<200;attempt++){
  if((await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_platform' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id FROM organizations%FOR UPDATE'",[blockerPid])).rowCount)return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }throw new Error('Assignment did not queue behind the fixture organization lock');
}
async function company(){
 const id=randomUUID(), user=randomUUID(); const c=await db.pool.connect();
 try{await c.query('BEGIN');await c.query("INSERT INTO organizations(id,name,slug,plan) VALUES($1::uuid,'Fixture',$1::text,'Custom legacy')",[id]);
 await c.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",[user,`${user}@example.test`]);
 await c.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[id,user]);await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();} return id;
}
it('creates immutable versions, assigns explicit overrides with CAS, and preserves old versions',async()=>{
 const org=await company();
 const plan=await service.createCommercialPlan(token,'Create synthetic plan',{name:'Synthetic',limits,flowsEnabled:true});
 const before=await service.getCommercialPlan(token,'Read current grant',org);
 const assigned=await service.assignCommercialPlan(token,'Contract exception',org,{planVersionId:plan.id,overrides:{maxUsers:7},expectedRevision:before.revision});
 expect(assigned).toMatchObject({revision:before.revision+1,limits:{...limits,maxUsers:7},flowsEnabled:true,overrides:{maxUsers:7}});
 await service.execute(token,'Suspend without losing contract','update',org,{status:'SUSPENDED'});
 expect(await service.getCommercialPlan(token,'Status preserves assignment',org)).toMatchObject({revision:assigned.revision,planVersionId:plan.id,overrides:{maxUsers:7}});
 await service.execute(token,'Restore synthetic company','update',org,{status:'ACTIVE'});
 expect((await db.pool.query("SELECT action,reason FROM platform_audit_logs WHERE organization_id=$1 AND action LIKE 'commercial-plan-assign:%'",[org])).rows).toEqual([{action:`commercial-plan-assign:${plan.id}:r${assigned.revision}:{"maxUsers":7}`,reason:'Contract exception'}]);
 await expect(service.assignCommercialPlan(token,'Reject stale grant',org,{planVersionId:plan.id,overrides:{},expectedRevision:before.revision})).rejects.toMatchObject({code:'COMMERCIAL_REVISION_CHANGED'});
 const next=await service.createCommercialPlanVersion(token,'Publish next capacity',plan.planId,{expectedRevision:1,limits:{...limits,maxUsers:8},flowsEnabled:false});
 expect(next.version).toBe(2);
 expect((await service.getCommercialPlan(token,'Check pinned contract',org)).planVersionId).toBe(plan.id);
 expect((await service.listCommercialPlans(token,'Read catalog')).data).toEqual(expect.arrayContaining([expect.objectContaining({id:plan.id}),expect.objectContaining({id:next.id})]));
 const writes=await Promise.allSettled([3,4].map(maxUsers=>service.createCommercialPlanVersion(token,'Concurrent version publication',plan.planId,{expectedRevision:2,limits:{...limits,maxUsers},flowsEnabled:true})));
 expect(writes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
 expect(writes.filter(row=>row.status==='rejected')).toHaveLength(1);
 await service.execute(token,'Legacy capacity exception','update',org,{limits:{...limits,maxUsers:9},flowsEnabled:false});
 expect(await service.getCommercialPlan(token,'Legacy write keeps grants coherent',org)).toMatchObject({revision:assigned.revision+1,limits:{...limits,maxUsers:9},flowsEnabled:false,overrides:{}});
 await expect(service.assignCommercialPlan(token,'Old modal must conflict',org,{planVersionId:next.id,overrides:{},expectedRevision:assigned.revision})).rejects.toMatchObject({code:'COMMERCIAL_REVISION_CHANGED'});
 await expect(platform.query('UPDATE commercial_plan_versions SET flows_enabled=false WHERE id=$1',[plan.id])).rejects.toThrow();
});
it('rejects support, missing reasons and revoked roles; HTTP requires CSRF and tenant roles cannot read catalog',async()=>{
 await expect(service.createCommercialPlan(supportToken,'Forbidden support',{name:'No',limits,flowsEnabled:false})).rejects.toMatchObject({statusCode:403});
 await expect(service.createCommercialPlan(token,'',{name:'No',limits,flowsEnabled:false})).rejects.toMatchObject({statusCode:400});
 const server=Fastify(); await registerPlatformRoutes(server,{service,origin:'https://broker.example.test',secureCookies:false});
 const noCsrf=await server.inject({method:'POST',url:'/v1/platform/commercial-plans',headers:{cookie:`platform_session=${token}`,'x-platform-reason':'Create catalog'},payload:{name:'No',limits,flowsEnabled:false}});
 expect(noCsrf.statusCode).toBe(403); await server.close();
 await expect(app.query('SELECT * FROM commercial_plan_versions')).rejects.toThrow();
 await db.pool.query("UPDATE platform_users SET role='SUPPORT' WHERE id=(SELECT user_id FROM platform_sessions WHERE token_hash=$1)",[digest(token)]);
 await expect(service.createCommercialPlan(token,'Recheck current role',{name:'No',limits,flowsEnabled:false})).rejects.toMatchObject({statusCode:403});
 await db.pool.query("UPDATE platform_users SET role='SUPER_ADMIN' WHERE id=(SELECT user_id FROM platform_sessions WHERE token_hash=$1)",[digest(token)]);
});
it('serves the HTTP catalog and validates assignment CAS, strict overrides and staff permissions',async()=>{
 const server=Fastify();await registerPlatformRoutes(server,{service,origin:'https://broker.example.test',secureCookies:false});
 const headers={cookie:`platform_session=${token}`,'x-csrf-token':'synthetic-csrf','x-platform-reason':'Synthetic contract test',origin:'https://broker.example.test'};
 try{
  const created=await server.inject({method:'POST',url:'/v1/platform/commercial-plans',headers,payload:{name:'HTTP fixture',limits,flowsEnabled:true}});
  expect(created.statusCode).toBe(201);const plan=created.json();
  const catalog=await server.inject({method:'GET',url:'/v1/platform/commercial-plans',headers});expect(catalog.statusCode).toBe(200);expect(catalog.json().data).toContainEqual(plan);
  const org=await company(),url=`/v1/platform/organizations/${org}/commercial-plan`;
  const before=(await server.inject({method:'GET',url,headers})).json();
  const payload={planVersionId:plan.id,expectedRevision:before.revision,overrides:{flowsEnabled:false,maxInstances:3}};
  expect((await server.inject({method:'PUT',url,headers:{...headers,cookie:`platform_session=${supportToken}`},payload})).statusCode).toBe(403);
  expect((await server.inject({method:'PUT',url,headers,payload:{...payload,overrides:{role:'SUPER_ADMIN'}}})).statusCode).toBe(400);
  const assigned=await server.inject({method:'PUT',url,headers,payload});expect(assigned.statusCode).toBe(200);expect(assigned.json()).toMatchObject({revision:before.revision+1,flowsEnabled:false,limits:{maxInstances:3}});
  expect((await server.inject({method:'PUT',url,headers,payload})).statusCode).toBe(409);
 }finally{await server.close();}
});
it('does not allow a private legacy snapshot to be assigned to another organization',async()=>{
 const org=await company(),other=await company();await service.execute(token,'Capture private legacy grant','update',org,{limits});
 const own=await service.getCommercialPlan(token,'Read private legacy snapshot',org),before=await service.getCommercialPlan(token,'Read other revision',other);
 await expect(service.assignCommercialPlan(token,'Reject cross company snapshot',other,{planVersionId:own.planVersionId,overrides:{},expectedRevision:before.revision})).rejects.toMatchObject({code:'COMMERCIAL_PLAN_NOT_FOUND'});
 await expect(platform.query('INSERT INTO organization_commercial_plans(organization_id,plan_version_id) VALUES($1,$2)',[other,own.planVersionId])).rejects.toMatchObject({constraint:'commercial_plan_scope'});
});
it('purges private legacy snapshots with their company and preserves global catalog and other company grants',async()=>{
 const org=await company(),other=await company();await service.execute(token,'Capture deleted private grant','update',org,{limits});
 await service.execute(token,'Capture preserved private grant','update',other,{limits:{...limits,maxUsers:7}});
 const own=await service.getCommercialPlan(token,'Read purge version',org),keep=await service.getCommercialPlan(token,'Read preserved version',other);
 const plan=await service.createCommercialPlan(token,'Global catalog preserved',{name:'Public capacity',limits,flowsEnabled:false});
 const privatePlan=(await db.pool.query('SELECT plan_id FROM commercial_plan_versions WHERE id=$1',[own.planVersionId])).rows[0].plan_id;
 const worker=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_lifecycle')});
 const lifecycle=createLifecycleService({transact:work=>withLifecyclePlatformTransaction(platform,work),deprovision:async()=>{throw new Error('Unexpected external cleanup');}});
 const runner=createLifecycleService({transact:work=>withLifecycleWorkerTransaction(worker,work),deprovision:async()=>{throw new Error('Unexpected external cleanup');}});
 try{
  const actor=(await service.session(token)).user.id;
  const operation=await lifecycle.requestOrganization(org,'Fixture','Delete synthetic company',actor);await runner.processOne();
  expect(await lifecycle.status(org,org,operation.operationId)).toMatchObject({status:'COMPLETED'});
  expect((await db.pool.query('SELECT id FROM commercial_plan_versions WHERE id=$1',[own.planVersionId])).rows).toEqual([]);
  expect((await db.pool.query('SELECT id FROM commercial_plans WHERE id=$1',[privatePlan])).rows).toEqual([]);
  expect((await db.pool.query('SELECT id FROM commercial_plan_versions WHERE id=ANY($1::uuid[])',[[keep.planVersionId,plan.id]])).rows).toHaveLength(2);
  expect(await service.getCommercialPlan(token,'Check remaining tenant',other)).toMatchObject({planVersionId:keep.planVersionId,limits:{maxUsers:7}});
 }finally{await worker.end();}
});
it('orders daily quota downgrade against send admission and isolates grouped company quotas',async()=>{
 const org=await company(),other=await company(),repo=createPostgresMessagingRepository();
 const group=await service.createGroup(token,'Synthetic grouped quota',{name:'Independent quotas'});
 await service.assignGroupOrganizations(token,'Group independently metered tenants',group.id,{revision:1,organizationIds:[org,other]});
 const setup=async(id:string)=>withOrganizationTransaction(app,id,async tx=>{
  const provider=(await tx.query<{id:string}>("INSERT INTO provider_accounts(organization_id,provider,name,credential_reference) VALUES($1,'META','fixture','fixture') RETURNING id",[id])).rows[0]!.id;
  const channel=await repo.createChannel(tx,{id:randomUUID(),organizationId:id,providerAccountId:provider,phoneNumberId:id,wabaId:id,credentialReference:'fixture',botPublicId:null,botOriginReference:null});
  const contact=await repo.upsertContact(tx,{id:randomUUID(),organizationId:id,externalId:'fixture',displayName:null,consentStatus:'OPTED_IN',consentUpdatedAt:new Date()});
  const conversation=await repo.getOrCreateConversation(tx,{id:randomUUID(),organizationId:id,channelId:channel.id,contactId:contact.id});return {org:id,channel:channel.id,conversation:conversation.id};
 });
 const a=await setup(org),b=await setup(other);
 const enqueue=(t:typeof a)=>withOrganizationTransaction(app,t.org,tx=>repo.enqueueOutgoing(tx,{id:randomUUID(),organizationId:t.org,channelId:t.channel,conversationId:t.conversation,source:'OPERATOR',content:{type:'TEMPLATE',name:'fixture',language:'pt_BR',variables:[]},idempotencyKey:randomUUID(),bodyHash:'fixture',policy:{requireOptIn:true}}));
 await enqueue(a);
 const plan=await service.createCommercialPlan(token,'Daily quota downgrade',{name:'Daily one',limits:{...limits,messagesPerDay:1},flowsEnabled:false});
 const before=await service.getCommercialPlan(token,'Read quota revision',org);
 const blocker=await db.pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
 const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const assignment=service.assignCommercialPlan(token,'Downgrade daily allowance',org,{planVersionId:plan.id,overrides:{},expectedRevision:before.revision});
 await waitForAssignmentLock(blockerPid);
 const sending=enqueue(a).then(()=>null,error=>error);
 await blocker.query('COMMIT');blocker.release();await assignment;
 expect(await sending).toMatchObject({constraint:'tenant_daily_limit'});
 await expect(enqueue(b)).resolves.toBeDefined();
 expect((await db.pool.query("SELECT state FROM messaging_messages WHERE organization_id=$1",[org])).rows).toEqual([{state:'ACCEPTED'}]);
 expect(await service.getCommercialPlan(token,'Check usage remains truthful',org)).toMatchObject({usage:{messagesAcceptedToday:1,pendingMessages:1}});
 expect(await withOrganizationTransaction(app,org,tx=>readOperationalLimits(tx,org))).toMatchObject({connections:1,users:1,pendingMessages:1,messagesAcceptedToday:1,storageBytes:null,aiTokens:null});
});
it('orders a module downgrade after a draft that already passed admission, and blocks the next create',async()=>{
 const org=await company();await service.execute(token,'Enable draft admission','update',org,{flowsEnabled:true});
 const plan=await service.createCommercialPlan(token,'Module downgrade fixture',{name:'No automations',limits,flowsEnabled:false});
 const before=await service.getCommercialPlan(token,'Read module revision',org);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),repository=createPostgresAutomationRepository();
 const automation=createAutomationService({transact:(id,work)=>withOrganizationTransaction(app,id,work),repository:{...repository,insertDefinition:async(...args)=>{entered.resolve();await release.promise;return repository.insertDefinition(...args);}}});
 const draft=automation.create(org,{name:'Admitted before downgrade',graph:welcomeFlow()});
 await entered.promise;let settled=false;
 const assignment=service.assignCommercialPlan(token,'Disable module concurrently',org,{planVersionId:plan.id,overrides:{},expectedRevision:before.revision}).finally(()=>{settled=true;});
 try{
  let locked=false;
  for(let attempt=0;attempt<100&&!settled;attempt++){
   locked=!!(await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_platform' AND wait_event_type='Lock'")).rowCount;
   if(locked)break;await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(locked,'downgrade must wait for the previously admitted draft').toBe(true);
 }finally{release.resolve();await draft;await assignment;}
 await expect(automation.create(org,{name:'New draft refused',graph:welcomeFlow()})).rejects.toMatchObject({code:'AUTOMATION_MODULE_DISABLED'});
 const created=await draft;
 const importer=createAutomationImporter({transact:(id,work)=>withOrganizationTransaction(app,id,work),keyring:JSON.stringify({'1':Buffer.alloc(32,4).toString('base64')})});
 await expect(automation.bind(org,created.id,{channelId:randomUUID(),expectedOwnerRevision:0})).rejects.toMatchObject({code:'AUTOMATION_MODULE_DISABLED'});
 await expect(importer.import(org,{source:'JRC',content:'{}'},randomUUID())).rejects.toMatchObject({code:'AUTOMATION_MODULE_DISABLED'});
 await service.execute(token,'Suspension prevails over entitlement','update',org,{status:'SUSPENDED',flowsEnabled:true});
 await expect(automation.create(org,{name:'Suspended draft refused',graph:welcomeFlow()})).rejects.toMatchObject({code:'ORGANIZATION_NOT_ACTIVE'});
 await expect(automation.bind(org,created.id,{channelId:randomUUID(),expectedOwnerRevision:0})).rejects.toMatchObject({code:'ORGANIZATION_NOT_ACTIVE'});
 await expect(importer.import(org,{source:'JRC',content:'{}'},randomUUID())).rejects.toMatchObject({code:'ORGANIZATION_NOT_ACTIVE'});
 expect((await db.pool.query('SELECT count(*)::int n FROM automation_import_artifacts WHERE organization_id=$1',[org])).rows[0].n).toBe(0);
 expect((await db.pool.query('SELECT count(*)::int n FROM automation_definitions WHERE organization_id=$1',[org])).rows[0].n).toBe(1);
});
it('serializes a downgrade before a concurrent admission and never purges existing resources',async()=>{
 const org=await company(); const provider=(await db.pool.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id",[org])).rows[0].id;
 const insert=()=>withOrganizationTransaction(app,org,tx=>tx.query('INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key) VALUES($1,$2,$3,$3)',[org,provider,randomUUID()]));
 await insert();await insert();
 const plan=await service.createCommercialPlan(token,'Downgrade fixture',{name:'Small',limits:{...limits,maxInstances:1},flowsEnabled:false});
 const before=await service.getCommercialPlan(token,'Read current revision',org);
 const blocker=await db.pool.connect(); await blocker.query('BEGIN');await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
 const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const assignment=service.assignCommercialPlan(token,'Downgrade without deletion',org,{planVersionId:plan.id,overrides:{},expectedRevision:before.revision});
 await waitForAssignmentLock(blockerPid);
 const admission=insert(); const admissionResult=admission.then(()=>null,error=>error);
 await blocker.query('COMMIT');blocker.release(); await assignment;
 expect(await admissionResult).toMatchObject({constraint:'tenant_instance_limit'});
 expect((await db.pool.query('SELECT count(*)::int n FROM instances WHERE organization_id=$1',[org])).rows[0].n).toBe(2);
 const usage=await service.getCommercialPlan(token,'Check measured capacity',org);
 expect(usage.usage).toMatchObject({connections:2,users:1,storageBytes:null,aiTokens:null});
});
