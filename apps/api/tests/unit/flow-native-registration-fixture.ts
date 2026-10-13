import {expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './flow-native-service-fixture.js';
import {createNativeRegistrationService} from '../../src/modules/flows/delegation/registration/service.js';
import {createNativeRegistrationVault} from '../../src/modules/flows/delegation/registration/core.js';
export function registrationFixture(){
 const h=serviceFixture();let challenge:any=null,registration:any=null;const original=h.query;
 const query=vi.fn(async(sql:string,values:any[]=[])=>{
  const result=(rows:any[]=[])=>({rows,rowCount:rows.length});
  if(sql.includes('INSERT INTO flow_native_registration_challenges')){challenge={organization_id:h.org,id:values[1],credential_id:values[2],credential_revision:values[3],destination_origin:values[4],account_id:values[5],destination_revision:values[6],account_credential_version:values[7],transfer_nonce_hash:values[8],verification_nonce:values[9],tuple:JSON.parse(values[10]),created_by:values[11],issuer_auth_version:values[12],expires_at:new Date(Date.now()+120000),state:'PENDING',revoked_at:null,registration_id:null,callback_digest:null};return result([challenge]);}
  if(sql.startsWith('INSERT INTO flow_native_registration_targets'))return result([]);
  if(sql.startsWith('SELECT * FROM flow_native_registration_challenges'))return result(challenge&&!challenge.revoked_at&&values[1]===challenge.id&&values[2]===challenge.transfer_nonce_hash?[challenge]:[]);
  if(sql.startsWith('UPDATE flow_native_registration_challenges SET revoked_at')){if(!challenge||values[1]!==challenge.id)return result();challenge.revoked_at=new Date();challenge.state=challenge.state==='COMMITTED'?'COMMITTED':'CANCELED';return result([{id:challenge.id}]);}
  if(sql.startsWith('UPDATE flow_native_registrations SET callback_ciphertext')){if(!registration||values[1]!==registration.id)return result();registration.revoked_at=new Date();return result([{id:registration.id}]);}
  if(sql.startsWith('UPDATE flow_native_registration_challenges SET state=\'CANCELED\''))return result([]);
  if(sql.startsWith('SELECT id FROM flow_native_registrations'))return result(registration&&values[1]===registration.id?[{id:registration.id}]:[]);
  if(sql.startsWith('UPDATE flow_native_registration_challenges SET state=\'VERIFYING\'')){if(challenge?.state!=='PENDING')return result();challenge.state='VERIFYING';challenge.callback_digest=values[3];return result([{...challenge}]);}
  if(sql.startsWith('UPDATE flow_native_registration_challenges SET state=\'COMMITTED\'')){if(challenge?.state!=='VERIFYING')return result();challenge.state='COMMITTED';challenge.registration_id=values[3];return result([{...challenge}]);}
  if(sql.startsWith('INSERT INTO flow_native_registrations')){registration={organization_id:h.org,id:values[1],challenge_id:values[2],credential_id:values[3],credential_revision:values[4],destination_origin:values[5],account_id:values[6],destination_revision:values[7],callback_ciphertext:values[8],callback_key_version:values[9],callback_purpose:'FLOW_NATIVE_CALLBACK',account_credential_version:values[10],created_by:values[11],issuer_auth_version:values[12],revision:1,expires_at:h.expires,revoked_at:null};return result([registration]);}
  if(sql.startsWith('SELECT r.*,ch.tuple FROM flow_native_registrations'))return result(registration&&!registration.revoked_at?[{...registration,tuple:challenge.tuple}]:[]);
  if(sql.startsWith('SELECT * FROM flow_native_registrations'))return result(registration&&!registration.revoked_at?[registration]:[]);
  if(sql.startsWith('SELECT id,revision,expires_at FROM flow_native_registrations'))return result(registration?[registration]:[]);
  return original(sql,values);
 });
 const authority=vi.fn((tx:any,auth:any,credentialId:string,ids:string[])=>h.service.nativeRegistrationAuthority(tx,auth,credentialId,ids));
 const callback=vi.fn(async(request:any)=>({...request,authorized:true}));
 const service=createNativeRegistrationService({transact:async(org,work)=>{expect(org).toBe(h.org);return work({query} as never);},authority,authorizeAdministrator:(tx,principal)=>h.service.nativeRegistrationAdministrator(tx,principal),vault:createNativeRegistrationVault(JSON.stringify({1:Buffer.alloc(32,9).toString('base64')})),verifyHost:callback});
 return {...h,nativeService:h.service,query,service,callback,authority,principal:{organizationId:h.org,actorId:h.actor,authVersion:5},getChallenge:()=>challenge,getRegistration:()=>registration,input:{credentialId:h.credential.id,expectedCredentialRevision:2,expectedDestinationRevision:3,expectedAccountCredentialVersion:4,integrationIds:[h.mapping.integration_id]}};
}
