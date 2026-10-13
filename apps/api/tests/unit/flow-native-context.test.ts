import {expect,it} from 'vitest';
import {serviceFixture} from './flow-native-service-fixture.js';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
it('reads SQL credential expiry and canonical CENTRAL/BROKER targets without host introspection or native proof',async()=>{
 const h=serviceFixture();h.setMappings([{...h.mapping,integration_id:uuid(1)},{...h.mapping,integration_id:uuid(2),transport:'BROKER_TRANSPORT',provider:'BAILEYS'}]);
 const value=await h.service.nativeContext(h.access,{});
 expect(value).toEqual({credential:{id:h.credential.id,revision:2,expiresAt:h.expires.toISOString(),scopes:['flow:read']},destination:{organizationId:h.org,origin:h.credential.destination_origin,accountId:7,destinationRevision:3,accountCredentialVersion:4},targets:[{integrationId:uuid(1),channelId:h.mapping.channel_id,accountId:7,inboxId:9,transport:'CENTRAL_TRANSPORT',provider:null},{integrationId:uuid(2),channelId:h.mapping.channel_id,accountId:7,inboxId:9,transport:'BROKER_TRANSPORT',provider:'BAILEYS'}],nextCursor:null});
 expect(h.adapter.introspect).not.toHaveBeenCalled();expect(JSON.stringify(value)).not.toMatch(/encrypted|token|ready|installed|fence/i);
 expect(h.query.mock.calls.filter(([sql])=>sql.includes('clock_timestamp() AS live')).length).toBe(2);
});
it('paginates more than 100 targets by validated integrationId cursor without truncation',async()=>{
 const h=serviceFixture();h.setMappings(Array.from({length:102},(_,n)=>({...h.mapping,integration_id:uuid(n+1)})));
 const first=await h.service.nativeContext(h.access,{});expect(first.targets).toHaveLength(100);expect(first.nextCursor).toBe(uuid(100));
 const second=await h.service.nativeContext(h.access,{cursor:first.nextCursor,limit:100});expect(second.targets.map(t=>t.integrationId)).toEqual([uuid(101),uuid(102)]);expect(second.nextCursor).toBeNull();
 const sql=h.query.mock.calls.find(([sql])=>sql.startsWith('SELECT c.id FROM chatwoot_connections'))!;expect(sql[0]).toContain('ORDER BY c.id LIMIT $3');expect(sql[1]).toEqual([h.org,null,101]);
 expect(sql[0]).toContain("c.status='READY'");expect(sql[0]).toContain('m.deleting_at IS NULL');expect(sql[0]).toContain('i.archived_at IS NULL');
});
it('supports empty targets and rejects malformed cursor, authority overrides and invalid page sizes before IO',async()=>{
 const h=serviceFixture();for(const input of [{cursor:'anything'},{limit:0},{limit:101},{organizationId:h.org},{accountId:7},{integrationIds:[h.mapping.integration_id]}])await expect(h.service.nativeContext(h.access,input)).rejects.toThrow();
 expect(h.query).not.toHaveBeenCalled();h.setMappings([]);expect(await h.service.nativeContext(h.access,{limit:1})).toMatchObject({targets:[],nextCursor:null});
});
it('rejects expired credentials, changed destination and mismatched canonical Account mappings',async()=>{
 const expired=serviceFixture();expired.revokeCredential();await expect(expired.service.nativeContext(expired.access,{})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
 const changed=serviceFixture();changed.credential.destination_revision=99;await expect(changed.service.nativeContext(changed.access,{})).rejects.toMatchObject({code:'FLOW_CONTEXT_CHANGED'});
 const foreign=serviceFixture();foreign.setMappings([{...foreign.mapping,account_id:'8'}]);await expect(foreign.service.nativeContext(foreign.access,{})).rejects.toMatchObject({code:'FLOW_CONTEXT_CHANGED'});
 const issuer=serviceFixture();issuer.setIssuerRole('OPERATOR');await expect(issuer.service.nativeContext(issuer.access,{})).rejects.toMatchObject({code:'FLOW_ACCESS_DENIED'});
});
