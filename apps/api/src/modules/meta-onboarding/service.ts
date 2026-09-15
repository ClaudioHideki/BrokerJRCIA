import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { MessagingChannel } from '../messaging/types.js';
import { MetaSignupGraphClient, openToken, sealToken } from './graph.js';
import {TenantOperationalError} from '../tenancy/operational-limits.js';

export interface SignupInput {state:string;code:string;wabaId:string;phoneNumberId:string}
export interface MetaConnectionView {id:string;channelId:string;wabaId:string;phoneNumberId:string;status:'PENDING'|'READY'|'REVOKED';pending:string[]}
interface Options {
 environment: NodeJS.ProcessEnv | Record<string,string|undefined>;
 transact<T>(organizationId:string,operation:OrganizationTransaction<T>):Promise<T>;
 graph?: Pick<MetaSignupGraphClient,'authorize'|'subscribe'|'checkReadiness'|'register'>;
}
const fail=(status:number)=>Object.assign(new Error('META_ONBOARDING_UNAVAILABLE'),{status});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const columns=`id,channel_id AS "channelId",waba_id AS "wabaId",phone_number_id AS "phoneNumberId",status,pending`;
export function createMetaOnboardingService(options:Options) {
 const env=options.environment;
 const configured=Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_SIGNUP_CONFIG_ID && env.META_GRAPH_VERSION && env.META_TOKEN_ENCRYPTION_KEY);
 const key=Buffer.from(env.META_TOKEN_ENCRYPTION_KEY ?? '', 'base64');
 if(configured && key.length!==32) throw new Error('META_CONFIG_INVALID');
 const graph=configured ? options.graph ?? new MetaSignupGraphClient({appId:env.META_APP_ID!,appSecret:env.META_APP_SECRET!,graphVersion:env.META_GRAPH_VERSION!}) : null;
 async function active(organizationId:string) {
  const allowed=await options.transact(organizationId,async tx=>(await tx.query(`SELECT id FROM organizations WHERE id=$1 AND status='ACTIVE'`,[organizationId])).rowCount);
  if(!allowed) throw new TenantOperationalError();
 }
 const service = {
  async list(organizationId:string) {
   return {configured,connections:await options.transact(organizationId,async tx=>(await tx.query<MetaConnectionView>(`SELECT ${columns} FROM meta_connections WHERE organization_id=$1 ORDER BY updated_at DESC`,[organizationId])).rows)};
  },
  async start(organizationId:string,userId:string) {
   if(!configured) throw fail(503);
   await active(organizationId);
   const state=randomBytes(32).toString('base64url'); const expiresAt=new Date(Date.now()+600_000);
   await options.transact(organizationId,async tx=>{
    await tx.query('DELETE FROM meta_signup_states WHERE organization_id=$1 AND (user_id=$2 OR expires_at<now())',[organizationId,userId]);
    await tx.query('INSERT INTO meta_signup_states(state_hash,organization_id,user_id,expires_at) VALUES($1,$2,$3,$4)',[hash(state),organizationId,userId,expiresAt]);
   });
   return {state,expiresAt:expiresAt.toISOString(),appId:env.META_APP_ID!,configId:env.META_SIGNUP_CONFIG_ID!,graphVersion:env.META_GRAPH_VERSION!};
  },
  async complete(organizationId:string,userId:string,input:SignupInput):Promise<MetaConnectionView> {
   if(!graph) throw fail(503);
   // Commit consumption independently: provider errors and transaction conflicts must not resurrect a code/state.
   const consumed=await options.transact(organizationId,async tx=>(await tx.query(`UPDATE meta_signup_states SET consumed_at=now()
    WHERE state_hash=$1 AND organization_id=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash`,[hash(input.state),organizationId,userId])).rowCount);
   if(!consumed) throw fail(409);
   await active(organizationId);
   const authorization=await graph.authorize(input.code,input.wabaId,input.phoneNumberId);
   const id=randomUUID();const channelId=randomUUID();const providerId=randomUUID();
   const pending=['PHONE_REGISTRATION_REQUIRED','META_PAYMENT_METHOD_REQUIRED','META_BUSINESS_REVIEW_REQUIRED'];
   try {await graph.subscribe(input.wabaId,authorization.accessToken);} catch {pending.push('WEBHOOK_SUBSCRIPTION_REQUIRED');}
   return options.transact(organizationId,async tx=>{
    const existing=(await tx.query<{id:string;waba_id:string}>('SELECT id,waba_id FROM meta_connections WHERE organization_id=$1 AND phone_number_id=$2 FOR UPDATE',[organizationId,input.phoneNumberId])).rows[0];
    if(existing) {
     if(existing.waba_id!==input.wabaId) throw fail(409);
     return (await tx.query<MetaConnectionView>(`UPDATE meta_connections SET encrypted_token=$3,token_expires_at=$4,graph_version=$5,status='PENDING',pending=$6,updated_at=now()
      WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`,[organizationId,existing.id,sealToken(authorization.accessToken,key,`${organizationId}:${existing.id}`),authorization.expiresAt,env.META_GRAPH_VERSION,JSON.stringify(pending)])).rows[0]!;
    }
    const reference=`meta-db:${id}`;
    await tx.query(`INSERT INTO provider_accounts(id,organization_id,provider,name,credential_reference) VALUES($1,$2,'META',$4,$3) ON CONFLICT (organization_id,provider) DO NOTHING`,[providerId,organizationId,reference,`Meta ${id}`]);
    const account=(await tx.query<{id:string}>(`SELECT id FROM provider_accounts WHERE organization_id=$1 AND provider='META'`,[organizationId])).rows[0]!;
    await tx.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference) VALUES($1,$2,$3,$4,$5,$6)`,[channelId,organizationId,account.id,input.phoneNumberId,input.wabaId,reference]);
    const row=await tx.query<MetaConnectionView>(`INSERT INTO meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,token_expires_at,graph_version,status,pending)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9) RETURNING ${columns}`,
      [id,organizationId,channelId,input.wabaId,input.phoneNumberId,sealToken(authorization.accessToken,key,`${organizationId}:${id}`),authorization.expiresAt,env.META_GRAPH_VERSION,JSON.stringify(pending)]);
    return row.rows[0]!;
   });
  },
  async revoke(organizationId:string,id:string):Promise<MetaConnectionView> {
   return options.transact(organizationId,async tx=>{
    const result=await tx.query<MetaConnectionView>(`UPDATE meta_connections SET status='REVOKED',encrypted_token=NULL,pending='["META_PERMISSION_REMOVAL_EXTERNAL"]',updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`,[organizationId,id]);
    if(!result.rows[0]) throw fail(404);
    return result.rows[0];
   });
  },
  async refresh(organizationId:string,id:string,pin?:string):Promise<MetaConnectionView> {
   if(!graph) throw fail(503);
   if(pin) await active(organizationId);
   const record=await options.transact(organizationId,async tx=>(await tx.query<{encrypted_token:string;waba_id:string;phone_number_id:string}>(
    `SELECT encrypted_token,waba_id,phone_number_id FROM meta_connections WHERE organization_id=$1 AND id=$2 AND status<>'REVOKED' AND (token_expires_at IS NULL OR token_expires_at>now())`,[organizationId,id])).rows[0]);
   if(!record) throw fail(404);
   const token=openToken(record.encrypted_token,key,`${organizationId}:${id}`);
   if(pin) await graph.register(record.phone_number_id,token,pin);
   let pending:string[];
   try {pending=await graph.checkReadiness(record.waba_id,record.phone_number_id,token);} catch(error) {
    if(error instanceof Error && error.message==='META_TOKEN_REVOKED') return service.revoke(organizationId,id);
    throw error;
   }
   return options.transact(organizationId,async tx=>{
    const result=await tx.query<MetaConnectionView>(`UPDATE meta_connections SET status=$3,pending=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 AND encrypted_token=$5 AND status<>'REVOKED' RETURNING ${columns}`,
     [organizationId,id,pending.length?'PENDING':'READY',JSON.stringify(pending),record.encrypted_token]);
    if(!result.rows[0]) throw fail(409);
    return result.rows[0];
   });
  },
  async accountUpdated(organizationId:string,id:string) {
   await options.transact(organizationId,async tx=>{
    await tx.query(`UPDATE meta_connections SET status='PENDING',pending='["META_AUTHORIZATION_RECHECK_REQUIRED"]',updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND status<>'REVOKED'`,[organizationId,id]);
   });
   // A signed account notification invalidates send eligibility immediately. Graph proves the next state.
   try {await service.refresh(organizationId,id);} catch {/* Remains blocked for operator refresh if Graph is unavailable. */}
  },
  async resolveCredential(channel:MessagingChannel) {
   if(!configured || !channel.credentialReference.startsWith('meta-db:')) throw fail(503);
   const id=channel.credentialReference.slice(8);
   return options.transact(channel.organizationId,async tx=>{
    const row=(await tx.query<{encrypted_token:string;graph_version:string}>(`SELECT encrypted_token,graph_version FROM meta_connections
      WHERE organization_id=$1 AND id=$2 AND channel_id=$3 AND phone_number_id=$4 AND waba_id=$5 AND status='READY'
      AND (token_expires_at IS NULL OR token_expires_at>now())`,[channel.organizationId,id,channel.id,channel.phoneNumberId,channel.wabaId])).rows[0];
    if(!row) throw fail(503);
    return {accessToken:openToken(row.encrypted_token,key,`${channel.organizationId}:${id}`),graphVersion:row.graph_version};
   });
  },
 };
 return service;
}
