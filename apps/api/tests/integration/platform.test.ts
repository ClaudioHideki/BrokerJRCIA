import { beforeAll, afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { runMigrations } from '../../src/db/migrate.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { PlatformService } from '../../src/modules/platform/service.js';
import { encryptSeed, totp } from '../../src/modules/platform/crypto.js';
import { hashPassword } from '@jrc/security';
import Fastify from 'fastify';
import {registerPlatformRoutes} from '../../src/http/routes/platform.js';
let db:IsolatedPostgresDatabase; let pool:Pool; let service:PlatformService;
const seed=Buffer.alloc(20,7), key=Buffer.alloc(32,5);
beforeAll(async()=>{
 db=await createIsolatedPostgresDatabase(requireTestDatabaseAdminUrl()); await runMigrations(db.connectionString);
 // The root integrates the migration journal; applying only when absent keeps this focused test independently runnable.
 if(!(await db.pool.query("select to_regclass('platform_users') as t")).rows[0].t) await db.pool.query('set role jrc_migrator').then(async()=>{ await db.pool.query(await readFile('apps/api/drizzle/migrations/0010_platform_administration.sql','utf8')); await db.pool.query('reset role'); });
 const url=new URL(db.connectionString);url.username='jrc_platform';pool=new Pool({connectionString:url.toString()});
 service=new PlatformService(pool,key);
 await db.pool.query('insert into platform_users(email,password_hash,role,mfa_seed) values ($1,$2,$3,$4)', ['admin@example.test',await hashPassword('long-test-password'),'SUPER_ADMIN',encryptSeed(seed,key)]);
 await db.pool.query('insert into platform_users(email,password_hash,role,mfa_seed) values ($1,$2,$3,$4)', ['support@example.test',await hashPassword('long-test-password'),'SUPPORT',encryptSeed(seed,key)]);
});
afterAll(async()=>{await pool?.end();await db?.dispose();});
it('groups organizations without sharing tenant authority and rejects stale assignments', async () => {
 await db.pool.query("update platform_users set last_totp_step=-1");
 const admin=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.9');
 const support=await service.login('support@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.10');
 const tenant=(await service.execute(admin.token,'Create grouped tenant','create',undefined,{name:'Grouped',slug:'grouped-test',ownerEmail:'grouped@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}}).organization.id;
 const group=await service.createGroup(admin.token,'Create economic group',{name:'Synthetic group'});
 await expect(service.assignGroupOrganizations(support.token,'Attempt support update',group.id,{revision:1,organizationIds:[tenant]})).rejects.toMatchObject({statusCode:403});
 await expect(service.assignGroupOrganizations(admin.token,'Assign explicit tenant',group.id,{revision:1,organizationIds:[tenant]})).resolves.toMatchObject({revision:2});
 await expect(service.assignGroupOrganizations(admin.token,'Reject stale assignment',group.id,{revision:1,organizationIds:[]})).rejects.toMatchObject({statusCode:409});
 expect((await service.listGroups(admin.token,'Review economic groups')).data).toContainEqual(expect.objectContaining({id:group.id,organizationIds:[tenant]}));
 const second=(await service.execute(admin.token,'Create second tenant','create',undefined,{name:'Second grouped',slug:'second-grouped-test',ownerEmail:'second-grouped@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}}).organization.id;
 await service.assignGroupOrganizations(admin.token,'Add independent company',group.id,{revision:2,organizationIds:[tenant,second]});
 const other=await service.createGroup(admin.token,'Create another group',{name:'Other synthetic group'});
 await expect(service.assignGroupOrganizations(admin.token,'Reject duplicate membership',other.id,{revision:1,organizationIds:[second]})).rejects.toMatchObject({code:'ORGANIZATION_ALREADY_GROUPED'});
 expect((await service.execute(admin.token,'Inspect isolated members','memberships',second))).toMatchObject({memberships:[{email:'second-grouped@example.test'}]});
 for(const role of ['jrc_auth','jrc_app']) {const c=await db.pool.connect();try{await c.query('begin');await c.query(`set local role ${role}`);await expect(c.query('select * from economic_groups')).rejects.toThrow();}finally{await c.query('rollback');c.release();}}
 expect((await db.pool.query('select count(*)::int n from memberships where organization_id=$1',[tenant])).rows[0].n).toBe(1);
 await service.logout(admin.token);await service.logout(support.token);
 await db.pool.query("update platform_users set last_totp_step=-1");
});
it('updates existing memberships at the user limit and while suspended',async()=>{
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
 const s=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.8');
 const result=await service.execute(s.token,'Create quota regression','create',undefined,{name:'Quota',slug:'quota-regression',ownerEmail:'quota-owner@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}};
 const id=result.organization.id;
 await service.execute(s.token,'Add quota member','membership',id,{email:'quota-member@example.test',password:'member-password-strong',role:'OPERATOR',status:'ACTIVE'});
 await db.pool.query('update organization_limits set max_users=2 where organization_id=$1',[id]);
 await expect(service.execute(s.token,'Change existing role','membership',id,{email:'quota-member@example.test',role:'ADMIN',status:'ACTIVE'})).resolves.toEqual({ok:true});
 await service.execute(s.token,'Suspend quota organization','update',id,{status:'SUSPENDED'});
 await expect(service.execute(s.token,'Change suspended role','membership',id,{email:'quota-member@example.test',role:'VIEWER',status:'ACTIVE'})).resolves.toEqual({ok:true});
 await expect(service.execute(s.token,'Disable suspended member','membership',id,{email:'quota-member@example.test',role:'VIEWER',status:'DISABLED'})).resolves.toEqual({ok:true});
 await service.logout(s.token);
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
});
it('isolates platform credentials from both runtime roles',async()=>{
 for(const role of ['jrc_auth','jrc_app']) {const c=await db.pool.connect(); try {await c.query('begin');await c.query(`set local role ${role}`);await expect(c.query('select * from platform_users')).rejects.toThrow();} finally{await c.query('rollback');c.release();}}
});
it('allows only platform administration to grant Flows, preserving the epoch on unrelated updates',async()=>{
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
 const s=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.9');
 const result=await service.execute(s.token,'Enable Flows for test tenant','create',undefined,{name:'Flows',slug:'flows-platform-test',ownerEmail:'flows-owner@example.test',ownerPassword:'owner-password-strong',flowsEnabled:true}) as {organization:{id:string}};
 const id=result.organization.id;
 const flag=async()=> (await db.pool.query('select enabled,revision from flow_features where organization_id=$1',[id])).rows[0];
 expect(await flag()).toEqual({enabled:true,revision:1});
 await service.execute(s.token,'Update plan without revoking sessions','update',id,{plan:'FLOWS',flowsEnabled:true});
 expect(await flag()).toEqual({enabled:true,revision:1});
 await service.execute(s.token,'Disable Flows for this tenant','update',id,{flowsEnabled:false});
 expect(await flag()).toEqual({enabled:false,revision:2});
 expect(await service.execute(s.token,'Inspect feature authorization','list')).toMatchObject({organizations:expect.arrayContaining([expect.objectContaining({id,flowsEnabled:false})])});
 await service.logout(s.token);
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
});
it('requires password and fresh MFA; hashes and revokes sessions',async()=>{
 const session=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.1');
 expect(session.user.role).toBe('SUPER_ADMIN');expect(await service.session(session.token)).toMatchObject({user:{email:'admin@example.test'}});
 await expect(service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.1')).rejects.toThrow();
 const stored=(await db.pool.query('select token_hash from platform_sessions')).rows[0];expect(stored.token_hash).not.toBe(session.token);
 await service.logout(session.token);await expect(service.session(session.token)).rejects.toThrow();
});
it('audits support reads and denies support mutations',async()=>{
 const s=await service.login('support@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.2');
 await service.execute(s.token,'Investigation ticket 1','list');
 await service.execute(s.token,'Acknowledged investigation ticket 1','acknowledge');
 await expect(service.execute(s.token,'Investigation ticket 1','update','00000000-0000-4000-8000-000000000001',{status:'SUSPENDED'})).rejects.toThrow();
 expect((await db.pool.query("select * from platform_audit_logs where action='list' and reason='Investigation ticket 1'")).rowCount).toBe(1);
 expect((await db.pool.query("select * from platform_audit_logs where action='acknowledge'")).rowCount).toBe(1);
});
it('manages two organizations without exposing content and rolls back changes when audit fails',async()=>{
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
 const s=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.3');
 const a=await service.execute(s.token,'Create customer A','create',undefined,{name:'Customer A',slug:'customer-a',ownerEmail:'a@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}};
 const b=await service.execute(s.token,'Create customer B','create',undefined,{name:'Customer B',slug:'customer-b',ownerEmail:'b@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}};
 expect(a.organization.id).not.toBe(b.organization.id);
 expect((await db.pool.query("select * from provider_accounts where organization_id=$1 and provider='BAILEYS'",[a.organization.id])).rowCount).toBe(1);
 expect(await service.execute(s.token,'Inspect customer A','memberships',a.organization.id)).toMatchObject({memberships:[{email:'a@example.test'}]});
 expect(await service.execute(s.token,'Inspect customer B','monitor',b.organization.id)).toEqual({connections:0,queue:0,failures:0,webhooks:0});
 await expect(pool.query('select content from messaging_messages')).rejects.toThrow();
 await db.pool.query("create function fail_platform_audit() returns trigger language plpgsql as $$begin raise exception 'audit unavailable';end$$;create trigger fail_platform_audit before insert on platform_audit_logs for each row execute function fail_platform_audit()");
 await expect(service.execute(s.token,'Suspend customer A','update',a.organization.id,{status:'SUSPENDED'})).rejects.toThrow('audit unavailable');
 expect((await db.pool.query('select status from organizations where id=$1',[a.organization.id])).rows[0].status).toBe('ACTIVE');
 await db.pool.query('drop trigger fail_platform_audit on platform_audit_logs;drop function fail_platform_audit()');
});
it('requires origin and CSRF with opaque cookies and fails closed when rate storage fails',async()=>{
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
 const app=Fastify();await registerPlatformRoutes(app,{service,origin:'https://console.example.test',secureCookies:true});
 try {
  const response=await app.inject({method:'POST',url:'/v1/platform/auth/login',headers:{origin:'https://console.example.test'},payload:{email:'admin@example.test',password:'long-test-password',totp:totp(seed,Math.floor(Date.now()/30000))}});
  expect(response.statusCode).toBe(200);const cookie=response.headers['set-cookie'] as string;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');expect(cookie).toContain('SameSite=Strict');
  expect((await app.inject({method:'POST',url:'/v1/platform/auth/logout',headers:{origin:'https://console.example.test',cookie}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/platform/auth/logout',headers:{origin:'https://evil.test',cookie,'x-csrf-token':response.json().csrfToken}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/platform/auth/logout',headers:{origin:'https://console.example.test',cookie,'x-csrf-token':response.json().csrfToken}})).statusCode).toBe(200);
  expect((await app.inject({url:'/v1/platform/auth/session',headers:{cookie}})).statusCode).toBe(401);
  await db.pool.query('revoke insert on platform_login_limits from jrc_platform');
  expect((await app.inject({method:'POST',url:'/v1/platform/auth/login',headers:{origin:'https://console.example.test'},payload:{email:'admin@example.test',password:'long-test-password',totp:'000000'}})).statusCode).toBe(500);
 }finally{await db.pool.query('grant insert on platform_login_limits to jrc_platform');await app.close();}
});

it('refuses removal of the last active owner with an actionable code',async()=>{
 await db.pool.query("update platform_users set last_totp_step=-1 where email='admin@example.test'");
 const s=await service.login('admin@example.test','long-test-password',totp(seed,Math.floor(Date.now()/30000)),'127.0.0.14');
 const created=await service.execute(s.token,'QA owner protection','create',undefined,{name:'Owner QA',slug:'owner-qa',ownerEmail:'owner-qa@example.test',ownerPassword:'owner-password-strong'}) as {organization:{id:string}};
 await expect(service.execute(s.token,'QA deactivate owner','membership',created.organization.id,{email:'owner-qa@example.test',role:'OWNER',status:'DISABLED'})).rejects.toMatchObject({code:'PLATFORM_LAST_OWNER'});
});
