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
