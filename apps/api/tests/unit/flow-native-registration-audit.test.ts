import {expect,it} from 'vitest';
import {registrationFixture} from './flow-native-registration-fixture.js';
it('records metadata-only challenge issue, registration commit/revoke and cancel inside their transactions',async()=>{
 const h=registrationFixture(),challenge=await h.service.issue(h.principal,h.input);
 const registered=await h.service.complete(h.access,challenge.transferNonce,{challengeId:challenge.challengeId,callbackCredential:'x'.repeat(43)});
 await h.service.revoke(h.principal,registered.id);await h.service.cancel(h.principal,challenge.challengeId);
 const audits=h.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO audit_logs')).map(([,values])=>values);
 expect(audits.map(values=>values[2])).toEqual(['FLOW_NATIVE_REGISTRATION_CHALLENGE_ISSUED','FLOW_NATIVE_REGISTRATION_COMMITTED','FLOW_NATIVE_REGISTRATION_REVOKED','FLOW_NATIVE_REGISTRATION_CHALLENGE_CANCELED']);
 for(const audit of audits){expect(audit[0]).toBe(h.org);expect(JSON.stringify(audit)).not.toContain('x'.repeat(43));expect(JSON.stringify(audit)).not.toContain(challenge.transferNonce);expect(JSON.stringify(audit)).not.toContain(h.token);}
 expect(audits[1]![1]).toBeNull();expect(JSON.parse(audits[1]![6])).toMatchObject({actorKind:'JRC_NATIVE',challengeId:challenge.challengeId,revision:1});
});
