import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {registrationFixture} from './flow-native-registration-fixture.js';
it('issues SQL-limited challenge and completes exact callback registration without extending native credential expiry',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);
 expect(challenge).toMatchObject({expiresAt:h.getChallenge().expires_at.toISOString(),context:{credentialId:h.credential.id,credentialRevision:2}});
 const callbackCredential='x'.repeat(43),created=await h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential});
 expect(created).toMatchObject({revision:1,expiresAt:h.expires.toISOString(),challengeId:challenge.challengeId});expect(h.getChallenge().state).toBe('COMMITTED');
 expect(h.callback).toHaveBeenCalledTimes(1);expect(h.callback.mock.calls[0]![0]).toMatchObject({nonce:h.getChallenge().verification_nonce,accountId:7,credentialRevision:2});
 expect(JSON.stringify(created)).not.toContain(callbackCredential);expect(h.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO flow_native_registrations'))![1][8]).not.toContain(callbackCredential);
});
it('refuses concurrent/replayed completion and observes the same committed handle after response loss',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);let release!:()=>void;h.callback.mockImplementationOnce(async request=>{await new Promise<void>(resolve=>{release=resolve;});return {...request,authorized:true};});
 const first=h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)});
 await vi.waitFor(()=>expect(h.callback).toHaveBeenCalledTimes(1));
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'y'.repeat(43)})).rejects.toMatchObject({code:'FLOW_REGISTRATION_IN_PROGRESS'});
 release();const created=await first;
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)})).rejects.toMatchObject({code:'FLOW_REGISTRATION_CHALLENGE_CONSUMED'});
 expect(await h.service.read(h.access,challenge.challengeId,challenge.transferNonce)).toMatchObject({state:'COMMITTED',registration:{id:created.id,revision:1}});expect(h.callback).toHaveBeenCalledTimes(1);
});
it('rechecks current issuer after callback IO and never commits after authority loss',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);h.callback.mockImplementationOnce(async request=>{h.revokeCredential();return {...request,authorized:true};});
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});expect(h.getRegistration()).toBeNull();
});
it('refuses wrong nonce, caller authority injection and callback/outbound key reuse',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);
 await expect(h.service.read(h.access,challenge.challengeId,'q'.repeat(43))).rejects.toMatchObject({code:'FLOW_REGISTRATION_CHALLENGE_NOT_FOUND'});
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:h.token})).rejects.toThrow();
 await expect(h.service.issue(h.principal,{...h.input,organizationId:randomUUID()})).rejects.toThrow();expect(h.callback).not.toHaveBeenCalled();
});
it('derives challenge creation and five-minute expiry from one SQL clock instant',async()=>{
 const h=registrationFixture();await h.service.issue(h.principal,h.input);
 const sql=h.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO flow_native_registration_challenges'))![0];
 expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1);
 expect(sql).toContain("LEAST(moment.now+interval '5 minutes',c.expires_at)");
});
it('rejects a challenge whose stored approved origin no longer matches canonical authority',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);h.getChallenge().destination_origin='https://other.example.test';
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)})).rejects.toMatchObject({code:'FLOW_CONTEXT_CHANGED'});expect(h.callback).not.toHaveBeenCalled();
});
it('cancels an in-flight callback before commit and prevents recovery from reactivating it',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);
 h.callback.mockImplementationOnce(async request=>{await h.service.cancel(h.principal,challenge.challengeId);return {...request,authorized:true};});
 await expect(h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)})).rejects.toMatchObject({code:'FLOW_REGISTRATION_CHALLENGE_NOT_FOUND'});expect(h.getRegistration()).toBeNull();
 await expect(h.service.read(h.access,challenge.challengeId,challenge.transferNonce)).rejects.toMatchObject({code:'FLOW_REGISTRATION_CHALLENGE_NOT_FOUND'});
});
it('revokes callback ciphertext under current admin even after credential expiry, with foreign IDs generic',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input),registration=await h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)});
 h.revokeCredential();expect(await h.service.revoke(h.principal,registration.id)).toEqual({revoked:true});
 await expect(h.service.revoke(h.principal,randomUUID())).rejects.toMatchObject({code:'FLOW_REGISTRATION_NOT_FOUND'});
 h.setIssuerRole('OPERATOR');await expect(h.service.revoke(h.principal,registration.id)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
