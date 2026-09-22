import { describe, expect, it, vi } from 'vitest';
import { createOutboxDispatcher } from '../../src/modules/automations/service.js';
import type { AutomationRepository, OutboxRow } from '../../src/modules/automations/repository.js';

const item:OutboxRow={id:'11111111-1111-4111-8111-111111111111',organizationId:'22222222-2222-4222-8222-222222222222',executionId:'33333333-3333-4333-8333-333333333333',channelId:'44444444-4444-4444-8444-444444444444',conversationId:'55555555-5555-4555-8555-555555555555',nodeId:'send',ordinal:0,kind:'SEND_TEXT',payload:{text:'Olá'},attempts:1,leaseToken:'66666666-6666-4666-8666-666666666666'};
describe('automation durable outbox',()=>{
  it('leaves an uncertain side effect UNKNOWN and never retries it blindly',async()=>{
    let available:OutboxRow|null=item;const settle=vi.fn();const repository=new Proxy({}, {get:(_target,key)=>key==='claimOutbox'?async()=>{const value=available;available=null;return value}:key==='settleOutbox'?settle:vi.fn()}) as AutomationRepository;
    const dispatch=vi.fn().mockRejectedValue(new Error('lost response')),worker=createOutboxDispatcher({repository,transact:async(_org,work)=>work({} as never)},{dispatch});
    expect(await worker.runOnce(item.organizationId)).toMatchObject({status:'UNKNOWN'});expect(settle).not.toHaveBeenCalled();
    expect(await worker.runOnce(item.organizationId)).toEqual({processed:false});expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('requeues only a definitively not-sent effect',async()=>{
    const settle=vi.fn().mockResolvedValue(true),repository=new Proxy({}, {get:(_target,key)=>key==='claimOutbox'?async()=>item:key==='settleOutbox'?settle:vi.fn()}) as AutomationRepository;
    const retryAt=new Date('2030-01-01T00:00:00Z'),worker=createOutboxDispatcher({repository,transact:async(_org,work)=>work({} as never)},{dispatch:async()=>({kind:'NOT_SENT',error:'timeout before write',retryAt})});
    await worker.runOnce(item.organizationId);expect(settle).toHaveBeenCalledWith(expect.anything(),item.organizationId,item.id,expect.any(String),{status:'PENDING',error:'timeout before write',availableAt:retryAt});
  });
});
