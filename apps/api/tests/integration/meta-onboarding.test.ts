import {Pool} from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {runMigrations} from '../../src/db/migrate.js';
import {withOrganizationTransaction} from '../../src/db/tenant-transaction.js';
import {createMetaOnboardingService} from '../../src/modules/meta-onboarding/service.js';
import {createOrganization,runInAdminTransaction} from '../../src/modules/organizations/repository.js';
import {createUser} from '../../src/modules/users/repository.js';
import {createOwnerMembership} from '../../src/modules/memberships/repository.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl,type IsolatedPostgresDatabase} from './helpers/postgres.js';
import {connectionStringForRole} from './helpers/task7.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {probeRequiredRuntimeSchema} from '../../src/db/runtime-schema.js';
import {readFile} from 'node:fs/promises';
let db:IsolatedPostgresDatabase;let pool:Pool;let a:string;let b:string;let user:string;
const graph={authorize:vi.fn(async()=>({accessToken:'private-test-token',expiresAt:null})),subscribe:vi.fn(async()=>{}),checkReadiness:vi.fn(async():Promise<string[]>=>[]),register:vi.fn(async()=>{})};
let service:ReturnType<typeof createMetaOnboardingService>;
beforeAll(async()=>{
 const url=requireTestDatabaseAdminUrl();db=await createIsolatedPostgresDatabase(url);
 await withGlobalRoleLock(url,async()=>runMigrations(db.connectionString));
 await runInAdminTransaction(db.pool,async tx=>{
  a=(await createOrganization(tx,{name:'Meta A',slug:'meta-a'})).id;b=(await createOrganization(tx,{name:'Meta B',slug:'meta-b'})).id;
  user=(await createUser(tx,{email:'meta@example.test',passwordHash:'test'})).id;
  await createOwnerMembership(tx,{organizationId:a,userId:user});await createOwnerMembership(tx,{organizationId:b,userId:user});
 });
 pool=new Pool({connectionString:connectionStringForRole(db.connectionString,'jrc_app')});
 service=createMetaOnboardingService({transact:(org,operation)=>withOrganizationTransaction(pool,org,operation),graph,
  environment:{META_APP_ID:'123',META_APP_SECRET:'secret',META_SIGNUP_CONFIG_ID:'456',META_GRAPH_VERSION:'v25.0',META_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')}});
});
afterAll(async()=>{await pool?.end();await db?.dispose();});
it('isolates authorization, consumes state once, encrypts tokens and revokes access durably',async()=>{
 const start=await service.start(a,user);const input={state:start.state,code:'code',wabaId:'12345',phoneNumberId:'67890'};
 await expect(service.complete(b,user,input)).rejects.toMatchObject({status:409});
 expect(graph.authorize).not.toHaveBeenCalled();
 const connection=await service.complete(a,user,input);
 await expect(service.complete(a,user,input)).rejects.toMatchObject({status:409});
 expect((await service.list(b)).connections).toHaveLength(0);
 expect(connection.status).toBe('PENDING');
 const encrypted=(await db.pool.query('SELECT encrypted_token FROM meta_connections')).rows[0].encrypted_token;
 expect(encrypted).not.toContain('private-test-token');
 expect((await service.refresh(a,connection.id)).status).toBe('READY');
 await expect(service.revoke(b,connection.id)).rejects.toMatchObject({status:404});
 expect((await service.revoke(a,connection.id)).status).toBe('REVOKED');
 expect((await db.pool.query('SELECT encrypted_token FROM meta_connections')).rows[0].encrypted_token).toBeNull();
 await expect(service.refresh(a,connection.id)).rejects.toMatchObject({status:404});
});
it('rejects expired and other-user state; concurrent completions consume only once',async()=>{
 const start=await service.start(a,user);
 await db.pool.query('UPDATE meta_signup_states SET expires_at=now()-interval \'1 second\'');
 await expect(service.complete(a,user,{state:start.state,code:'x',wabaId:'12345',phoneNumberId:'99999'})).rejects.toMatchObject({status:409});
 const second=await service.start(a,user);const input={state:second.state,code:'x',wabaId:'12345',phoneNumberId:'99999'};
 await expect(service.complete(a,'00000000-0000-4000-8000-000000000001',input)).rejects.toMatchObject({status:409});
 const outcomes=await Promise.allSettled([service.complete(a,user,input),service.complete(a,user,input)]);
 expect(outcomes.filter(result=>result.status==='fulfilled'),JSON.stringify(outcomes)).toHaveLength(1);
});

it('keeps a WABA with its original tenant after revocation, before remote subscription', async()=>{
 const start=await service.start(b,user);
 const subscriptions=graph.subscribe.mock.calls.length;
 await expect(service.complete(b,user,{state:start.state,code:'code',wabaId:'12345',phoneNumberId:'77777'})).rejects.toMatchObject({status:409});
 expect(graph.subscribe).toHaveBeenCalledTimes(subscriptions);
});

it('allows only one tenant to claim a new WABA concurrently, while allowing multiple numbers for the winner',async()=>{
 const sa=await service.start(a,user);const sb=await service.start(b,user);
 const results=await Promise.allSettled([
  service.complete(a,user,{state:sa.state,code:'a',wabaId:'22222',phoneNumberId:'22223'}),
  service.complete(b,user,{state:sb.state,code:'b',wabaId:'22222',phoneNumberId:'22224'}),
 ]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const winner=results[0]!.status==='fulfilled'?a:b;
 const loser=winner===a?b:a;
 const next=await service.start(winner,user);
 await expect(service.complete(winner,user,{state:next.state,code:'next',wabaId:'22222',phoneNumberId:'22225'})).resolves.toMatchObject({status:'PENDING'});
 await withOrganizationTransaction(pool,loser,async tx=>{
  expect((await tx.query('SELECT * FROM meta_waba_ownership WHERE waba_id=$1',['22222'])).rows).toHaveLength(0);
  expect((await tx.query('SELECT claim_meta_waba($1) AS claimed',['22222'])).rows[0].claimed).toBe(false);
 });
});

it('records management signals once, isolates them and keeps readiness blocked if Graph fails',async()=>{
 const connection=(await service.list(a)).connections.find(c=>c.status!=='REVOKED')!;
 await service.refresh(a,connection.id);
 const checks=graph.checkReadiness.mock.calls.length;
 await service.managementUpdated(a,connection.id,'message_template_status_update','a'.repeat(64));
 expect(graph.checkReadiness).toHaveBeenCalledTimes(checks);
 expect(await service.managementUpdated(a,connection.id,'phone_number_quality_update','b'.repeat(64))).toBe(true);
 expect(await service.managementUpdated(a,connection.id,'phone_number_quality_update','b'.repeat(64))).toBe(false);
 graph.checkReadiness.mockRejectedValueOnce(new Error('provider unavailable'));
 await expect(service.refresh(a,connection.id)).rejects.toThrow('provider unavailable');
 expect(graph.checkReadiness).toHaveBeenCalledTimes(checks+1);
 const updated=(await service.list(a)).connections.find(c=>c.id===connection.id)!;
 expect(updated).toMatchObject({status:'PENDING',pending:['META_AUTHORIZATION_RECHECK_REQUIRED']});
 expect(updated.managementEvents.map(e=>e.field).sort()).toEqual(['message_template_status_update','phone_number_quality_update']);
 await withOrganizationTransaction(pool,b,async tx=>{
  expect((await tx.query('SELECT * FROM meta_management_events')).rows).toHaveLength(0);
 });
 await service.managementUpdated(b,connection.id,'account_update','c'.repeat(64));
 expect((await db.pool.query('SELECT count(*)::integer AS count FROM meta_management_events')).rows[0].count).toBe(2);
 expect(await withOrganizationTransaction(pool,a,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)))).toBe(true);
 await service.refresh(a,connection.id);
 expect((await service.list(a)).connections.find(c=>c.id===connection.id)!.status).toBe('READY');
});

it('the migration aborts on ambiguous existing WABA ownership without choosing a tenant',async()=>{
 const start=await service.start(b,user);
 await service.complete(b,user,{state:start.state,code:'fixture',wabaId:'33333',phoneNumberId:'33334'});
 const client=await db.pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE meta_connections DROP CONSTRAINT meta_waba_owner_fk');
  await client.query('DROP TRIGGER meta_waba_owner_guard ON meta_connections');
  await client.query("UPDATE meta_connections SET waba_id='12345' WHERE waba_id='33333'");
  await client.query('SET LOCAL ROLE jrc_migrator');
  await expect(client.query(await readFile('apps/api/drizzle/migrations/0069_meta_waba_ownership.sql','utf8'))).rejects.toThrow('META_WABA_OWNERSHIP_CONFLICT');
 } finally {await client.query('ROLLBACK');client.release();}
});

it('does not let an older readiness request overwrite a newer management notification',async()=>{
 const connection=(await service.list(a)).connections.find(c=>c.status!=='REVOKED')!;
 let finish!:(value:string[])=>void;let started!:()=>void;
 const observed=new Promise<void>(resolve=>{started=resolve;});
 graph.checkReadiness.mockImplementationOnce(()=>{started();return new Promise<string[]>(resolve=>{finish=resolve;});});
 const old=service.refresh(a,connection.id);
 const rejected=expect(old).rejects.toMatchObject({status:409});
 await observed;
 await service.managementUpdated(a,connection.id,'business_capability_update','d'.repeat(64));
 finish([]);
 await rejected;
 expect((await service.list(a)).connections.find(c=>c.id===connection.id)!.status).toBe('PENDING');
});

it('does not revoke a fresh authorization when an old token returns an OAuth error',async()=>{
 const connection=(await service.list(a)).connections.find(c=>c.status!=='REVOKED')!;
 let fail!:(error:Error)=>void;let started!:()=>void;
 const observed=new Promise<void>(resolve=>{started=resolve;});
 graph.checkReadiness.mockImplementationOnce(()=>{started();return new Promise<string[]>((_resolve,reject)=>{fail=reject;});});
 const old=service.refresh(a,connection.id);
 const rejected=expect(old).rejects.toMatchObject({status:409});
 await observed;
 const start=await service.start(a,user);
 await service.complete(a,user,{state:start.state,code:'new-authorization',wabaId:connection.wabaId,phoneNumberId:connection.phoneNumberId});
 fail(new Error('META_TOKEN_REVOKED'));
 await rejected;
 expect((await service.list(a)).connections.find(c=>c.id===connection.id)!.status).toBe('PENDING');
});

it('deletes event metadata with its connection but retains ownership and denies tenant transfer',async()=>{
 const connection=(await service.list(a)).connections.find(c=>c.status!=='REVOKED')!;
 await service.managementUpdated(a,connection.id,'message_template_quality_update','e'.repeat(64));
 await db.pool.query('DELETE FROM meta_connections WHERE id=$1',[connection.id]);
 expect((await db.pool.query('SELECT * FROM meta_management_events WHERE connection_id=$1',[connection.id])).rows).toHaveLength(0);
 await withOrganizationTransaction(pool,b,async tx=>{
  expect((await tx.query('SELECT claim_meta_waba($1) AS claimed',[connection.wabaId])).rows[0].claimed).toBe(false);
 });
 await expect(withOrganizationTransaction(pool,b,tx=>tx.query('UPDATE meta_waba_ownership SET organization_id=$1',[b]))).rejects.toMatchObject({code:'42501'});
});
