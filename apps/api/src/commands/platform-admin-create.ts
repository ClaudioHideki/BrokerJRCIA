import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from '@jrc/security';
import { base32, encryptSeed } from '../modules/platform/crypto.js';
import { z } from 'zod';
import { platformMfaRequired } from '../modules/platform/login-policy.js';
const mfaRequired=platformMfaRequired({mode:process.env.PLATFORM_LOGIN_MODE??'',localPasswordOnly:process.env.PLATFORM_LOCAL_PASSWORD_ONLY??'false',nodeEnv:process.env.NODE_ENV??'production',origin:process.env.PLATFORM_ORIGIN??''});
const environment=z.object({PLATFORM_DATABASE_URL:z.string().url(),PLATFORM_MFA_KEY:z.string(),PLATFORM_ADMIN_EMAIL:z.string().email(),PLATFORM_ADMIN_PASSWORD:z.string().min(12).max(256),PLATFORM_ADMIN_ROLE:z.enum(['SUPER_ADMIN','SUPPORT']).default('SUPER_ADMIN')}).parse(process.env);
const key=Buffer.from(environment.PLATFORM_MFA_KEY,'base64');if(key.length!==32)throw new Error('PLATFORM_MFA_KEY must decode to 32 bytes');
const pool=new Pool({connectionString:environment.PLATFORM_DATABASE_URL,max:1});
try {
 const identity=(await pool.query('select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
 if(identity.current_user!=='jrc_platform'||identity.rolsuper||identity.rolbypassrls)throw new Error('Dedicated jrc_platform login required');
 const seed=randomBytes(20); const email=environment.PLATFORM_ADMIN_EMAIL.trim().toLowerCase();
 const client=await pool.connect();try{await client.query('begin');
 const user=(await client.query('insert into platform_users(email,password_hash,role,mfa_seed) values($1,$2,$3,$4) returning id',[email,await hashPassword(environment.PLATFORM_ADMIN_PASSWORD),environment.PLATFORM_ADMIN_ROLE,encryptSeed(seed,key)])).rows[0];
 await client.query("insert into platform_audit_logs(actor_id,action,reason) values($1,'admin-create','Operator executed platform enrollment command')",[user.id]);await client.query('commit');
 }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 // Single enrollment output: do not capture this command in CI or shared logs.
 if(mfaRequired) process.stdout.write(`Enroll MFA now: otpauth://totp/JRC:${encodeURIComponent(email)}?secret=${base32(seed)}&issuer=JRC&algorithm=SHA1&digits=6&period=30\n`);
 else process.stdout.write('Administrador criado. Acesso com o e-mail e a senha informados.\n');
}finally{await pool.end();}
