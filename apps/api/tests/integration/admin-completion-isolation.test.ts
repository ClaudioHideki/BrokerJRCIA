import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { welcomeFlow } from '@jrc/contracts';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createPostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { createApiKeyService } from '../../src/modules/api-keys/service.js';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
import type { LifecycleService } from '../../src/modules/lifecycle/service.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import { createAutomationService, createExecutionService } from '../../src/modules/automations/service.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { PlatformService } from '../../src/modules/platform/service.js';
import { digest } from '../../src/modules/platform/crypto.js';
import { createSupportService, withSupportPlatformTransaction } from '../../src/modules/support/service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

const secret='admin-completion-isolation-secret-with-at-least-32-bytes';
let db:IsolatedPostgresDatabase,appPool:Pool,staffPool:Pool,authPool:Pool;
let organizations:string[],sharedUser:string,owners:string[],staffId:string,adminToken:string,staffToken:string;
let platform:PlatformService,support:ReturnType<typeof createSupportService>;

beforeAll(async()=>{
  const adminUrl=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(adminUrl);
  await withGlobalRoleLock(adminUrl,()=>runMigrations(db.connectionString));
  const group=(await db.pool.query("insert into economic_groups(name) values('Shared synthetic group') returning id")).rows[0].id as string;
  organizations=[];owners=[];
  for(let i=1;i<=3;i++){
    const {org,owner}=await runInAdminTransaction(db.pool,async tx=>{
      const org=(await tx.query('insert into organizations(name,slug) values($1,$2) returning id',[`Matrix ${i}`,`matrix-${i}`])).rows[0].id as string;
      const owner=(await tx.query('insert into users(email,password_hash) values($1,$2) returning id',[`matrix-owner-${i}@example.test`,'synthetic-unused-hash'])).rows[0].id as string;
      await tx.query("insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')",[org,owner]);
      await tx.query('insert into economic_group_organizations(organization_id,group_id) values($1,$2)',[org,group]);
      return {org,owner};
    });
    organizations.push(org);owners.push(owner);
  }
  sharedUser=(await db.pool.query("insert into users(email,password_hash) values('matrix-shared@example.test','synthetic-unused-hash') returning id")).rows[0].id as string;
  await db.pool.query("insert into memberships(organization_id,user_id,role) values($1,$3,'OPERATOR'),($2,$3,'VIEWER')",[organizations[0],organizations[1],sharedUser]);
  staffId=randomUUID();const adminId=randomUUID();
  await db.pool.query("insert into platform_users(id,email,password_hash,role,mfa_seed) values($1,'matrix-staff@example.test','synthetic','SUPPORT','synthetic'),($2,'matrix-admin@example.test','synthetic','SUPER_ADMIN','synthetic')",[staffId,adminId]);
  staffToken='a'.repeat(43);adminToken='b'.repeat(43);
  await db.pool.query("insert into platform_sessions(token_hash,user_id,csrf_token,expires_at) values($1,$2,'synthetic-csrf',now()+interval '1 hour'),($3,$4,'synthetic-csrf',now()+interval '1 hour')",[digest(staffToken),staffId,digest(adminToken),adminId]);
  appPool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
  authPool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_auth')});
  staffPool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_platform')});
  platform=new PlatformService(staffPool,Buffer.alloc(32,5));
  support=createSupportService({transact:(org,work)=>withOrganizationTransaction(appPool,org,work),staffTransact:work=>withSupportPlatformTransaction(staffPool,work)});
},60_000);
afterAll(async()=>{await appPool?.end();await authPool?.end();await staffPool?.end();await db?.dispose();});

