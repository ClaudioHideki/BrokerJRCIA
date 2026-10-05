import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, initializePasswordVerifier } from '@jrc/security';
import { digest, decryptSeed, verifyTotp } from './crypto.js';
import {platformMfaRequired,type PlatformLoginPolicy} from './login-policy.js';
import { normalizeChatwootOrigin } from '../integrations/chatwoot-destination.js';
import { CreateEconomicGroupSchema, AssignGroupOrganizationsSchema, UpdateEconomicGroupSchema, RemoveEconomicGroupSchema } from '@jrc/contracts';
import { z } from 'zod';
import { PasswordResetInputSchema, passwordResetConfirmation, verifyPasswordResetConfirmation, type PasswordResetState } from './password-reset.js';
import { CreateCommercialPlanSchema, CreateCommercialPlanVersionSchema, AssignCommercialPlanSchema } from '@jrc/contracts';
import { listCommercialPlans, insertCommercialVersion, readCommercialAssignment, projectCommercialAssignment, snapshotLegacyCommercialAssignment } from '../commercial-plans/service.js';

export class PlatformError extends Error { constructor(public statusCode:number, public code:string) {super(code);} }
export type PlatformAction = 'list'|'create'|'update'|'memberships'|'membership'|'monitor'|'acknowledge';
export interface PlatformSession { user:{id:string;email:string;role:'SUPER_ADMIN'|'SUPPORT'};csrfToken:string;expiresAt:string }
export interface Limits {maxInstances:number;maxUsers:number;messagesPerDay:number;maxPendingMessages:number}
export interface PlatformInput {name?:string;slug?:string;ownerEmail?:string;ownerPassword?:string;plan?:string;status?:string;limits?:Limits;email?:string;password?:string;role?:string;flowsEnabled?:boolean}
const PLATFORM_PAGE_SIZE=200;
const cursorSchema=z.strictObject({version:z.literal(1),kind:z.enum(['groups','organizations']),sort:z.string(),id:z.uuid()});
function readPageCursor(kind:'groups'|'organizations',cursor?:string) {
 if(cursor===undefined) return undefined;
 try {
  if(cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid cursor encoding');
  const value=cursorSchema.parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));
  if(value.kind!==kind) throw new Error('Wrong cursor kind');
  if(kind==='groups') {
   if(value.sort.length<1||value.sort.length>120) throw new Error('Invalid group sort');
  } else {
   if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.sort)) throw new Error('Invalid date format');
   const date=new Date(value.sort);
   if(Number.isNaN(date.getTime())||date.toISOString().slice(0,19)!==value.sort.slice(0,19)) throw new Error('Invalid calendar date');
  }
  return value;
 } catch { throw new PlatformError(400,'PLATFORM_INVALID_CURSOR'); }
}
function writePageCursor(kind:'groups'|'organizations',sort:string,id:string) {
 return Buffer.from(JSON.stringify({version:1,kind,sort,id})).toString('base64url');
}
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
 private async passwordResetActor(c:PoolClient,token:string) {
  const session=await this.readSession(c,token);
  const actor=(await c.query('SELECT active,role FROM platform_users WHERE id=$1 FOR SHARE',[session.user.id])).rows[0];
  if(!actor?.active||actor.role!=='SUPER_ADMIN')throw new PlatformError(403,'PLATFORM_FORBIDDEN');
  return session.user.id;
 }
 private async passwordResetState(c:PoolClient,id:string):Promise<PasswordResetState> {
  // A strong user lock serializes credential resets and new membership FK checks.
  const user=(await c.query('SELECT id,email,status,auth_version FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!user)throw new PlatformError(404,'USER_NOT_FOUND');
  const organizations=(await c.query<PasswordResetState['organizations'][number]>(`SELECT o.id,o.name,o.status,m.role,m.status AS "membershipStatus"
   FROM memberships m JOIN organizations o ON o.id=m.organization_id
   WHERE m.user_id=$1 ORDER BY o.id FOR SHARE OF m,o`,[id])).rows;
  return {userId:user.id,email:user.email,status:user.status,authVersion:user.auth_version,organizations};
 }
 async previewUserPasswordReset(token:string,reason:string,id:string) {
  z.uuid().parse(id);
  if(reason.trim().length<5||reason.length>500)throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const actor=await this.passwordResetActor(c,token),state=await this.passwordResetState(c,id);
   await this.audit(c,actor,null,`user-password-reset-preview:${id}`,'Superadmin reviewed global user password reset');
   const {authVersion:_,...preview}=state;
   return {...preview,confirmationToken:passwordResetConfirmation(this.key,actor,state)};
  });
 }
 async resetUserPassword(token:string,reason:string,id:string,value:unknown) {
  z.uuid().parse(id);
  const input=PasswordResetInputSchema.parse(value);
  if(reason.trim().length<5||reason.length>500)throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const actor=await this.passwordResetActor(c,token),state=await this.passwordResetState(c,id);
   if(input.confirmationEmail!==state.email)throw new PlatformError(409,'PASSWORD_RESET_CONFIRMATION_MISMATCH');
   const confirmation=verifyPasswordResetConfirmation(this.key,actor,state,input.confirmationToken);
   if(confirmation!=='VALID')throw new PlatformError(409,`PASSWORD_RESET_PREVIEW_${confirmation}`);
   await c.query('UPDATE users SET password_hash=$2 WHERE id=$1',[id,await hashPassword(input.password)]);
   await c.query('SELECT public.revoke_user_authentication($1::uuid,$2::timestamptz)',[id,new Date()]);
   // Fixed audit text prevents accidental password disclosure through free-form reason fields.
   await this.audit(c,actor,null,`user-password-reset:${id}`,'Superadmin confirmed global user password reset');
   for(const organization of state.organizations)await this.audit(c,actor,organization.id,`user-password-reset:${id}`,'Global user password reset revoked existing user sessions');
   return {ok:true as const};
  });
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
 async listGroups(token:string,reason:string,cursor?:string) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  const after=readPageCursor('groups',cursor);
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   const rows=(await c.query(`SELECT g.id,g.name,g.revision,
    COALESCE((SELECT json_agg(m.organization_id ORDER BY m.organization_id) FROM economic_group_organizations m WHERE m.group_id=g.id),'[]') AS "organizationIds"
    FROM economic_groups g WHERE ($1::text IS NULL OR (g.name,g.id)>($1::text,$2::uuid))
    ORDER BY g.name,g.id LIMIT $3`,[after?.sort??null,after?.id??null,PLATFORM_PAGE_SIZE+1])).rows;
   const data=rows.slice(0,PLATFORM_PAGE_SIZE);
   const last=data.at(-1);
   const nextCursor=rows.length>PLATFORM_PAGE_SIZE&&last?writePageCursor('groups',last.name,last.id):undefined;
   await this.audit(c,session.user.id,null,'economic-groups-read',reason);return {data,...(nextCursor?{nextCursor}:{})};
  });
 }
 async createGroup(token:string,reason:string,value:{name:string}) {
  const input=CreateEconomicGroupSchema.parse(value);
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   const group=(await c.query('INSERT INTO economic_groups(name) VALUES($1) RETURNING id,name,revision',[input.name])).rows[0];
   await this.audit(c,session.user.id,null,`economic-group-create:${group.id}`,reason);return {...group,organizationIds:[]};
  });
 }
 async assignGroupOrganizations(token:string,reason:string,id:string,value:{revision:number;organizationIds:string[]}) {
  const input=AssignGroupOrganizationsSchema.parse(value);
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   const group=(await c.query('SELECT id,name,revision FROM economic_groups WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!group) throw new PlatformError(404,'GROUP_NOT_FOUND');
   if(group.revision!==input.revision) throw new PlatformError(409,'GROUP_REVISION_CHANGED');
   const organizations=await c.query('SELECT id FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[input.organizationIds]);
   if(organizations.rowCount!==input.organizationIds.length) throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');
   if((await c.query('SELECT 1 FROM economic_group_organizations WHERE organization_id=ANY($1::uuid[]) AND group_id<>$2',[input.organizationIds,id])).rowCount)
    throw new PlatformError(409,'ORGANIZATION_ALREADY_GROUPED');
   await c.query('DELETE FROM economic_group_organizations WHERE group_id=$1',[id]);
   await c.query('INSERT INTO economic_group_organizations(group_id,organization_id) SELECT $1,unnest($2::uuid[])',[id,input.organizationIds]);
   await c.query('UPDATE economic_groups SET revision=revision+1 WHERE id=$1',[id]);
   await this.audit(c,session.user.id,null,`economic-group-assign:${id}`,reason);
   return {...group,revision:group.revision+1,organizationIds:input.organizationIds};
  });
 }
 async updateEconomicGroup(token:string,reason:string,id:string,value:{name:string;expectedRevision:number}) {
  const input=UpdateEconomicGroupSchema.parse(value);
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   const group=(await c.query('SELECT id,name,revision FROM economic_groups WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!group) throw new PlatformError(404,'GROUP_NOT_FOUND');
   if(group.revision!==input.expectedRevision) throw new PlatformError(409,'GROUP_REVISION_CHANGED');
   const updated=(await c.query('UPDATE economic_groups SET name=$2,revision=revision+1 WHERE id=$1 RETURNING id,name,revision',[id,input.name])).rows[0];
   const members=await c.query<{organization_id:string}>('SELECT organization_id FROM economic_group_organizations WHERE group_id=$1 ORDER BY organization_id',[id]);
   await this.audit(c,session.user.id,null,`economic-group-update:${id}`,reason);
   return {...updated,organizationIds:members.rows.map(row=>row.organization_id)};
  });
 }
 async previewEconomicGroupRemoval(token:string,reason:string,id:string) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   // Membership writers use the same group lock, so the preview is coherent with its revision.
   const group=(await c.query('SELECT id,name,revision FROM economic_groups WHERE id=$1 FOR SHARE',[id])).rows[0];
   if(!group) throw new PlatformError(404,'GROUP_NOT_FOUND');
   const organizations=(await c.query<{id:string;name:string}>(`SELECT o.id,o.name FROM organizations o JOIN economic_group_organizations m ON m.organization_id=o.id
    WHERE m.group_id=$1 ORDER BY o.name,o.id`,[id])).rows;
   await this.audit(c,session.user.id,null,`economic-group-removal-preview:${id}`,reason);
   return {...group,organizations};
  });
 }
 async removeEconomicGroup(token:string,reason:string,id:string,value:{expectedRevision:number;detachCompanies:boolean}) {
  const input=RemoveEconomicGroupSchema.parse(value);
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(session.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   const group=(await c.query('SELECT revision FROM economic_groups WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!group) throw new PlatformError(404,'GROUP_NOT_FOUND');
   if(group.revision!==input.expectedRevision) throw new PlatformError(409,'GROUP_REVISION_CHANGED');
   const members=await c.query<{organization_id:string}>('SELECT organization_id FROM economic_group_organizations WHERE group_id=$1 ORDER BY organization_id',[id]);
   if(members.rows.length&&!input.detachCompanies) throw new PlatformError(409,'GROUP_DETACH_CONFIRMATION_REQUIRED');
   await c.query('DELETE FROM economic_group_organizations WHERE group_id=$1',[id]);
   await c.query('DELETE FROM economic_groups WHERE id=$1',[id]);
   await this.audit(c,session.user.id,null,`economic-group-remove:${id}`,reason);
   return {removed:true as const,preservedOrganizationIds:members.rows.map(row=>row.organization_id)};
  });
 }
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
 async authorizeChannels(token:string,reason:string,org:string,write:boolean){
  if(reason.trim().length<5||reason.length>500)throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{const session=await this.readSession(c,token);
   if(write&&session.user.role!=='SUPER_ADMIN')throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   if(!(await c.query('select id from organizations where id=$1',[org])).rowCount)throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');
   await this.audit(c,session.user.id,org,write?'channel-lifecycle-request':'channel-read',reason);return session.user.id;
  });
 }
 async logout(token:string) {await this.transaction(async c=>{const s=await this.readSession(c,token);await c.query('delete from platform_sessions where token_hash=$1',[digest(token)]);await this.audit(c,s.user.id,null,'logout','Explicit session logout');});}
 private async commercial<T>(token:string,reason:string,write:boolean,org:string|null,action:string,work:(c:PoolClient)=>Promise<T>){
  if(reason.trim().length<5||reason.length>500)throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  return this.transaction(async c=>{
   const session=await this.readSession(c,token);
   if(write&&session.user.role!=='SUPER_ADMIN')throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   // Lock the actor as well: revocation is ordered against the sensitive transaction.
   const current=(await c.query('SELECT active,role FROM platform_users WHERE id=$1 FOR SHARE',[session.user.id])).rows[0];
   if(!current?.active||(write&&current.role!=='SUPER_ADMIN'))throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   if(org&&!(await c.query(`SELECT id FROM organizations WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[org])).rowCount)throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');
   const result=await work(c);await this.audit(c,session.user.id,org,action,reason);return result;
  });
 }
 listCommercialPlans(token:string,reason:string){return this.commercial(token,reason,false,null,'commercial-catalog-read',listCommercialPlans);}
 createCommercialPlan(token:string,reason:string,value:unknown){
  const input=CreateCommercialPlanSchema.parse(value),id=randomUUID();
  return this.commercial(token,reason,true,null,`commercial-plan-create:${id}`,async c=>{
   const plan=(await c.query('INSERT INTO commercial_plans(id,name) VALUES($1,$2) RETURNING id',[id,input.name])).rows[0];
   return insertCommercialVersion(c,plan.id,1,input.name,input.limits,input.flowsEnabled);
  });
 }
 createCommercialPlanVersion(token:string,reason:string,id:string,value:unknown){
  const input=CreateCommercialPlanVersionSchema.parse(value);
  return this.commercial(token,reason,true,null,`commercial-plan-version:${id}:v${input.expectedRevision+1}`,async c=>{
   const plan=(await c.query('SELECT name,revision FROM commercial_plans WHERE id=$1 AND NOT legacy FOR UPDATE',[id])).rows[0];
   if(!plan)throw new PlatformError(404,'COMMERCIAL_PLAN_NOT_FOUND');
   if(plan.revision!==input.expectedRevision)throw new PlatformError(409,'COMMERCIAL_REVISION_CHANGED');
   await c.query('UPDATE commercial_plans SET revision=revision+1 WHERE id=$1',[id]);
   return insertCommercialVersion(c,id,plan.revision+1,plan.name,input.limits,input.flowsEnabled);
  });
 }
 getCommercialPlan(token:string,reason:string,org:string){return this.commercial(token,reason,false,org,'commercial-assignment-read',async c=>(await readCommercialAssignment(c,org))!);}
 assignCommercialPlan(token:string,reason:string,org:string,value:unknown){
  const input=AssignCommercialPlanSchema.parse(value);
  return this.commercial(token,reason,true,org,`commercial-plan-assign:${input.planVersionId}:r${input.expectedRevision+1}:${JSON.stringify(input.overrides)}`,async c=>{
   const current=await readCommercialAssignment(c,org);
   if(current?.revision!==input.expectedRevision)throw new PlatformError(409,'COMMERCIAL_REVISION_CHANGED');
   const result=await projectCommercialAssignment(c,org,input.planVersionId,input.overrides);
   if(!result)throw new PlatformError(404,'COMMERCIAL_PLAN_NOT_FOUND');return result;
  });
 }
 private async audit(c:PoolClient,actor:string,org:string|null,action:string,reason:string) {await c.query('insert into platform_audit_logs(actor_id,organization_id,action,reason) values($1,$2,$3,$4)',[actor,org,action,reason]);}
 private async limits(c:PoolClient,id:string,l:Limits) {
  if(!Object.values(l).every(n=>Number.isSafeInteger(n)&&n>0&&n<=100000000)) throw new PlatformError(400,'INVALID_LIMITS');
  await c.query(`insert into organization_limits(organization_id,max_instances,max_users,messages_per_day,max_pending_messages) values($1,$2,$3,$4,$5)
   on conflict(organization_id) do update set max_instances=$2,max_users=$3,messages_per_day=$4,max_pending_messages=$5,updated_at=now()`,[id,l.maxInstances,l.maxUsers,l.messagesPerDay,l.maxPendingMessages]);
 }
 async execute(token:string,reason:string,action:PlatformAction,id?:string,input:PlatformInput={},cursor?:string) {
  if(reason.trim().length<5||reason.length>500) throw new PlatformError(400,'PLATFORM_REASON_REQUIRED');
  const after=action==='list'?readPageCursor('organizations',cursor):undefined;
  return this.transaction(async c=>{
   const s=await this.readSession(c,token);
   if(!['list','memberships','monitor','acknowledge'].includes(action)&&s.user.role!=='SUPER_ADMIN') throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   if(id) {const org=await c.query('select id from organizations where id=$1 for update',[id]);if(!org.rowCount) throw new PlatformError(404,'ORGANIZATION_NOT_FOUND');}
   let result:unknown;
   switch(action) {
    case 'acknowledge':result={ok:true};break;
    case 'list':{
     const rows=(await c.query(`select o.id,o.name,o.slug,o.status,o.plan,coalesce(f.enabled,false) AS "flowsEnabled",
      json_build_object('maxInstances',l.max_instances,'maxUsers',l.max_users,'messagesPerDay',l.messages_per_day,'maxPendingMessages',l.max_pending_messages) as limits,
      to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorSort"
      from organizations o left join organization_limits l on l.organization_id=o.id left join flow_features f on f.organization_id=o.id
      where ($1::timestamptz IS NULL OR (o.created_at,o.id)<($1::timestamptz,$2::uuid))
      order by o.created_at desc,o.id desc limit $3`,[after?.sort??null,after?.id??null,PLATFORM_PAGE_SIZE+1])).rows;
     const page=rows.slice(0,PLATFORM_PAGE_SIZE);
     const last=page.at(-1);
     const nextCursor=rows.length>PLATFORM_PAGE_SIZE&&last?writePageCursor('organizations',last.cursorSort,last.id):undefined;
     result={organizations:page.map(({cursorSort:_,...organization})=>organization),...(nextCursor?{nextCursor}:{})};break;
    }
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
     const existing=await c.query('select role,status from memberships where organization_id=$1 and user_id=$2',[id,user.id]);
     if(existing.rows[0]?.role==='OWNER'&&existing.rows[0]?.status==='ACTIVE'&&(input.role!=='OWNER'||input.status!=='ACTIVE')){
       const owners=await c.query("select count(*)::int n from memberships where organization_id=$1 and role='OWNER' and status='ACTIVE'",[id]);
       if(owners.rows[0].n<=1)throw new PlatformError(409,'PLATFORM_LAST_OWNER');
     }
     if(existing.rowCount) await c.query('update memberships set role=$3,status=$4,updated_at=now() where organization_id=$1 and user_id=$2',[id,user.id,input.role,input.status??'ACTIVE']);
     else await c.query('insert into memberships(organization_id,user_id,role,status) values($1,$2,$3,$4)',[id,user.id,input.role,input.status??'ACTIVE']);
     result={ok:true};break;
    }
    case 'monitor':result=(await c.query(`select
     ((select count(*)::int from instances where organization_id=$1 and status='CONNECTED') + (select count(*)::int from messaging_channels where organization_id=$1 and provider='META')) as connections,
     (select count(*)::int from messaging_outbox where organization_id=$1) as queue,
     (select count(*)::int from messaging_messages where organization_id=$1 and state='FAILED') as failures,
     (select count(*)::int from messaging_inbox_events where organization_id=$1) as webhooks`,[id])).rows[0];break;
    default:throw new PlatformError(403,'PLATFORM_FORBIDDEN');
   }
   if((action==='create'||action==='update')&&typeof input.flowsEnabled==='boolean') {
    await c.query(`insert into flow_features(organization_id,enabled) values($1,$2)
      on conflict(organization_id) do update set enabled=excluded.enabled,revision=flow_features.revision+1,updated_at=now()
      where flow_features.enabled is distinct from excluded.enabled`,[id,input.flowsEnabled]);
   }
   if(action==='create'||(action==='update'&&(input.plan!==undefined||input.limits!==undefined||input.flowsEnabled!==undefined))){
    const snapshot=await snapshotLegacyCommercialAssignment(c,id!);
    await this.audit(c,s.user.id,id!,`commercial-legacy-snapshot:${snapshot.planVersionId}:r${snapshot.revision}`,reason);
   }
   await this.audit(c,s.user.id,id??null,action,reason);return result;
  });
 }
}
