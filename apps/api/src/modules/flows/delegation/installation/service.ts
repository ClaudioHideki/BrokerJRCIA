import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {OrganizationTransaction,TenantTransaction} from '../../../../db/tenant-transaction.js';
import {FlowDelegationError,type BrokerPrincipal,type FlowAccess,type createFlowDelegationService} from '../service.js';
import {createNativeRegistrationRepository,createNativeRegistrationVault,RegistrationTupleSchema} from '../registration/core.js';
import {createInstallationVault} from './vault.js';
import {InstallationIssueSchema,InstallationRevokeSchema,InstallationClaimSchema,InstallationRenewSchema,InstallationProofSchema,installationTupleDigest} from './contracts.js';
const positive=z.number().int().positive(),opaque=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export {InstallationIssueSchema,InstallationRevokeSchema} from './contracts.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),fresh=()=>randomBytes(32).toString('base64url');
export function installationReductionDigest(grantId:string,token:string,raw:unknown){z.uuid().parse(grantId);opaque.parse(token);const input=InstallationRevokeSchema.parse(raw);return hash(JSON.stringify({kind:'REVOKE',grantId,grantDigest:hash(token),...input}));}
const tupleDigest=(raw:unknown)=>{const t=RegistrationTupleSchema.parse(raw);return installationTupleDigest({accountId:t.accountId,destinationRevision:t.destinationRevision,accountCredentialVersion:t.accountCredentialVersion,targets:t.targets});};
function fail(code='FLOW_INSTALLATION_DENIED',status=403):never{throw new FlowDelegationError(code,status);}
interface Grant {id:string;organization_id:string;registration_id:string;generation:number;tuple:unknown;tuple_digest:string;destination_origin:string;account_id:string;destination_revision:number;account_credential_version:number;created_by:string;issuer_auth_version:number;token_hash:string|null;transfer_nonce_hash:string;host_callback_ciphertext:string|null;host_callback_key_version:number|null;state:string;current_credential_id:string;current_registration_id:string;expires_at:Date;transfer_expires_at:Date;live:boolean;transfer_live:boolean}
interface Registration {id:string;credential_id:string;credential_revision:number;revision:number;created_by:string;issuer_auth_version:number;callback_ciphertext:string|null;expires_at:Date;revoked_at:Date|null;tuple:unknown}
interface Operation {id:string;operation_nonce:string;expected_generation:number;kind:string;request_digest:string;proof_nonce:string;state:string;lease_live:boolean;recovery_live:boolean;response_ciphertext:string|null;response_key_version:number|null}
export interface InstallationOptions {
 transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
 service:ReturnType<typeof createFlowDelegationService>;keyring:string;
 verifyHost(request:z.infer<typeof InstallationProofSchema>,context:{organizationId:string;origin:string;callbackCredential:string}):Promise<unknown>;
}
export function createNativeInstallationService(options:InstallationOptions){
 const vault=createInstallationVault(options.keyring),registrationVault=createNativeRegistrationVault(options.keyring),repository=createNativeRegistrationRepository();
 const readGrant=async(tx:TenantTransaction,org:string,id:string,lock=false,allowExpired=false)=>{
  const row=(await tx.query<Grant>(`SELECT *,expires_at>clock_timestamp() AS live,transfer_expires_at>clock_timestamp() AS transfer_live FROM flow_native_installation_grants WHERE organization_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,[org,id])).rows[0];
  if(!row||row.state==='REVOKED'||!allowExpired&&!row.live)fail('FLOW_INSTALLATION_NOT_FOUND',404);return row;
 };
 const readRegistration=async(tx:TenantTransaction,org:string,id:string)=>{
  const row=(await tx.query<Registration>(`SELECT r.*,ch.tuple FROM flow_native_registrations r JOIN flow_native_registration_challenges ch ON ch.organization_id=r.organization_id AND ch.id=r.challenge_id WHERE r.organization_id=$1 AND r.id=$2`,[org,id])).rows[0];
  if(!row||row.revoked_at||!row.callback_ciphertext)fail();return row;
 };
 const current=async(tx:TenantTransaction,g:Grant,auth:BrokerPrincipal|FlowAccess,allowExpired=false)=>{
  const r=await readRegistration(tx,g.organization_id,g.current_registration_id),tuple=RegistrationTupleSchema.parse(r.tuple);
  const ids=tuple.targets.map(t=>t.integrationId),authority=await options.service.nativeRegistrationAuthority(tx,auth,r.credential_id,ids,allowExpired);
  const approved=await options.service.nativeRegistrationAuthority(tx,{organizationId:g.organization_id,actorId:g.created_by,authVersion:g.issuer_auth_version},r.credential_id,ids,allowExpired);
  if(r.credential_id!==g.current_credential_id||authority.origin!==g.destination_origin||approved.origin!==g.destination_origin||
   JSON.stringify(RegistrationTupleSchema.parse(authority.tuple))!==JSON.stringify(tuple)||tupleDigest(tuple)!==g.tuple_digest)fail('FLOW_CONTEXT_CHANGED',409);
  return {r,tuple,authority};
 };
 const audit=async(tx:TenantTransaction,g:Grant,event:string,principal?:BrokerPrincipal)=>tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata) VALUES($1,$2,$3,'flow_installation',$4,$5,'SUCCESS',$6)`,[g.organization_id,principal?.actorId??null,event,g.id,randomUUID(),JSON.stringify({actorKind:principal?'BROKER_USER':'INSTALLATION_GRANT',approvedBy:g.created_by,generation:g.generation,credentialId:g.current_credential_id,registrationId:g.current_registration_id})]);
 async function reserve(tx:TenantTransaction,g:Grant,kind:'CLAIM'|'RENEW',nonce:string,digest:string){
  let op=(await tx.query<Operation>(`SELECT *,lease_until>clock_timestamp() AS lease_live,recovery_expires_at>clock_timestamp() AS recovery_live FROM flow_native_installation_operations WHERE organization_id=$1 AND operation_nonce=$2 FOR UPDATE`,[g.organization_id,nonce])).rows[0];
  if(op){
   if(op.request_digest!==digest||op.kind!==kind)fail('FLOW_INSTALLATION_REPLAY_CHANGED',409);
   if(op.state==='COMMITTED'){if(!op.recovery_live||!op.response_ciphertext||!op.response_key_version)fail('FLOW_INSTALLATION_RECOVERY_EXPIRED',409);return {op,replay:JSON.parse(vault.open({organizationId:g.organization_id,id:op.id,generation:op.expected_generation,purpose:'FLOW_INSTALLATION_RESPONSE'},{encrypted:op.response_ciphertext,keyVersion:op.response_key_version}))};}
   if(!op.recovery_live||op.state==='CANCELED'||op.lease_live)fail('FLOW_INSTALLATION_IN_PROGRESS',409);
   const won=await tx.query(`UPDATE flow_native_installation_operations SET state='VERIFYING',lease_until=clock_timestamp()+interval '15 seconds' WHERE organization_id=$1 AND id=$2 AND state IN ('VERIFYING','UNKNOWN','PENDING') AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING id`,[g.organization_id,op.id]);
   if(!won.rows.length)fail('FLOW_INSTALLATION_IN_PROGRESS',409);return {op:{...op,state:'VERIFYING'},replay:null};
  }
  if((await tx.query("SELECT id FROM flow_native_installation_operations WHERE organization_id=$1 AND grant_id=$2 AND expected_generation=$3 AND state IN ('VERIFYING','PENDING','UNKNOWN') FOR UPDATE",[g.organization_id,g.id,g.generation])).rows.length)fail('FLOW_INSTALLATION_IN_PROGRESS',409);
  op=(await tx.query<Operation>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_native_installation_operations(organization_id,id,grant_id,operation_nonce,expected_generation,kind,request_digest,proof_nonce,state,lease_until,recovery_expires_at,previous_credential_id,previous_registration_id,created_at)
   SELECT $1,$2,$3,$4,$5,$6,$7,$8,'VERIFYING',moment.now+interval '15 seconds',LEAST(moment.now+interval '5 minutes',$9),$10,$11,moment.now FROM moment RETURNING *`,[g.organization_id,randomUUID(),g.id,nonce,g.generation,kind,digest,randomUUID(),kind==='CLAIM'?g.transfer_expires_at:g.expires_at,g.current_credential_id,g.current_registration_id])).rows[0]!;
  return {op,replay:null};
 }
 async function verify(snapshot:{g:Grant;r:Registration;op:Operation},kind:'CLAIM'|'RENEW',callback:string){
  const {g,r,op}=snapshot;
  const request=InstallationProofSchema.parse({audience:kind==='CLAIM'?'FLOW_INSTALLATION_CLAIM':'FLOW_INSTALLATION_RENEW',grantId:g.id,operationNonce:op.operation_nonce,proofNonce:op.proof_nonce,expectedGeneration:op.expected_generation,
   registrationId:r.id,registrationRevision:r.revision,credentialId:r.credential_id,credentialRevision:r.credential_revision,destinationRevision:g.destination_revision,accountCredentialVersion:g.account_credential_version,accountId:Number(g.account_id),tupleDigest:g.tuple_digest});
  try{const raw=await options.verifyHost(request,{organizationId:g.organization_id,origin:g.destination_origin,callbackCredential:callback});const decision=InstallationProofSchema.extend({authorized:z.literal(true)}).parse(raw);const {authorized,...echo}=decision;if(!authorized||JSON.stringify(echo)!==JSON.stringify(request))throw new Error();}
  catch{await options.transact(g.organization_id,tx=>tx.query("UPDATE flow_native_installation_operations SET state='UNKNOWN',lease_until=NULL WHERE organization_id=$1 AND id=$2 AND state='VERIFYING'",[g.organization_id,op.id]));fail('FLOW_INSTALLATION_HOST_UNAVAILABLE',503);}
 }
 async function commitResponse(tx:TenantTransaction,g:Grant,op:Operation,response:unknown,newCredentialId:string,newRegistrationId:string){
  const cipher=vault.seal({organizationId:g.organization_id,id:op.id,generation:op.expected_generation,purpose:'FLOW_INSTALLATION_RESPONSE'},JSON.stringify(response));
  const done=await tx.query(`UPDATE flow_native_installation_operations SET state='COMMITTED',committed_at=clock_timestamp(),lease_until=NULL,new_credential_id=$3,new_registration_id=$4,response_ciphertext=$5,response_key_version=$6
   WHERE organization_id=$1 AND id=$2 AND state='VERIFYING' AND lease_until>clock_timestamp() AND recovery_expires_at>clock_timestamp() RETURNING id`,[g.organization_id,op.id,newCredentialId,newRegistrationId,cipher.encrypted,cipher.keyVersion]);
  if(!done.rows.length)fail('FLOW_INSTALLATION_OPERATION_EXPIRED',409);
 }
 async function revoke(tx:TenantTransaction,g:Grant,principal?:BrokerPrincipal){
  await tx.query('UPDATE flow_delegation_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE organization_id=$1 AND credential_id=$2 AND revoked_at IS NULL',[g.organization_id,g.current_credential_id]);
  await tx.query('UPDATE flow_delegation_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=revision+1 WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL',[g.organization_id,g.current_credential_id]);
  await repository.revoke(tx,g.organization_id,g.current_registration_id);
  await tx.query("UPDATE flow_native_installation_operations SET response_ciphertext=NULL,response_key_version=NULL,lease_until=NULL,revoked_at=clock_timestamp(),state=CASE WHEN state='PENDING' THEN 'CANCELED' ELSE state END WHERE organization_id=$1 AND grant_id=$2",[g.organization_id,g.id]);
  await tx.query("UPDATE flow_native_installation_grants SET state='REVOKED',revoked_at=clock_timestamp(),token_hash=NULL,host_callback_ciphertext=NULL,host_callback_key_version=NULL WHERE organization_id=$1 AND id=$2",[g.organization_id,g.id]);
  await audit(tx,g,'FLOW_INSTALLATION_REVOKED',principal);return {revoked:true as const};
 }
 return {
  async issue(principal:BrokerPrincipal,raw:unknown){const input=InstallationIssueSchema.parse(raw),nonce=fresh();return options.transact(principal.organizationId,async tx=>{
   await options.service.nativeRegistrationAdministrator(tx,principal);const r=await readRegistration(tx,principal.organizationId,input.registrationId),tuple=RegistrationTupleSchema.parse(r.tuple);
   const a=await options.service.nativeRegistrationAuthority(tx,principal,r.credential_id,tuple.targets.map(t=>t.integrationId));
   if(r.revision!==input.expectedRegistrationRevision||tuple.credentialRevision!==input.expectedCredentialRevision||tuple.destinationRevision!==input.expectedDestinationRevision||tuple.accountCredentialVersion!==input.expectedAccountCredentialVersion||JSON.stringify(RegistrationTupleSchema.parse(a.tuple))!==JSON.stringify(tuple))fail('FLOW_CONTEXT_CHANGED',409);
   const g=(await tx.query<Grant>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_native_installation_grants(organization_id,id,registration_id,tuple,tuple_digest,destination_origin,account_id,destination_revision,account_credential_version,created_by,issuer_auth_version,transfer_nonce_hash,created_at,transfer_expires_at,expires_at,current_credential_id,current_registration_id)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,moment.now,LEAST(moment.now+interval '5 minutes',$13),moment.now+interval '30 days',$14,$3 FROM moment RETURNING *`,[principal.organizationId,randomUUID(),r.id,JSON.stringify(tuple),tupleDigest(tuple),a.origin,tuple.accountId,tuple.destinationRevision,tuple.accountCredentialVersion,principal.actorId,principal.authVersion,hash(nonce),a.expiresAt,r.credential_id])).rows[0]!;
   for(const t of tuple.targets)await tx.query('INSERT INTO flow_native_installation_targets(organization_id,grant_id,integration_id,channel_id,inbox_id,transport,provider) VALUES($1,$2,$3,$4,$5,$6,$7)',[principal.organizationId,g.id,t.integrationId,t.channelId,t.inboxId,t.transport,t.provider]);
   await audit(tx,g,'FLOW_INSTALLATION_ISSUED',principal);return {grantId:g.id,transferNonce:nonce,transferExpiresAt:g.transfer_expires_at.toISOString(),expiresAt:g.expires_at.toISOString()};
  });},
  async claim(access:FlowAccess,id:string,raw:unknown){z.uuid().parse(id);const input=InstallationClaimSchema.parse(raw);if(input.installationCallbackCredential===access.token)fail('FLOW_INSTALLATION_AUDIENCE_INVALID');
   const snapshot=await options.transact(access.organizationId,async tx=>{let g=await readGrant(tx,access.organizationId,id);const c=await current(tx,g,access);g=await readGrant(tx,access.organizationId,id,true);
    if(!g.transfer_live||g.transfer_nonce_hash!==hash(input.transferNonce))fail();
    const existing=registrationVault.open({organizationId:access.organizationId,registrationId:c.r.id,revision:c.r.revision,encrypted:c.r.callback_ciphertext!,keyVersion:(await tx.query<{callback_key_version:number}>('SELECT callback_key_version FROM flow_native_registrations WHERE organization_id=$1 AND id=$2',[access.organizationId,c.r.id])).rows[0]!.callback_key_version});
    if(existing===input.installationCallbackCredential)fail('FLOW_INSTALLATION_AUDIENCE_INVALID');
    const reservation=await reserve(tx,g,'CLAIM',input.operationNonce,hash(JSON.stringify({kind:'CLAIM',grantId:id,credentialDigest:hash(access.token),...input})));
    if(reservation.replay)return {g,r:c.r,...reservation};if(g.state!=='PENDING')fail('FLOW_INSTALLATION_ALREADY_CLAIMED',409);return {g,r:c.r,...reservation};});
   if(snapshot.replay)return snapshot.replay;
   await verify(snapshot,'CLAIM',input.installationCallbackCredential);
   return options.transact(access.organizationId,async tx=>{let g=await readGrant(tx,access.organizationId,id);const c=await current(tx,g,access);g=await readGrant(tx,access.organizationId,id,true);
    if(g.state!=='PENDING'||!g.transfer_live||g.generation!==snapshot.op.expected_generation||c.r.id!==snapshot.r.id||c.r.revision!==snapshot.r.revision)fail('FLOW_CONTEXT_CHANGED',409);
    const token=fresh(),cipher=vault.seal({organizationId:access.organizationId,id,generation:1,purpose:'FLOW_INSTALLATION_CALLBACK'},input.installationCallbackCredential);
    await tx.query("UPDATE flow_native_installation_grants SET state='ACTIVE',claimed_at=clock_timestamp(),token_hash=$3,host_callback_ciphertext=$4,host_callback_key_version=$5 WHERE organization_id=$1 AND id=$2",[access.organizationId,id,hash(token),cipher.encrypted,cipher.keyVersion]);
    const response={id,token,generation:1,expiresAt:g.expires_at.toISOString(),credentialExpiresAt:c.authority.expiresAt.toISOString()};
    await commitResponse(tx,g,snapshot.op,response,c.r.credential_id,c.r.id);await audit(tx,g,'FLOW_INSTALLATION_CLAIMED');return response;});
  },
  async renew(access:FlowAccess,id:string,raw:unknown){z.uuid().parse(id);opaque.parse(access.token);const input=InstallationRenewSchema.parse(raw);
   const snapshot=await options.transact(access.organizationId,async tx=>{let g=await readGrant(tx,access.organizationId,id);
    if(g.state!=='ACTIVE'||g.token_hash!==hash(access.token))fail();const auth={organizationId:access.organizationId,actorId:g.created_by,authVersion:g.issuer_auth_version};const c=await current(tx,g,auth,true);g=await readGrant(tx,access.organizationId,id,true);
    const reservation=await reserve(tx,g,'RENEW',input.operationNonce,hash(JSON.stringify({kind:'RENEW',grantId:id,grantDigest:hash(access.token),...input})));if(reservation.replay)return {g,r:c.r,tuple:c.tuple,...reservation};
    if(g.generation!==input.expectedGeneration||c.r.credential_id!==input.expectedCredentialId||c.r.credential_revision!==input.expectedCredentialRevision)fail('FLOW_CONTEXT_CHANGED',409);
    const eligible=(await tx.query<{ready:boolean}>('SELECT expires_at<=clock_timestamp()+interval \'6 hours\' AS ready FROM flow_delegation_credentials WHERE organization_id=$1 AND id=$2',[access.organizationId,c.r.credential_id])).rows[0];if(!eligible?.ready)fail('FLOW_INSTALLATION_RENEW_TOO_EARLY',409);
    const callback=vault.open({organizationId:access.organizationId,id,generation:1,purpose:'FLOW_INSTALLATION_CALLBACK'},{encrypted:g.host_callback_ciphertext!,keyVersion:g.host_callback_key_version!});
    const native=(await tx.query<{token_hash:string;callback_key_version:number}>(`SELECT cr.token_hash,r.callback_key_version FROM flow_delegation_credentials cr JOIN flow_native_registrations r ON r.organization_id=cr.organization_id AND r.credential_id=cr.id WHERE cr.organization_id=$1 AND cr.id=$2 AND r.id=$3`,[access.organizationId,c.r.credential_id,c.r.id])).rows[0]??fail();
    const previousCallback=registrationVault.open({organizationId:access.organizationId,registrationId:c.r.id,revision:c.r.revision,encrypted:c.r.callback_ciphertext!,keyVersion:native.callback_key_version});
    if(input.nativeCallbackCredential===callback||input.nativeCallbackCredential===access.token||input.nativeCallbackCredential===previousCallback||hash(input.nativeCallbackCredential)===native.token_hash)fail('FLOW_INSTALLATION_AUDIENCE_INVALID');return {g,r:c.r,tuple:c.tuple,callback,...reservation};});
   if(snapshot.replay)return snapshot.replay;
   if(!('callback' in snapshot))fail();
   await verify(snapshot,'RENEW',snapshot.callback);
   return options.transact(access.organizationId,async tx=>{let g=await readGrant(tx,access.organizationId,id);const auth={organizationId:access.organizationId,actorId:g.created_by,authVersion:g.issuer_auth_version},c=await current(tx,g,auth,true);g=await readGrant(tx,access.organizationId,id,true);
    if(g.token_hash!==hash(access.token)||g.generation!==input.expectedGeneration||c.r.id!==snapshot.r.id||c.r.revision!==snapshot.r.revision)fail('FLOW_CONTEXT_CHANGED',409);
    const token=fresh(),credentialId=randomUUID(),registrationId=randomUUID(),challengeId=randomUUID(),generation=g.generation+1;
    const credential=(await tx.query<{expires_at:Date;revision:number}>(`INSERT INTO flow_delegation_credentials(organization_id,id,token_hash,destination_origin,account_id,destination_revision,scopes,created_by,issuer_auth_version,expires_at)
     SELECT organization_id,$3,$4,destination_origin,account_id,destination_revision,scopes,created_by,issuer_auth_version,LEAST(clock_timestamp()+interval '24 hours',$5) FROM flow_delegation_credentials WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING expires_at,revision`,[access.organizationId,c.r.credential_id,credentialId,hash(token),g.expires_at])).rows[0]??fail();
    const tuple={...c.tuple,credentialId,credentialRevision:credential.revision};
    const ch=await repository.insert(tx,{organizationId:access.organizationId,id:challengeId,origin:g.destination_origin,tuple,nonceHash:hash(fresh()),verificationNonce:randomUUID(),actorId:c.r.created_by,authVersion:c.r.issuer_auth_version});if(!ch)fail();
    const cbDigest=hash(input.nativeCallbackCredential);if(!await repository.claim(tx,{organizationId:access.organizationId,id:challengeId,nonceHash:ch.transfer_nonce_hash,callbackDigest:cbDigest}))fail();
    await repository.revoke(tx,access.organizationId,c.r.id);
    const cbCipher=registrationVault.seal({organizationId:access.organizationId,registrationId,revision:1},input.nativeCallbackCredential);
    const registration=await repository.commit(tx,{organizationId:access.organizationId,id:challengeId,nonceHash:ch.transfer_nonce_hash,callbackDigest:cbDigest,registrationId,...cbCipher});if(!registration)fail();
    await tx.query('UPDATE flow_delegation_sessions SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND credential_id=$2 AND revoked_at IS NULL',[access.organizationId,c.r.credential_id]);
    await tx.query('UPDATE flow_delegation_credentials SET revoked_at=clock_timestamp(),revision=revision+1 WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL',[access.organizationId,c.r.credential_id]);
    const won=await tx.query("UPDATE flow_native_installation_grants SET generation=$3,current_credential_id=$4,current_registration_id=$5 WHERE organization_id=$1 AND id=$2 AND generation=$6 AND state='ACTIVE' AND expires_at>clock_timestamp() RETURNING id",[access.organizationId,id,generation,credentialId,registrationId,input.expectedGeneration]);if(!won.rows.length)fail('FLOW_CONTEXT_CHANGED',409);
    const response={id,generation,credential:{id:credentialId,token,revision:credential.revision,expiresAt:credential.expires_at.toISOString()},registration:{id:registrationId,revision:registration.revision,expiresAt:registration.expires_at.toISOString()},expiresAt:g.expires_at.toISOString()};
    await commitResponse(tx,g,snapshot.op,response,credentialId,registrationId);await audit(tx,{...g,generation,current_credential_id:credentialId,current_registration_id:registrationId},'FLOW_INSTALLATION_RENEWED');return response;});
  },
  async revokeAdministrative(principal:BrokerPrincipal,id:string){z.uuid().parse(id);return options.transact(principal.organizationId,async tx=>{await options.service.nativeRegistrationAdministrator(tx,principal);return revoke(tx,await readGrant(tx,principal.organizationId,id,true,true),principal);});},
  async revokeNative(access:FlowAccess,id:string,raw:unknown){z.uuid().parse(id);const input=InstallationRevokeSchema.parse(raw),requestDigest=installationReductionDigest(id,access.token,input);
   return options.transact(access.organizationId,async tx=>{
    const prior=(await tx.query<Operation&{grant_id:string}>(`SELECT *,recovery_expires_at>clock_timestamp() AS recovery_live FROM flow_native_installation_operations WHERE organization_id=$1 AND operation_nonce=$2 FOR UPDATE`,[access.organizationId,input.operationNonce])).rows[0];
    if(prior){if(prior.kind!=='REVOKE'||prior.grant_id!==id||prior.request_digest!==requestDigest)fail('FLOW_INSTALLATION_REPLAY_CHANGED',409);if(prior.state!=='COMMITTED'||!prior.recovery_live)fail('FLOW_INSTALLATION_RECOVERY_EXPIRED',409);return {revoked:true as const};}
    const g=await readGrant(tx,access.organizationId,id,true);if(g.state!=='ACTIVE'||g.token_hash!==hash(access.token))fail('FLOW_INSTALLATION_NOT_FOUND',404);if(g.generation!==input.expectedGeneration)fail('FLOW_CONTEXT_CHANGED',409);
    const result=await revoke(tx,g);
    await tx.query(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS now) INSERT INTO flow_native_installation_operations(organization_id,id,grant_id,operation_nonce,expected_generation,kind,request_digest,proof_nonce,state,previous_credential_id,previous_registration_id,created_at,committed_at,recovery_expires_at)
     SELECT $1,$2,$3,$4,$5,'REVOKE',$6,$7,'COMMITTED',$8,$9,moment.now,moment.now,moment.now+interval '5 minutes' FROM moment`,[access.organizationId,randomUUID(),id,input.operationNonce,g.generation,requestDigest,randomUUID(),g.current_credential_id,g.current_registration_id]);
    return result;
   });
  }
 };
}
