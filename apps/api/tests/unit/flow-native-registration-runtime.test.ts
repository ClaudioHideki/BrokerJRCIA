import {expect,it} from 'vitest';
import {registrationFixture} from './flow-native-registration-fixture.js';
import {createNativeRegistrationRuntime} from '../../src/modules/flows/delegation/registration/runtime.js';
it('resolves only current dedicated persisted callback authority and fails after credential or registration revocation',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input),created=await h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)});
 const runtime=createNativeRegistrationRuntime({service:h.nativeService,keyring:JSON.stringify({1:Buffer.alloc(32,9).toString('base64')}),transact:async(org,work)=>{expect(org).toBe(h.org);return work({query:h.query} as never);}});
 const context={organizationId:h.org,origin:h.credential.destination_origin};
 expect(await runtime.resolveRegistration(context,new AbortController().signal)).toEqual({...context,accountId:7,destinationRevision:3,revision:1,callbackCredential:'x'.repeat(43),expiresAt:h.expires.toISOString()});
 h.revokeCredential();await expect(runtime.resolveRegistration(context,new AbortController().signal)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 await h.service.revoke(h.principal,created.id);expect(await runtime.resolveRegistration(context,new AbortController().signal)).toBeNull();
});
it('never decrypts a stored callback into another tenant/origin or changed credential revision',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);await h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)});
 const runtime=createNativeRegistrationRuntime({service:h.nativeService,keyring:JSON.stringify({1:Buffer.alloc(32,9).toString('base64')}),transact:async(_org,work)=>work({query:h.query} as never)});
 await expect(runtime.resolveRegistration({organizationId:h.org,origin:'https://other.example.test'},new AbortController().signal)).rejects.toThrow();
 h.getRegistration().credential_revision=99;await expect(runtime.resolveRegistration({organizationId:h.org,origin:h.credential.destination_origin},new AbortController().signal)).rejects.toThrow();
});
