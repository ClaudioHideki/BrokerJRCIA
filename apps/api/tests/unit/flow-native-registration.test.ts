import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createNativeRegistrationVault,RegistrationTupleSchema,createNativeRegistrationRepository} from '../../src/modules/flows/delegation/registration/core.js';
const key=Buffer.alloc(32,7).toString('base64');
it('seals only callback authority under existing AEAD engine and isolates tenant, registration and revision',()=>{
 const vault=createNativeRegistrationVault(JSON.stringify({1:key})),context={organizationId:randomUUID(),registrationId:randomUUID(),revision:1},secret='k'.repeat(43);
 const sealed=vault.seal(context,secret);expect(sealed.encrypted).not.toContain(secret);expect(vault.open({...context,...sealed})).toBe(secret);
 for(const changed of [{organizationId:randomUUID()},{registrationId:randomUUID()},{revision:2},{keyVersion:2}])expect(()=>vault.open({...context,...sealed,...changed})).toThrow('FLOW_NATIVE_CALLBACK_UNAVAILABLE');
 expect(()=>createIntegrationSecrets(key).decrypt(`${context.organizationId}:GENERIC_JSON:${context.registrationId}:key-1`,sealed.encrypted)).toThrow();
 expect(()=>vault.seal(context,'short')).toThrow();
});
it('retains explicit old key versions across vault rotation without weakening callback purpose',()=>{
 const context={organizationId:randomUUID(),registrationId:randomUUID(),revision:1},secret='r'.repeat(43),old=createNativeRegistrationVault(JSON.stringify({1:key})).seal(context,secret);
 const rotated=createNativeRegistrationVault(JSON.stringify({1:key,2:Buffer.alloc(32,8).toString('base64')}));
 expect(rotated.open({...context,...old})).toBe(secret);expect(rotated.seal(context,secret).keyVersion).toBe(2);
});
it('strict registration tuple rejects authority fields, duplicates and invalid revisions while preserving CENTRAL',()=>{
 const target={integrationId:randomUUID(),channelId:randomUUID(),inboxId:9,transport:'CENTRAL_TRANSPORT',provider:null};
 const tuple={credentialId:randomUUID(),credentialRevision:1,destinationRevision:2,accountCredentialVersion:3,accountId:7,targets:[target]};
 expect(RegistrationTupleSchema.parse(tuple)).toEqual(tuple);
 for(const bad of [{...tuple,organizationId:randomUUID()},{...tuple,credentialRevision:0},{...tuple,targets:[target,target]},{...tuple,targets:[{...target,transport:'QR'}]},{...tuple,targets:[{...target,role:'administrator'}]}])expect(()=>RegistrationTupleSchema.parse(bad)).toThrow();
});
it('repository claims one pending challenge with a durable fixed nonce and rejects a concurrent second verification',async()=>{
 const repository=createNativeRegistrationRepository(),org=randomUUID(),id=randomUUID(),nonce=randomUUID();let state='PENDING';
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const tx={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});const won=state==='PENDING';if(won)state='VERIFYING';return {rows:won?[{id,verification_nonce:nonce,state}]:[],rowCount:won?1:0};}};
 const result=await repository.claim(tx as never,{organizationId:org,id,nonceHash:'a'.repeat(64),callbackDigest:'b'.repeat(64)});
 expect(result).toMatchObject({verification_nonce:nonce,state:'VERIFYING'});
 expect(await repository.claim(tx as never,{organizationId:org,id,nonceHash:'a'.repeat(64),callbackDigest:'b'.repeat(64)})).toBeNull();
 expect(calls[0]!.sql).toContain("state='PENDING'");expect(calls[0]!.sql).toContain('expires_at>clock_timestamp()');expect(calls[0]!.values).toEqual([org,id,'a'.repeat(64),'b'.repeat(64)]);
 expect(calls[0]!.sql).not.toMatch(/SET\s+verification_nonce/);
});
it('repository revocation clears callback ciphertext and increments revision without deleting tombstones',async()=>{
 let seen='';const repository=createNativeRegistrationRepository(),org=randomUUID(),id=randomUUID();
 const result=await repository.revoke({query:async(sql:string,values:unknown[])=>{seen=sql;expect(values).toEqual([org,id]);return {rows:[{id}],rowCount:1};}} as never,org,id);
 expect(result).toBe(true);expect(seen).toContain('callback_ciphertext=NULL');expect(seen).toContain('revision=revision+1');expect(seen).not.toContain('DELETE');
});
