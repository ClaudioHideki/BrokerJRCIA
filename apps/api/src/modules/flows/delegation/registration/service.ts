import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {OrganizationTransaction,TenantTransaction} from '../../../../db/tenant-transaction.js';
import type {BrokerPrincipal,FlowAccess} from '../service.js';
import {FlowDelegationError} from '../service.js';
import {RegistrationTupleSchema,OpaqueFlowSecret,createNativeRegistrationRepository,createNativeRegistrationVault,type ChallengeRow} from './core.js';
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const RegistrationChallengeCreateSchema=z.strictObject({credentialId:z.uuid(),expectedCredentialRevision:positive,expectedDestinationRevision:positive,expectedAccountCredentialVersion:positive,integrationIds:z.array(z.uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length)});
export const RegistrationCompleteSchema=z.strictObject({challengeId:z.uuid(),callbackCredential:OpaqueFlowSecret});
export const RegistrationVerificationSchema=z.strictObject({challengeId:z.uuid(),nonce:z.uuid(),...RegistrationTupleSchema.shape});
export const RegistrationVerificationDecisionSchema=RegistrationVerificationSchema.extend({authorized:z.literal(true)});
function fail(code:string,status=403):never{throw new FlowDelegationError(code,status);}
export interface NativeRegistrationServiceOptions {
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 authority(tx:TenantTransaction,auth:BrokerPrincipal|FlowAccess,credentialId:string,ids:string[]):Promise<{origin:string;expiresAt:Date;tuple:unknown}>;
 authorizeAdministrator(tx:TenantTransaction,principal:BrokerPrincipal):Promise<void>;
 vault:ReturnType<typeof createNativeRegistrationVault>;
 verifyHost(request:z.infer<typeof RegistrationVerificationSchema>,context:{organizationId:string;origin:string;callbackCredential:string}):Promise<unknown>;
}
export function createNativeRegistrationService(options:NativeRegistrationServiceOptions){
 const repository=createNativeRegistrationRepository();
 const audit=async(tx:TenantTransaction,org:string,actor:string|null,event:string,resource:string,id:string,metadata:Record<string,unknown>)=>{
  await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
   VALUES($1,$2,$3,$4,$5,$6,'SUCCESS',$7)`,[org,actor,event,resource,id,randomUUID(),JSON.stringify(metadata)]);
 };
 const current=async(tx:TenantTransaction,auth:BrokerPrincipal|FlowAccess,c:ChallengeRow)=>{
  const tuple=RegistrationTupleSchema.parse(c.tuple),ids=tuple.targets.map(t=>t.integrationId);
  const now=await options.authority(tx,auth,tuple.credentialId,ids);
  if(now.origin!==c.destination_origin||JSON.stringify(RegistrationTupleSchema.parse(now.tuple))!==JSON.stringify(tuple))fail('FLOW_CONTEXT_CHANGED',409);
  // The original Broker approval must also remain current after callback I/O.
  await options.authority(tx,{organizationId:auth.organizationId,actorId:c.created_by,authVersion:c.issuer_auth_version},tuple.credentialId,ids);
  return {...now,tuple};
 };
 const read=async(tx:TenantTransaction,access:FlowAccess,id:string,nonce:string,lock=false)=>{
  z.uuid().parse(id);OpaqueFlowSecret.parse(nonce);
  let c=await repository.get(tx,access.organizationId,id,hash(nonce),false);if(!c)fail('FLOW_REGISTRATION_CHALLENGE_NOT_FOUND',404);
  const authority=await current(tx,access,c);
  // Canonical ownership/credential/channel locks precede challenge-row locks.
  if(lock){c=await repository.get(tx,access.organizationId,id,hash(nonce),true);if(!c)fail('FLOW_REGISTRATION_CHALLENGE_NOT_FOUND',404);await current(tx,access,c);}
  return {c,authority};
 };
 return {
  async cancel(principal:BrokerPrincipal,id:string){z.uuid().parse(id);return options.transact(principal.organizationId,async tx=>{await options.authorizeAdministrator(tx,principal);if(!await repository.cancel(tx,principal.organizationId,id))fail('FLOW_REGISTRATION_CHALLENGE_NOT_FOUND',404);await audit(tx,principal.organizationId,principal.actorId,'FLOW_NATIVE_REGISTRATION_CHALLENGE_CANCELED','flow_registration_challenge',id,{actorKind:'BROKER'});return {revoked:true as const};});},
  async revoke(principal:BrokerPrincipal,id:string){z.uuid().parse(id);return options.transact(principal.organizationId,async tx=>{await options.authorizeAdministrator(tx,principal);if(!await repository.exists(tx,principal.organizationId,id))fail('FLOW_REGISTRATION_NOT_FOUND',404);await repository.revoke(tx,principal.organizationId,id);await repository.cancelForRegistration(tx,principal.organizationId,id);await audit(tx,principal.organizationId,principal.actorId,'FLOW_NATIVE_REGISTRATION_REVOKED','flow_registration',id,{actorKind:'BROKER'});return {revoked:true as const};});},
  async issue(principal:BrokerPrincipal,raw:unknown){
   const input=RegistrationChallengeCreateSchema.parse(raw),nonce=randomBytes(32).toString('base64url');
   return options.transact(principal.organizationId,async tx=>{
    const authority=await options.authority(tx,principal,input.credentialId,input.integrationIds),tuple=RegistrationTupleSchema.parse(authority.tuple);
    if(tuple.credentialRevision!==input.expectedCredentialRevision||tuple.destinationRevision!==input.expectedDestinationRevision||tuple.accountCredentialVersion!==input.expectedAccountCredentialVersion)fail('FLOW_CONTEXT_CHANGED',409);
    const row=await repository.insert(tx,{organizationId:principal.organizationId,id:randomUUID(),origin:authority.origin,tuple,nonceHash:hash(nonce),verificationNonce:randomUUID(),actorId:principal.actorId,authVersion:principal.authVersion});
    if(!row)fail('FLOW_ACCESS_DENIED');
    await audit(tx,principal.organizationId,principal.actorId,'FLOW_NATIVE_REGISTRATION_CHALLENGE_ISSUED','flow_registration_challenge',row.id,{actorKind:'BROKER',credentialId:tuple.credentialId,credentialRevision:tuple.credentialRevision,destinationRevision:tuple.destinationRevision,expiresAt:row.expires_at.toISOString()});
    return {challengeId:row.id,transferNonce:nonce,expiresAt:row.expires_at.toISOString(),context:tuple};
   });
  },
  async read(access:FlowAccess,id:string,nonce:string){return options.transact(access.organizationId,async tx=>{const {c,authority}=await read(tx,access,id,nonce);const r=c.registration_id?await repository.registrationHandle(tx,access.organizationId,c.registration_id):null;return {challengeId:c.id,expiresAt:c.expires_at.toISOString(),state:c.state,context:authority.tuple,registration:r?{id:r.id,revision:r.revision,expiresAt:r.expires_at.toISOString()}:null};});},
  async complete(access:FlowAccess,nonce:string,raw:unknown){
   const input=RegistrationCompleteSchema.parse(raw);OpaqueFlowSecret.parse(nonce);if(input.callbackCredential===access.token)fail('FLOW_REGISTRATION_KEY_AUDIENCE_INVALID');
   const snapshot=await options.transact(access.organizationId,async tx=>{
    const state=await read(tx,access,input.challengeId,nonce);
    if(state.c.state==='COMMITTED')fail('FLOW_REGISTRATION_CHALLENGE_CONSUMED',409);
    if(state.c.state!=='PENDING')fail('FLOW_REGISTRATION_IN_PROGRESS',409);
    const claimed=await repository.claim(tx,{organizationId:access.organizationId,id:input.challengeId,nonceHash:hash(nonce),callbackDigest:hash(input.callbackCredential)});
    if(!claimed)fail('FLOW_REGISTRATION_IN_PROGRESS',409);return {...state,c:claimed};
   });
   const request=RegistrationVerificationSchema.parse({challengeId:snapshot.c.id,nonce:snapshot.c.verification_nonce,...snapshot.authority.tuple});
   let rawDecision:unknown;try{rawDecision=await options.verifyHost(request,{organizationId:access.organizationId,origin:snapshot.authority.origin,callbackCredential:input.callbackCredential});}catch{fail('FLOW_REGISTRATION_HOST_UNAVAILABLE',503);}
   const decision=RegistrationVerificationDecisionSchema.safeParse(rawDecision);
   if(!decision.success)fail('FLOW_REGISTRATION_HOST_AUTHORITY_DENIED');
   const {authorized,...echo}=decision.data;if(!authorized||JSON.stringify(echo)!==JSON.stringify(request))fail('FLOW_REGISTRATION_HOST_AUTHORITY_DENIED');
   return options.transact(access.organizationId,async tx=>{
    const state=await read(tx,access,input.challengeId,nonce,true);
    if(state.c.state!=='VERIFYING'||state.c.callback_digest!==hash(input.callbackCredential))fail('FLOW_REGISTRATION_CHALLENGE_CONSUMED',409);
    const id=randomUUID(),sealed=options.vault.seal({organizationId:access.organizationId,registrationId:id,revision:1},input.callbackCredential);
    const row=await repository.commit(tx,{organizationId:access.organizationId,id:input.challengeId,nonceHash:hash(nonce),callbackDigest:hash(input.callbackCredential),registrationId:id,...sealed});
    if(!row)fail('FLOW_REGISTRATION_CHALLENGE_CONSUMED',409);
    await audit(tx,access.organizationId,null,'FLOW_NATIVE_REGISTRATION_COMMITTED','flow_registration',row.id,{actorKind:'JRC_NATIVE',challengeId:input.challengeId,approvedBy:state.c.created_by,credentialId:state.authority.tuple.credentialId,credentialRevision:state.authority.tuple.credentialRevision,revision:row.revision,expiresAt:row.expires_at.toISOString()});
    return {id:row.id,revision:row.revision,expiresAt:row.expires_at.toISOString(),challengeId:input.challengeId};
   });
  },
 };
}
