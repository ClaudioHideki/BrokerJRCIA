import {expect,it,vi} from 'vitest';
import {candidateConversationEffect,effectControlChainMatches,remoteInteger} from '../../src/modules/automations/conversation-effect-proof.js';
it('normalizes canonical PostgreSQL bigint IDs without truncation',()=>{
 expect(remoteInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
 for(const value of ['0','01','1.5','9007199254740992',null])expect(()=>remoteInteger(value)).toThrow();
});
it('requires an exact contiguous chain of this effect and confirmed observations',()=>{
 const steps=[{before_revision:5,after_revision:6,proven:true},{before_revision:6,after_revision:7,proven:true}];
 expect(effectControlChainMatches(5,7,steps)).toBe(true);
 expect(effectControlChainMatches(5,8,steps)).toBe(false);
 expect(effectControlChainMatches(5,7,[steps[0]!,{...steps[1]!,proven:false}])).toBe(false);
 expect(effectControlChainMatches(5,7,[steps[1]!])).toBe(false);
 expect(effectControlChainMatches(5,5,[])).toBe(true);
});
it('does not cast malformed effect metadata to a database UUID',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[],rowCount:0});
 const tx={query} as unknown as Parameters<typeof candidateConversationEffect>[0];
 const scope={organizationId:'11111111-2222-4333-8444-555555555555'} as Parameters<typeof candidateConversationEffect>[1];
 const event={kind:'HUMAN_PRIVATE' as const,remoteConversationId:11,remoteMessageId:12,senderId:13,mayForwardReply:false,interruptsBot:true};
 for(const id of ['-'.repeat(36),'a'.repeat(36),'11111111-2222-4333-7444-555555555555']){
  expect(await candidateConversationEffect(tx,scope,event,{content_attributes:{jrc_flow_effect_organization_id:scope.organizationId,jrc_flow_effect_id:id}})).toBeNull();
 }
 expect(query).not.toHaveBeenCalled();
});
