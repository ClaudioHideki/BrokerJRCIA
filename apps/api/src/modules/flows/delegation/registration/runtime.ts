import type {OrganizationTransaction} from '../../../../db/tenant-transaction.js';
import {FlowDelegationError,type createFlowDelegationService} from '../service.js';
import type {NativeAdapterOptions} from '../native-adapter.js';
import {createNativeRegistrationService} from './service.js';
import {createNativeRegistrationVerifier} from './adapter.js';
import {createNativeRegistrationVault,RegistrationTupleSchema} from './core.js';
interface RegistrationRow {id:string;organization_id:string;destination_origin:string;account_id:string;destination_revision:number;account_credential_version:number;credential_id:string;credential_revision:number;revision:number;callback_ciphertext:string;callback_key_version:number;callback_purpose:string;created_by:string;issuer_auth_version:number;expires_at:Date;tuple:unknown}
export function createNativeRegistrationRuntime(options:{service:ReturnType<typeof createFlowDelegationService>;keyring:string;transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}){
 const vault=createNativeRegistrationVault(options.keyring);
 const registration=createNativeRegistrationService({transact:options.transact,authority:options.service.nativeRegistrationAuthority,authorizeAdministrator:options.service.nativeRegistrationAdministrator,vault,verifyHost:createNativeRegistrationVerifier()});
 const resolveRegistration:NativeAdapterOptions['resolveRegistration']=async(context,signal)=>{
  signal.throwIfAborted();return options.transact(context.organizationId,async tx=>{
   const row=(await tx.query<RegistrationRow>(`SELECT r.*,ch.tuple FROM flow_native_registrations r JOIN flow_native_registration_challenges ch ON ch.organization_id=r.organization_id AND ch.id=r.challenge_id
    WHERE r.organization_id=$1 AND r.destination_origin=$2 AND r.revoked_at IS NULL AND r.expires_at>clock_timestamp()`,[context.organizationId,context.origin])).rows[0];
   if(!row)return null;
   if(row.organization_id!==context.organizationId||row.destination_origin!==context.origin||row.callback_purpose!=='FLOW_NATIVE_CALLBACK')throw new FlowDelegationError('FLOW_CONTEXT_CHANGED',409);
   const tuple=RegistrationTupleSchema.parse(row.tuple),current=await options.service.nativeRegistrationAuthority(tx,{organizationId:context.organizationId,actorId:row.created_by,authVersion:row.issuer_auth_version},row.credential_id,tuple.targets.map(t=>t.integrationId));
   if(current.origin!==row.destination_origin||JSON.stringify(RegistrationTupleSchema.parse(current.tuple))!==JSON.stringify(tuple)||tuple.credentialRevision!==row.credential_revision||tuple.accountId!==Number(row.account_id)||tuple.destinationRevision!==row.destination_revision||tuple.accountCredentialVersion!==row.account_credential_version)throw new FlowDelegationError('FLOW_CONTEXT_CHANGED',409);
   // Canonical locks first, callback row second; re-read expiry at SQL time.
   const locked=(await tx.query<RegistrationRow>('SELECT * FROM flow_native_registrations WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',[context.organizationId,row.id])).rows[0];
   if(!locked||locked.revision!==row.revision||locked.callback_ciphertext!==row.callback_ciphertext||locked.callback_key_version!==row.callback_key_version)throw new FlowDelegationError('FLOW_CONTEXT_CHANGED',409);
   signal.throwIfAborted();const callbackCredential=vault.open({organizationId:context.organizationId,registrationId:row.id,revision:row.revision,encrypted:row.callback_ciphertext,keyVersion:row.callback_key_version});
   return {organizationId:context.organizationId,origin:context.origin,accountId:Number(row.account_id),destinationRevision:row.destination_revision,revision:row.revision,callbackCredential,expiresAt:row.expires_at.toISOString()};
  });
 };
 return {registration,resolveRegistration};
}
