import { describe,expect,it,vi } from 'vitest';
import { createAutomationEffectDispatcher } from '../../src/commands/automation-worker.js';
import type { OutboxRow } from '../../src/modules/automations/repository.js';
const item={id:'effect',organizationId:'tenant',executionId:'execution',channelId:'channel',conversationId:'conversation',nodeId:'h',ordinal:0,kind:'HANDOFF',payload:{handoffVersion:1},attempts:1,leaseToken:'lease'} as OutboxRow;
function setup(handoff?:{dispatch:ReturnType<typeof vi.fn>}){
  const messaging={setConversationMode:vi.fn(),enqueueOutgoing:vi.fn(async()=>({message:{id:'queued'}}))};
  const query=vi.fn(async()=>({rowCount:1,rows:[{transport:'BROKER_TRANSPORT'}]}));
  const dispatcher=createAutomationEffectDispatcher({transact:async(_org,work)=>work({query} as never),messaging:messaging as never,...(handoff?{handoff}:{})});
  return {dispatcher,messaging};
}
describe('automation worker native handoff dispatch',()=>{
  it('delegates to durable remote handoff and never fabricates success from local HUMAN mode',async()=>{
    const dispatch=vi.fn(async()=>({kind:'SENT' as const,remoteReference:'chatwoot-handoff:confirmed'}));
    const h=setup({dispatch});await expect(h.dispatcher.dispatch(item)).resolves.toEqual({kind:'SENT',remoteReference:'chatwoot-handoff:confirmed'});
    expect(dispatch).toHaveBeenCalledWith(item);expect(h.messaging.setConversationMode).not.toHaveBeenCalled();
  });
  it('preserves remote uncertainty instead of converting a thrown handoff into a retry',async()=>{
    const dispatch=vi.fn(async()=>{throw new Error('HANDOFF_REMOTE_OUTCOME_UNKNOWN')});
    await expect(setup({dispatch}).dispatcher.dispatch(item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
  });
  it('pauses locally but fails actionably when the integration runtime is not configured',async()=>{
    const h=setup();await expect(h.dispatcher.dispatch(item)).resolves.toEqual({kind:'FAILED',error:'AUTOMATION_HANDOFF_UNAVAILABLE'});
    expect(h.messaging.setConversationMode).toHaveBeenCalledWith(expect.anything(),{organizationId:'tenant',conversationId:'conversation',mode:'HUMAN'});
  });
  it('preserves normal text queueing',async()=>{
    const h=setup();expect(await h.dispatcher.dispatch({...item,kind:'SEND_TEXT',payload:{text:'Oi'}})).toEqual({kind:'SENT',remoteReference:'queued'});
    expect(h.messaging.enqueueOutgoing).toHaveBeenCalledOnce();
  });
});
