import { expect,it,vi } from 'vitest';
import { isExpectedHandoffOpening } from '../../src/modules/attendance/handoff-expected-control.js';
const scope={organizationId:'a',channelId:'b',integrationId:'c',destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9};
const control={conversation_id:'d',remote_conversation_id:'11',cycle:1,revision:2};
const event={kind:'CONVERSATION_CONTROL' as const,remoteConversationId:11,remoteUpdatedAt:1,status:'open' as const,assignee:{kind:'NONE' as const},teamId:null,mayForwardReply:false as const,interruptsBot:true};
it('recognizes only a persisted in-flight opening state, never a payload echo marker',async()=>{
  const query=vi.fn(async()=>({rows:[{id:'operation'}],rowCount:1}));
  expect(await isExpectedHandoffOpening({query} as never,scope,event,control)).toBe(true);
  expect(query.mock.calls[0]?.[0]).toContain("h.phase IN ('OPEN_DISPATCHED','OPENED','ASSIGNMENT_DISPATCHED')");
  expect(query.mock.calls[0]?.[0]).toContain('o.lease_expires_at>now()');
  expect(query.mock.calls[0]?.[0]).toContain("snapshot->>'controlRevision'");
});
it.each([
  {...event,status:'pending'}, {...event,status:'resolved'}, {...event,teamId:3},
  {...event,assignee:{kind:'HUMAN',id:2}}, {...event,assignee:{kind:'EXTERNAL_BOT',id:2}},
  {...event,assignee:{kind:'UNKNOWN'}}, {...event,remoteConversationId:12},
  {kind:'HUMAN_PUBLIC',remoteConversationId:11,remoteMessageId:8,mayForwardReply:true,interruptsBot:true},
  {kind:'HUMAN_PRIVATE',remoteConversationId:11,remoteMessageId:8,mayForwardReply:false,interruptsBot:true},
])('never suppresses human/differing control %j',async candidate=>{
  const query=vi.fn();expect(await isExpectedHandoffOpening({query} as never,scope,candidate as never,control)).toBe(false);expect(query).not.toHaveBeenCalled();
});
it('does not suppress an expired, revoked, foreign-cycle or absent operation',async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0}));expect(await isExpectedHandoffOpening({query} as never,scope,event,control)).toBe(false);
});