it('keeps three grouped companies separate across support, current roles, platform powers and tenant credentials',async()=>{
  const role=createMessagingMembershipResolver(authPool);
  const transact=<T,>(org:string,work:OrganizationTransaction<T>)=>withOrganizationTransaction(appPool,org,work);
  const apiKeys=createApiKeyService({repository:createPostgresApiKeyRepository(),hmacSecret:secret,
    runInOrganizationTransaction:(org,work)=>withOrganizationTransaction(appPool,org,work),writeAudit:writeTenantAudit});
  const credentials={jwtSecret:secret,authenticateApiKey:apiKeys.authenticateApiKey};
  const automationOptions={transact},tenant=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),
    support:{...credentials,resolveCurrentRole:role,service:support},
    flows:{...credentials,resolveCurrentRole:role,service:createFlowService({transact})},
    automations:{...credentials,resolveCurrentRole:role,service:createAutomationService(automationOptions),executions:createExecutionService(automationOptions)},
    tenantOperations:{...credentials,transact}});
  // Match the app-level JWT revalidation: suspended tenants retain read access where route policy allows it.
  tenant.decorate('resolveTenantRole',async(userId:string,orgId:string)=>{
    const result=await authPool.query<{role:'OWNER'|'ADMIN'|'OPERATOR'|'VIEWER'}>(`SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id
      JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2
      AND m.status='ACTIVE' AND u.status='ACTIVE' AND o.status<>'DISABLED'`,[userId,orgId]);
    return result.rows[0]?.role??null;
  });
  const lifecycle={previewOrganization:vi.fn(),requestOrganization:vi.fn(),previewChannel:vi.fn(),requestChannel:vi.fn()} as unknown as LifecycleService;
  const admin=Fastify();await registerPlatformRoutes(admin,{service:platform,support,lifecycle,origin:'https://console.example.test',secureCookies:false});
  const token=async(org:string)=>`Bearer ${await issueAccessToken({userId:sharedUser,organizationId:org,role:'OWNER'},secret)}`;
  const ticket=await support.create({kind:'TENANT',organizationId:organizations[0]!,actorId:owners[0]!,canWrite:true},{title:'Matrix support ticket',message:'Synthetic company one body.',requestId:randomUUID()});
  try{
    const one=await token(organizations[0]!),two=await token(organizations[1]!),three=await token(organizations[2]!);
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:one}})).json().data).toEqual(expect.arrayContaining([expect.objectContaining({id:ticket.ticket.id})]));
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:two}})).json().data).toHaveLength(0);
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:three}})).statusCode).toBe(401);
    expect((await tenant.inject({method:'POST',url:`/v1/support/tickets/${ticket.ticket.id}/replies`,headers:{authorization:two},payload:{message:'Forbidden viewer reply',revision:1,requestId:randomUUID()}})).statusCode).toBe(403);
    const headers={cookie:`platform_session=${staffToken}`,origin:'https://console.example.test','x-csrf-token':'synthetic-csrf'};
    for(const url of [`/v1/platform/organizations/${organizations[0]}/deletion-preview`,
      `/v1/platform/organizations/${organizations[0]}/channels/${randomUUID()}/deletion-preview`])
      expect((await admin.inject({url,headers})).statusCode).toBe(403);
    for(const url of [`/v1/platform/organizations/${organizations[0]}/deletion`,
      `/v1/platform/organizations/${organizations[0]}/channels/${randomUUID()}/deletion`])
      expect((await admin.inject({method:'POST',url,headers,payload:{confirmationName:'Matrix 1',reason:'Synthetic denied deletion'}})).statusCode).toBe(403);
    expect(lifecycle.previewOrganization).not.toHaveBeenCalled();expect(lifecycle.requestOrganization).not.toHaveBeenCalled();
    expect(lifecycle.previewChannel).not.toHaveBeenCalled();expect(lifecycle.requestChannel).not.toHaveBeenCalled();
    expect((await admin.inject({url:'/v1/platform/support/tickets',headers})).json().data).toEqual(expect.arrayContaining([expect.objectContaining({id:ticket.ticket.id})]));
    const staffReply=await admin.inject({method:'POST',url:`/v1/platform/support/tickets/${ticket.ticket.id}/replies`,headers,
      payload:{message:'Synthetic support answer.',revision:1,requestId:randomUUID()}});
    expect(staffReply.statusCode).toBe(200);
    expect(staffReply.json().ticket.status).toBe('WAITING_CUSTOMER');
    expect((await tenant.inject({url:`/v1/support/tickets/${ticket.ticket.id}`,headers:{authorization:one}})).json().messages)
      .toEqual(expect.arrayContaining([expect.objectContaining({body:'Synthetic support answer.'})]));
    expect((await admin.inject({url:'/v1/platform/support/tickets',headers:{authorization:one}})).statusCode).toBe(401);
    const key=await apiKeys.issueApiKey({organizationId:organizations[0]!,actorId:owners[0]!,credentialKind:'JWT',requestId:randomUUID()},
      {name:'matrix-runtime',scopes:['instances:read'],expiresAt:null});
    expect(await apiKeys.authenticateApiKey(key.secret)).toMatchObject({organizationId:organizations[0]});
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{'x-jrc-api-key':key.secret}})).statusCode).toBe(403);
    expect((await admin.inject({url:'/v1/platform/support/tickets',headers:{authorization:`Bearer ${key.secret}`}})).statusCode).toBe(401);
    await expect(platform.execute(staffToken,'Support cannot alter plan','update',organizations[0],{plan:'ENTERPRISE'})).rejects.toMatchObject({statusCode:403});
    await expect(platform.createGroup(staffToken,'Support cannot create group',{name:'Denied group'})).rejects.toMatchObject({statusCode:403});
    const group=(await db.pool.query('select group_id from economic_group_organizations where organization_id=$1',[organizations[0]])).rows[0].group_id as string;
    await expect(platform.removeEconomicGroup(staffToken,'Support cannot remove group',group,{expectedRevision:1,detachCompanies:true})).rejects.toMatchObject({statusCode:403});
    await expect(platform.execute(adminToken,'Protect sole owner','membership',organizations[2],{email:'matrix-owner-3@example.test',role:'VIEWER',status:'ACTIVE'})).rejects.toMatchObject({code:'PLATFORM_LAST_OWNER'});
    expect((await tenant.inject({url:'/v1/flows/status',headers:{authorization:one}})).statusCode).toBe(200);
    expect((await tenant.inject({url:'/v1/automation-nodes',headers:{authorization:one}})).statusCode).toBe(200);
    expect((await tenant.inject({url:'/v1/organization/overview',headers:{authorization:one}})).statusCode).toBe(200);
    await db.pool.query("update memberships set status='DISABLED' where organization_id=$1 and user_id=$2",[organizations[0],sharedUser]);
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:one}})).statusCode).toBe(401);
    expect((await tenant.inject({url:`/v1/flows/${randomUUID()}/export`,headers:{authorization:one}})).statusCode).toBe(401);
    expect((await tenant.inject({url:`/v1/executions/${randomUUID()}`,headers:{authorization:one}})).statusCode).toBe(401);
    expect((await tenant.inject({url:'/v1/organization/overview',headers:{authorization:one}})).statusCode).toBe(401);
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:two}})).statusCode).toBe(200);
    await db.pool.query("update organizations set status='SUSPENDED' where id=$1",[organizations[1]]);
    expect((await tenant.inject({url:'/v1/support/tickets',headers:{authorization:two}})).statusCode).toBe(403);
    const suspendedOrg=organizations[2]!,ownerAuthorization=`Bearer ${await issueAccessToken({userId:owners[2]!,organizationId:suspendedOrg,role:'OWNER'},secret)}`;
    const automationGraph={nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},
      {id:'end',type:'end',label:'Fim',position:{x:1,y:1},data:{}}],edges:[{id:'e',source:'start',target:'end',port:'next'}]};
    await db.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[suspendedOrg]);
    const flowCreate=(name:string)=>tenant.inject({method:'POST',url:'/v1/flows',headers:{authorization:ownerAuthorization},payload:{name,graph:welcomeFlow()}});
    const automationCreate=(name:string,key:string)=>tenant.inject({method:'POST',url:'/v1/automations',
      headers:{authorization:ownerAuthorization,'idempotency-key':key},payload:{name,graph:automationGraph}});
    expect((await flowCreate('Allowed flow before suspension')).statusCode).toBe(201);
    expect((await automationCreate('Allowed automation before suspension','matrix-automation-before')).statusCode).toBe(201);
    const counts=async()=>({flows:Number((await db.pool.query('select count(*) from flows where organization_id=$1',[suspendedOrg])).rows[0].count),
      automations:Number((await db.pool.query('select count(*) from automation_definitions where organization_id=$1',[suspendedOrg])).rows[0].count)});
    const beforeSuspension=await counts();
    expect(beforeSuspension).toEqual({flows:1,automations:1});
    await db.pool.query("update organizations set status='SUSPENDED' where id=$1",[suspendedOrg]);
    expect((await flowCreate('Denied flow after suspension')).statusCode).toBe(403);
    expect((await automationCreate('Denied automation after suspension','matrix-automation-after')).statusCode).toBe(403);
    expect(await counts()).toEqual(beforeSuspension);
    expect((await tenant.inject({url:'/v1/organization/overview',headers:{authorization:ownerAuthorization}})).statusCode).toBe(200);
  }finally{await tenant.close();await admin.close();}
},30_000);
