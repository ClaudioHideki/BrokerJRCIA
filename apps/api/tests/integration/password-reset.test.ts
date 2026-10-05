import {beforeAll,afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {hashPassword,initializePasswordVerifier} from '@jrc/security';
import {runMigrations} from '../../src/db/migrate.js';
import {createIsolatedPostgresDatabase,requireTestDatabaseAdminUrl,type IsolatedPostgresDatabase} from './helpers/postgres.js';
import {PlatformService} from '../../src/modules/platform/service.js';
import {digest,encryptSeed} from '../../src/modules/platform/crypto.js';
let db:IsolatedPostgresDatabase,pool:Pool,service:PlatformService;
let userId:string,otherId:string,companyIds:string[];
const admin='a'.repeat(43),support='s'.repeat(43),key=Buffer.alloc(32,2),original='original-synthetic-password',replacement='replacement-synthetic-password';
beforeAll(async()=>{
 db=await createIsolatedPostgresDatabase(requireTestDatabaseAdminUrl());await runMigrations(db.connectionString);
 const url=new URL(db.connectionString);url.username='jrc_platform';pool=new Pool({connectionString:url.toString()});service=new PlatformService(pool,key);
 for(const [token,role] of [[admin,'SUPER_ADMIN'],[support,'SUPPORT']]){
  const actor=(await db.pool.query('INSERT INTO platform_users(email,password_hash,role,mfa_seed) VALUES($1,$2,$3,$4) RETURNING id',[`${role?.toLowerCase()}@example.test`,await hashPassword(original),role,encryptSeed(Buffer.alloc(20,2),key)])).rows[0].id;
  await db.pool.query("INSERT INTO platform_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '15 minutes')",[digest(token!),actor]);
 }
 const created=await service.execute(admin,'Create synthetic company','create',undefined,{name:'Company A',slug:'reset-company-a',ownerEmail:'target@example.test',ownerPassword:original}) as {organization:{id:string}};
 const second=await service.execute(admin,'Create synthetic company','create',undefined,{name:'Company B',slug:'reset-company-b',ownerEmail:'other@example.test',ownerPassword:original}) as {organization:{id:string}};
 companyIds=[created.organization.id,second.organization.id];
 userId=(await db.pool.query("SELECT id FROM users WHERE email='target@example.test'")).rows[0].id;otherId=(await db.pool.query("SELECT id FROM users WHERE email='other@example.test'")).rows[0].id;
 await service.execute(admin,'Add cross company user','membership',companyIds[1],{email:'target@example.test',role:'VIEWER',status:'DISABLED'});
 await service.execute(admin,'Suspend synthetic company','update',companyIds[1],{status:'SUSPENDED'});
});
afterAll(async()=>{await pool?.end();await db?.dispose();});
it('requires active superadmin, previews complete global identity, preserves relationships and isolates other users',async()=>{
 await expect(service.previewUserPasswordReset(support,'Review password reset',userId)).rejects.toMatchObject({statusCode:403});
 await expect(service.previewUserPasswordReset('x'.repeat(43),'Review password reset',userId)).rejects.toMatchObject({statusCode:401});
 const preview=await service.previewUserPasswordReset(admin,'Review password reset',userId);
 expect(preview).toMatchObject({userId,email:'target@example.test',status:'ACTIVE'});
 expect(preview.organizations).toHaveLength(2);
 expect(preview.organizations).toContainEqual(expect.objectContaining({id:companyIds[1],status:'SUSPENDED',membershipStatus:'DISABLED',role:'VIEWER'}));
 expect(JSON.stringify(preview)).not.toMatch(/password|hash|authVersion/);
 const input={password:replacement,confirmationEmail:preview.email,confirmationToken:preview.confirmationToken};
 await expect(service.resetUserPassword(support,'Reset selected identity',userId,input)).rejects.toMatchObject({statusCode:403});
 await expect(service.resetUserPassword(admin,'Reset selected identity',userId,{...input,confirmationEmail:'other@example.test'})).rejects.toMatchObject({code:'PASSWORD_RESET_CONFIRMATION_MISMATCH'});
 const before=(await db.pool.query('SELECT organization_id,user_id,role,status FROM memberships ORDER BY organization_id,user_id')).rows;
 const other=(await db.pool.query('SELECT password_hash FROM users WHERE id=$1',[otherId])).rows[0].password_hash;
 await expect(service.resetUserPassword(admin,replacement,userId,input)).resolves.toEqual({ok:true});
 const after=(await db.pool.query('SELECT password_hash,auth_version FROM users WHERE id=$1',[userId])).rows[0];
 const verifier=await initializePasswordVerifier();expect(await verifier.verifyPasswordOrDummy(replacement,after.password_hash)).toBe(true);expect(await verifier.verifyPasswordOrDummy(original,after.password_hash)).toBe(false);expect(after.auth_version).toBe(1);
 expect((await db.pool.query('SELECT password_hash FROM users WHERE id=$1',[otherId])).rows[0].password_hash).toBe(other);
 expect((await db.pool.query('SELECT organization_id,user_id,role,status FROM memberships ORDER BY organization_id,user_id')).rows).toEqual(before);
 const audit=(await db.pool.query("SELECT actor_id,organization_id,action,reason FROM platform_audit_logs WHERE action=$1",[`user-password-reset:${userId}`])).rows;
 expect(audit).toHaveLength(3);expect(audit.every(row=>row.actor_id)).toBe(true);expect(JSON.stringify(audit)).not.toContain(replacement);expect(JSON.stringify(audit)).not.toContain(after.password_hash);
 await expect(service.resetUserPassword(admin,'Do not repeat stale reset',userId,input)).rejects.toMatchObject({code:'PASSWORD_RESET_PREVIEW_CHANGED'});
});
it('rejects membership drift and role revocation after preview',async()=>{
 const preview=await service.previewUserPasswordReset(admin,'Review password reset',userId);
 await db.pool.query("UPDATE memberships SET role='OPERATOR' WHERE user_id=$1 AND organization_id=$2",[userId,companyIds[1]]);
 await expect(service.resetUserPassword(admin,'Reject changed membership',userId,{password:replacement,confirmationEmail:preview.email,confirmationToken:preview.confirmationToken})).rejects.toMatchObject({code:'PASSWORD_RESET_PREVIEW_CHANGED'});
 const current=await service.previewUserPasswordReset(admin,'Review password reset',userId);
 await db.pool.query("UPDATE platform_users SET role='SUPPORT' WHERE email='super_admin@example.test'");
 try{await expect(service.resetUserPassword(admin,'Reject revoked operator',userId,{password:replacement,confirmationEmail:current.email,confirmationToken:current.confirmationToken})).rejects.toMatchObject({statusCode:403});}
 finally{await db.pool.query("UPDATE platform_users SET role='SUPER_ADMIN' WHERE email='super_admin@example.test'");}
});
it('rolls back password, generation and audit if audit write fails',async()=>{
 const preview=await service.previewUserPasswordReset(admin,'Review password reset',userId);
 const before=(await db.pool.query('SELECT password_hash,auth_version FROM users WHERE id=$1',[userId])).rows[0];
 await db.pool.query("INSERT INTO login_sessions(user_id,token_hash,expires_at,auth_version) VALUES($1,'audit-rollback-selection',now()+interval '5 minutes',$2)",[userId,before.auth_version]);
 await db.pool.query(`CREATE FUNCTION reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'user-password-reset:%' THEN RAISE EXCEPTION 'Synthetic audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reset_audit BEFORE INSERT ON platform_audit_logs FOR EACH ROW EXECUTE FUNCTION reject_reset_audit()`);
 try{await expect(service.resetUserPassword(admin,'Reject audit failure',userId,{password:'another-synthetic-password',confirmationEmail:preview.email,confirmationToken:preview.confirmationToken})).rejects.toThrow();}
 finally{await db.pool.query('DROP TRIGGER reject_reset_audit ON platform_audit_logs; DROP FUNCTION reject_reset_audit()');}
 expect((await db.pool.query('SELECT password_hash,auth_version FROM users WHERE id=$1',[userId])).rows[0]).toEqual(before);
 expect((await db.pool.query("SELECT consumed_at FROM login_sessions WHERE token_hash='audit-rollback-selection'")).rows[0].consumed_at).toBeNull();
});
it('allows only one mutation from the same confirmed preview under concurrent submission',async()=>{
 const preview=await service.previewUserPasswordReset(admin,'Review concurrent reset',userId);
 const before=(await db.pool.query('SELECT auth_version FROM users WHERE id=$1',[userId])).rows[0].auth_version;
 const input={password:'concurrent-synthetic-password',confirmationEmail:preview.email,confirmationToken:preview.confirmationToken};
 const results=await Promise.allSettled([service.resetUserPassword(admin,'Concurrent reset one',userId,input),service.resetUserPassword(admin,'Concurrent reset two',userId,input)]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'PASSWORD_RESET_PREVIEW_CHANGED'}});
 expect((await db.pool.query('SELECT auth_version FROM users WHERE id=$1',[userId])).rows[0].auth_version).toBe(before+1);
});
