import {z} from 'zod';
import {createIntegrationSecrets} from '../../../integrations/secrets.js';
import type {TenantTransaction} from '../../../../db/tenant-transaction.js';
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OpaqueFlowSecret=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const RegistrationTargetSchema=z.strictObject({integrationId:z.uuid(),channelId:z.uuid(),inboxId:positive,transport:z.enum(['BROKER_TRANSPORT','CENTRAL_TRANSPORT']),provider:z.literal('BAILEYS').nullable()});
export const RegistrationTupleSchema=z.strictObject({credentialId:z.uuid(),credentialRevision:positive,destinationRevision:positive,accountCredentialVersion:positive,accountId:positive,targets:z.array(RegistrationTargetSchema).min(1).max(100).refine(rows=>new Set(rows.map(row=>row.integrationId)).size===rows.length&&new Set(rows.map(row=>row.inboxId)).size===rows.length)});
export type RegistrationTuple=z.infer<typeof RegistrationTupleSchema>;
const Context=z.strictObject({organizationId:z.uuid(),registrationId:z.uuid(),revision:positive});
type VaultContext=z.infer<typeof Context>;
export interface NativeCallbackCipher {encrypted:string;keyVersion:number}
export function createNativeRegistrationVault(serialized:string){
 const parsed=z.record(z.string().regex(/^[1-9][0-9]*$/),z.string()).parse(JSON.parse(serialized));
 const versions=Object.keys(parsed).map(Number).sort((a,b)=>a-b);
 if(!versions.length||versions.some(version=>!Number.isSafeInteger(version)))throw new Error('FLOW_NATIVE_KEYRING_INVALID');
 const keys=new Map(versions.map(version=>[version,createIntegrationSecrets(parsed[String(version)]!)])),activeVersion=versions.at(-1)!;
 const aad=(input:VaultContext,version:number)=>`${input.organizationId}:FLOW_NATIVE_CALLBACK:${input.registrationId}:revision-${input.revision}:key-${version}`;
 return {seal(input:VaultContext,secret:string):NativeCallbackCipher{Context.parse(input);OpaqueFlowSecret.parse(secret);return {encrypted:keys.get(activeVersion)!.encrypt(aad(input,activeVersion),secret),keyVersion:activeVersion};},
  open(input:VaultContext&NativeCallbackCipher):string{try{Context.parse({organizationId:input.organizationId,registrationId:input.registrationId,revision:input.revision});const key=keys.get(input.keyVersion);if(!key)throw new Error();return OpaqueFlowSecret.parse(key.decrypt(aad(input,input.keyVersion),input.encrypted));}catch{throw new Error('FLOW_NATIVE_CALLBACK_UNAVAILABLE');}}};
}
export interface ChallengeRow {id:string;organization_id:string;credential_id:string;credential_revision:number;destination_origin:string;transfer_nonce_hash:string;verification_nonce:string;callback_digest:string|null;tuple:RegistrationTuple;state:'PENDING'|'VERIFYING'|'COMMITTED'|'CANCELED';created_by:string;issuer_auth_version:number;expires_at:Date;registration_id:string|null;revoked_at:Date|null}
export function createNativeRegistrationRepository(){return {
 async cancel(tx:TenantTransaction,org:string,id:string){return (await tx.query(`UPDATE flow_native_registration_challenges SET revoked_at=COALESCE(revoked_at,clock_timestamp()),state=CASE WHEN state='COMMITTED' THEN state ELSE 'CANCELED' END WHERE organization_id=$1 AND id=$2 RETURNING id`,[org,id])).rows.length===1;},
 async exists(tx:TenantTransaction,org:string,id:string){return (await tx.query('SELECT id FROM flow_native_registrations WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,id])).rows.length===1;},
 async cancelForRegistration(tx:TenantTransaction,org:string,id:string){await tx.query(`UPDATE flow_native_registration_challenges SET state='CANCELED',revoked_at=clock_timestamp() WHERE organization_id=$1 AND state IN ('PENDING','VERIFYING') AND credential_id=(SELECT credential_id FROM flow_native_registrations WHERE organization_id=$1 AND id=$2)`,[org,id]);},
 async get(tx:TenantTransaction,org:string,id:string,nonceHash:string,lock=false):Promise<ChallengeRow|null>{return (await tx.query<ChallengeRow>(`SELECT * FROM flow_native_registration_challenges WHERE organization_id=$1 AND id=$2 AND transfer_nonce_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() ${lock?'FOR UPDATE':''}`,[org,id,nonceHash])).rows[0]??null;},
 async insert(tx:TenantTransaction,input:{organizationId:string;id:string;origin:string;tuple:RegistrationTuple;nonceHash:string;verificationNonce:string;actorId:string;authVersion:number}){
  const t=input.tuple;
  const row=(await tx.query<ChallengeRow>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_native_registration_challenges(organization_id,id,credential_id,credential_revision,destination_origin,account_id,destination_revision,account_credential_version,transfer_nonce_hash,verification_nonce,tuple,created_by,issuer_auth_version,created_at,expires_at)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,moment.now,LEAST(moment.now+interval '5 minutes',c.expires_at) FROM flow_delegation_credentials c CROSS JOIN moment
   WHERE c.organization_id=$1 AND c.id=$3 AND c.revision=$4 AND c.revoked_at IS NULL AND c.expires_at>moment.now RETURNING *`,[input.organizationId,input.id,t.credentialId,t.credentialRevision,input.origin,t.accountId,t.destinationRevision,t.accountCredentialVersion,input.nonceHash,input.verificationNonce,JSON.stringify(t),input.actorId,input.authVersion])).rows[0];
  if(!row)return null;
  for(const target of t.targets)await tx.query('INSERT INTO flow_native_registration_targets(organization_id,challenge_id,integration_id,channel_id,inbox_id,transport,provider) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.organizationId,input.id,target.integrationId,target.channelId,target.inboxId,target.transport,target.provider]);
  return row;
 },
 async claim(tx:TenantTransaction,input:{organizationId:string;id:string;nonceHash:string;callbackDigest:string}):Promise<ChallengeRow|null>{
  return (await tx.query<ChallengeRow>(`UPDATE flow_native_registration_challenges SET state='VERIFYING',callback_digest=$4
   WHERE organization_id=$1 AND id=$2 AND transfer_nonce_hash=$3 AND state='PENDING' AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING *`,[input.organizationId,input.id,input.nonceHash,input.callbackDigest])).rows[0]??null;
 },
 async revoke(tx:TenantTransaction,org:string,id:string):Promise<boolean>{
  const result=await tx.query(`UPDATE flow_native_registrations SET callback_ciphertext=NULL,revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=revision+1
   WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`,[org,id]);return result.rows.length===1;
 },
 async commit(tx:TenantTransaction,input:{organizationId:string;id:string;nonceHash:string;callbackDigest:string;registrationId:string;encrypted:string;keyVersion:number}){
  const c=await this.get(tx,input.organizationId,input.id,input.nonceHash,true);
  if(!c||c.state!=='VERIFYING'||c.callback_digest!==input.callbackDigest)return null;
  const t=RegistrationTupleSchema.parse(c.tuple);
  const row=(await tx.query<{id:string;revision:number;expires_at:Date}>(`INSERT INTO flow_native_registrations(organization_id,id,challenge_id,credential_id,credential_revision,destination_origin,account_id,destination_revision,callback_ciphertext,callback_key_version,account_credential_version,created_by,issuer_auth_version,expires_at)
   SELECT $1,$2,$3,c.id,c.revision,$6,$7,$8,$9,$10,$11,$12,$13,c.expires_at FROM flow_delegation_credentials c
   WHERE c.organization_id=$1 AND c.id=$4 AND c.revision=$5 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() RETURNING id,revision,expires_at`,[input.organizationId,input.registrationId,c.id,t.credentialId,t.credentialRevision,(c as ChallengeRow&{destination_origin:string}).destination_origin,t.accountId,t.destinationRevision,input.encrypted,input.keyVersion,t.accountCredentialVersion,c.created_by,c.issuer_auth_version])).rows[0];
  if(!row)return null;
  const consumed=await tx.query(`UPDATE flow_native_registration_challenges SET state='COMMITTED',consumed_at=clock_timestamp(),registration_id=$4
   WHERE organization_id=$1 AND id=$2 AND transfer_nonce_hash=$3 AND state='VERIFYING' AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,[input.organizationId,input.id,input.nonceHash,row.id]);
  if(consumed.rows.length!==1)throw new Error('FLOW_REGISTRATION_COMMIT_ABORTED');
  return row;
 },
 async registrationHandle(tx:TenantTransaction,org:string,id:string){return (await tx.query<{id:string;revision:number;expires_at:Date}>('SELECT id,revision,expires_at FROM flow_native_registrations WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[org,id])).rows[0]??null;},
};}
