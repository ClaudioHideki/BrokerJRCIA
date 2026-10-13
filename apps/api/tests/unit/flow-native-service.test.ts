import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './flow-native-service-fixture.js';
beforeEach(()=>{vi.clearAllMocks();});
it('returns authoritative SQL expiry from actual native issuance service without changing the five-minute SQL cap',async()=>{
 const h=serviceFixture(),result=await h.service.issueNativeSession(h.access,h.input);
 expect(result).toMatchObject({expiresAt:h.expires.toISOString()});
 const insert=h.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO flow_delegation_sessions('))![0];
 expect(insert).toContain("moment.now+interval '5 minutes'");expect(insert).toContain('RETURNING expires_at');
});
it('denies issuance when current host authority is revoked',async()=>{
 const h=serviceFixture();h.revokeHostMembership();await expect(h.service.issueNativeSession(h.access,h.input)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
it('denies issuance when the original Broker issuer loses administrator authority',async()=>{
 const h=serviceFixture();h.setIssuerRole('OPERATOR');await expect(h.service.issueNativeSession(h.access,h.input)).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 expect(h.adapter.introspect).not.toHaveBeenCalled();
});
it('allows exact native actor cleanup after host membership loss without introspection or runtime mutation',async()=>{
 const h=serviceFixture(),issued=await h.service.issueNativeSession(h.access,h.input);h.revokeHostMembership();h.adapter.introspect.mockClear();h.query.mockClear();
 expect(await h.service.revokeNativeSession(h.access,issued.id,{externalActorId:h.input.externalActorId,nonce:h.nonce})).toEqual({revoked:true});
 expect(h.adapter.introspect).not.toHaveBeenCalled();expect(h.query.mock.calls.filter(([sql])=>/^(UPDATE|INSERT|DELETE)/.test(sql)).every(([sql])=>sql.startsWith('UPDATE flow_delegation_sessions SET revoked_at')||sql.startsWith('INSERT INTO audit_logs'))).toBe(true);
});
it.each(['actor','nonce','credential','revision','account','kind'])('rejects foreign native cleanup identity: %s',async field=>{
 const h=serviceFixture(),issued=await h.service.issueNativeSession(h.access,h.input),session=h.getSession();
 const changed={actor:{external_actor_id:'22'},nonce:{nonce:randomUUID()},credential:{credential_id:randomUUID()},revision:{credential_revision:1},account:{account_id:'8'},kind:{actor_kind:'BROKER'}}[field]!;
 h.setSession({...session,...changed});h.query.mockClear();
 await expect(h.service.revokeNativeSession(h.access,issued.id,{externalActorId:h.input.externalActorId,nonce:h.nonce})).rejects.toMatchObject({code:'FLOW_SESSION_NOT_FOUND'});
 expect(h.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
});
it('does not let an expired/revoked credential revoke or issue through a fallback audience',async()=>{
 const h=serviceFixture(),issued=await h.service.issueNativeSession(h.access,h.input);h.revokeCredential();
 await expect(h.service.revokeNativeSession(h.access,issued.id,{externalActorId:h.input.externalActorId,nonce:h.nonce})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
it('audits successful native session issuance with metadata only and no token or nonce',async()=>{
 const h=serviceFixture(),issued=await h.service.issueNativeSession(h.access,h.input);
 const audit=h.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO audit_logs'));
 expect(audit).toHaveLength(1);expect(audit[0]![0]).toContain('FLOW_NATIVE_SESSION_ISSUED');
 expect(JSON.stringify(audit)).not.toContain(issued.token);expect(JSON.stringify(audit)).not.toContain(h.token);expect(JSON.stringify(audit)).not.toContain(h.nonce);
});
