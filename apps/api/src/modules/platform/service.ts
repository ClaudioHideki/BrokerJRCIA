import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, initializePasswordVerifier } from '@jrc/security';
import { digest, decryptSeed, verifyTotp } from './crypto.js';
import {platformMfaRequired,type PlatformLoginPolicy} from './login-policy.js';
import { normalizeChatwootOrigin } from '../integrations/chatwoot-destination.js';

export class PlatformError extends Error { constructor(public statusCode:number, public code:string) {super(code);} }
export type PlatformAction = 'list'|'create'|'update'|'memberships'|'membership'|'monitor'|'acknowledge';
export interface PlatformSession { user:{id:string;email:string;role:'SUPER_ADMIN'|'SUPPORT'};csrfToken:string;expiresAt:string }
export interface Limits {maxInstances:number;maxUsers:number;messagesPerDay:number;maxPendingMessages:number}
export interface PlatformInput {name?:string;slug?:string;ownerEmail?:string;ownerPassword?:string;plan?:string;status?:string;limits?:Limits;email?:string;password?:string;role?:string}
export class PlatformService {
 private verifier=initializePasswordVerifier();
 readonly mfaRequired:boolean;
 constructor(private pool:Pool,private key:Buffer,policy:PlatformLoginPolicy={}) {if(key.length!==32) throw new Error('PLATFORM_MFA_KEY must decode to 32 bytes');this.mfaRequired=platformMfaRequired(policy);}
 private async transaction<T>(work:(c:PoolClient)=>Promise<T>):Promise<T> {
  const c=await this.pool.connect();try {
   const identity=await c.query('select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user');
   const r=identity.rows[0];if(r?.current_user!=='jrc_platform'||r.rolsuper||r.rolbypassrls) throw new Error('Dedicated jrc_platform connection required');
   await c.query('begin');const result=await work(c);await c.query('commit');return result;
  }catch(e){await c.query('rollback');throw e;}finally{c.release();}
 }
 async login(email:string,password:string,code:string,ip:string):Promise<PlatformSession&{token:string}> {
  // Counters commit independently of failed authentication. A database failure denies login.
  await this.transaction(async c=>{
   for(const k of [digest('identity:'+email.toLowerCase().trim()),digest('ip:'+ip)]) {
    const r=await c.query(`insert into platform_login_limits(key,attempts,expires_at) values($1,1,now()+interval '15 minutes')
     on conflict(key) do update set attempts=case when platform_login_limits.expires_at<now() then 1 else platform_login_limits.attempts+1 end,
     expires_at=case when platform_login_limits.expires_at<now() then now()+interval '15 minutes' else platform_login_limits.expires_at end returning attempts`,[k]);
    if(r.rows[0].attempts>10) throw new PlatformError(429,'PLATFORM_RATE_LIMITED');
   }
  });
  return this.transaction(async c=>{
   const user=(await c.query('select * from platform_users where email=$1 for update',[email.toLowerCase().trim()])).rows[0];
   const valid=await (await this.verifier).verifyPasswordOrDummy(password,user?.password_hash??null);
   if(!user||!valid||!user.active) throw new PlatformError(401,'PLATFORM_INVALID_CREDENTIALS');
   if(this.mfaRequired) {
    const step=verifyTotp(decryptSeed(user.mfa_seed,this.key),code,Date.now(),Number(user.last_totp_step));
    if(step===null) throw new PlatformError(401,'PLATFORM_INVALID_CREDENTIALS');
    await c.query('update platform_users set last_totp_step=$1 where id=$2',[step,user.id]);
   }
   const token=randomBytes(32).toString('base64url'), csrf=randomBytes(32).toString('base64url');
   const expiresAt=new Date(Date.now()+15*60*1000).toISOString();
   await c.query('insert into platform_sessions(token_hash,user_id,csrf_token,expires_at) values($1,$2,$3,$4)',[digest(token),user.id,csrf,expiresAt]);
   await this.audit(c,user.id,null,'login',this.mfaRequired?'Password and MFA verified':'Password verified in configured email/password mode');
   return {token,user:{id:user.id,email:user.email,role:user.role},csrfToken:csrf,expiresAt};
  });
 }
 private async readSession(c:PoolClient,token:string):Promise<PlatformSession> {
  const r=(await c.query(`select u.id,u.email,u.role,s.csrf_token,s.expires_at from platform_sessions s join platform_users u on u.id=s.user_id
   where s.token_hash=$1 and s.expires_at>now() and u.active`,[digest(token)])).rows[0];
  if(!r) throw new PlatformError(401,'PLATFORM_INVALID_SESSION');
  return {user:{id:r.id,email:r.email,role:r.role},csrfToken:r.csrf_token,expiresAt:new Date(r.expires_at).toISOString()};
 }
 session(token:string) {return this.transaction(c=>this.readSession(c,token));}
 async approveChatwootDestination(token:string,csrf:string,reason:string,org:string,input:{revision:number;mediaOrigins:string[]}) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  const origins=[...new Set(input.mediaOrigins.map(normalizeChatwootOrigin))];
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.csrfToken!==csrf||session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('chatwoot-destination:'||$1,0))",[org]);
   const row=(await c.query('SELECT * FROM chatwoot_destinations WHERE organization_id=$1 FOR UPDATE',[org])).rows[0];
   if(!row) throw new PlatformError(404,'DESTINATION_NOT_FOUND');
   if(row.revision!==input.revision) throw new PlatformError(409,'DESTINATION_REVISION_CHANGED');
   normalizeChatwootOrigin(row.base_url);
   const audit=(await c.query(`INSERT INTO platform_audit_logs(actor_id,organization_id,action,reason)
    VALUES($1,$2,'chatwoot-destination-approve',$3) RETURNING id`,[session.user.id,org,reason])).rows[0];
   return (await c.query(`UPDATE chatwoot_destinations SET approval_status='APPROVED',approval_audit_id=$2,
    approved_at=now(),media_origins=$3,updated_at=now() WHERE organization_id=$1
    RETURNING organization_id AS "organizationId",base_url AS "baseUrl",mode,approval_status AS "approvalStatus",media_origins AS "mediaOrigins",revision`,
   [org,audit.id,JSON.stringify(origins)])).rows[0];
  });
 }
 async authorizeIntegration(token:string,reason:string,org:string,write:boolean) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(write&&session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   if(!(await c.query('select id from organizations where id=$1',[org])).rowCount) throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');
   await this.audit(c,session.user.id,org,write?'integration-manage':'integration-read',reason);
   return session.user.id;
  });
 }
 async logout(token:string) {await this.transaction(async c=>{const s=await this.readSession(c,token);await c.query('delete from platform_sessions where token_hash=$1',[digest(token)]);await this.audit(c,s.user.id,null,'logout','Explicit session logout');});}
 private async audit(c:PoolClient,actor:string,org:string|null,action:string,reason:string) {await c.query('insert into platform_audit_logs(actor_id,organization_id,action,reason) values($1,$2,$3,$4)',[actor,org,action,reason]);}
 private async limits(c:PoolClient,id:string,l:Limits) {
  if(!Object.values(l).every(n=>Number.isSafeInteger(n)&&n>0&&n<=100000000)) throw new PlatformError(400,'INVALID_LIMITS');
  await c.query(`insert into organization_limits(organization_id,max_instances,max_users,messages_per_day,max_pending_messages) values($1,$2,$3,$4,$5)
   on conflict(organization_id) do update set max_instances=$2,max_users=$3,messages_per_day=$4,max_pending_messages=$5,updated_at=now()`,[id,l.maxInstances,l.maxUsers,l.messagesPerDay,l.maxPendingMessages]);
 }
 async execute(token:string,reason:string,action:PlatformAction,id?:string,input:PlatformInput={}) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const s=await this.readSession(c,token);
   if(!['list','memberships','monitor','acknowledge'].includes(action)&&s.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   if(id) {const org=await c.query('select id from organizations where id=$1 for update',[id]);if(!org.rowCount) throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');}
   let result:unknown;
   switch(action) {
    case 'acknowledge':result={ok:true};break;
    case 'list':result={organizations:(await c.query(`select o.id,o.name,o.slug,o.status,o.plan,
      json_build_object('maxInstances',l.max_instances,'maxUsers',l.max_users,'messagesPerDay',l.messages_per_day,'maxPendingMessages',l.max_pending_messages) as limits
      from organizations o left join organization_limits l on l.organization_id=o.id order by o.created_at desc limit 200`)).rows};break;
    case 'create': {
     const org=(await c.query('insert into organizations(name,slug,plan) values($1,$2,$3) returning id,name,slug,status,plan',[input.name,input.slug,input.plan??'STANDARD'])).rows[0];id=org.id;
     // Creating a new organization never changes an existing user's password.
     const user=(await c.query('insert into users(email,password_hash) values($1,$2) returning id',[input.ownerEmail?.trim().toLowerCase(),await hashPassword(input.ownerPassword!)])).rows[0];
     await c.query("insert into memberships(organization_id,user_id,role) values($1,$2,'OWNER')",[id,user.id]);
     await c.query("insert into provider_accounts(organization_id,provider,name) values($1,'BAILEYS','Baileys')",[id]);
     if(input.limits) await this.limits(c,id!,input.limits);result={organization:org};break;
    }
    case 'update':await c.query('update organizations set status=coalesce($2::organization_status,status),plan=coalesce($3,plan),updated_at=now() where id=$1',[id,input.status??null,input.plan??null]);if(input.limits) await this.limits(c,id!,input.limits);result={ok:true};break;
    case 'memberships':result={memberships:(await c.query('select u.id as "userId",u.email,m.role,m.status from memberships m join users u on u.id=m.user_id where m.organization_id=$1 order by u.email',[id])).rows};break;
    case 'membership': {
     const email=input.email!.trim().toLowerCase();let user=(await c.query('select id from users where email=$1',[email])).rows[0];
     if(!user) {if(!input.password) throw new PlatformError(400,'PASSWORD_REQUIRED');user=(await c.query('insert into users(email,password_hash) values($1,$2) returning id',[email,await hashPassword(input.password)])).rows[0];}
     const existing=await c.query('select 1 from memberships where organization_id=$1 and user_id=$2',[id,user.id]);
     if(existing.rowCount) await c.query('update memberships set role=$3,status=$4,updated_at=now() where organization_id=$1 and user_id=$2',[id,user.id,input.role,input.status??'ACTIVE']);
     else await c.query('insert into memberships(organization_id,user_id,role,status) values($1,$2,$3,$4)',[id,user.id,input.role,input.status??'ACTIVE']);
     result={ok:true};break;
    }
    case 'monitor':result=(await c.query(`select
     ((select count(*)::int from instances where organization_id=$1 and status='CONNECTED') + (select count(*)::int from messaging_channels where organization_id=$1)) as connections,
     (select count(*)::int from messaging_outbox where organization_id=$1) as queue,
     (select count(*)::int from messaging_messages where organization_id=$1 and state='FAILED') as failures,
     (select count(*)::int from messaging_inbox_events where organization_id=$1) as webhooks`,[id])).rows[0];break;
    default:throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   }
   await this.audit(c,s.user.id,id??null,action,reason);return result;
  });
 }
}
