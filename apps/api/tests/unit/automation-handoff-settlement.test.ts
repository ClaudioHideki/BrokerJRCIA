import { describe, expect, it, vi } from 'vitest';
import { createOutboxDispatcher, type OutboxDispatchResult } from '../../src/modules/automations/service.js';
import type { AutomationRepository, OutboxRow } from '../../src/modules/automations/repository.js';

const item:OutboxRow={id:'11111111-1111-4111-8111-111111111111',organizationId:'22222222-2222-4222-8222-222222222222',executionId:'33333333-3333-4333-8333-333333333333',channelId:'44444444-4444-4444-8444-444444444444',conversationId:'55555555-5555-4555-8555-555555555555',nodeId:'handoff',ordinal:1,kind:'HANDOFF',payload:{handoffVersion:2,destination:{kind:'LOCAL'}},attempts:1,leaseToken:'66666666-6666-4666-8666-666666666666'};
function harness(result:OutboxDispatchResult,kind:OutboxRow['kind']='HANDOFF',persisted=true,settled=false){
  const settleOutbox=vi.fn(async()=>settled),hasCommittedHandoffResult=vi.fn(async()=>persisted),resumeExecution=vi.fn(async()=>true);
  const repository=new Proxy({}, {get:(_target,key)=>key==='claimOutbox'?async(_tx:unknown,_org:string,leaseToken:string)=>({...item,kind,leaseToken}):key==='settleOutbox'?settleOutbox:key==='hasCommittedHandoffResult'?hasCommittedHandoffResult:key==='resumeExecution'?resumeExecution:vi.fn()}) as AutomationRepository;
  const worker=createOutboxDispatcher({repository,transact:async(_org,work)=>work({} as never)},{dispatch:async()=>result});
  return {worker,settleOutbox,hasCommittedHandoffResult,resumeExecution};
}
describe('already committed handoff settlement',()=>{
  it.each([
    {kind:'SENT',remoteReference:'local-handoff:'+item.id},
    {kind:'FAILED',error:'LOCAL_AGENT_UNAVAILABLE'},
  ] as const)('recognizes persisted $kind only after the ordinary CAS loses',async result=>{
    const h=harness(result);
    await expect(h.worker.runOnce(item.organizationId)).resolves.toMatchObject({processed:true,status:result.kind});
    expect(h.settleOutbox).toHaveBeenCalledOnce();
    expect(h.hasCommittedHandoffResult).toHaveBeenCalledOnce();
    expect(h.resumeExecution).not.toHaveBeenCalled();
  });
  it('does not consult terminal receipts when the ordinary CAS succeeds',async()=>{
    const h=harness({kind:'SENT',remoteReference:'receipt'},'HANDOFF',false,true);
    await expect(h.worker.runOnce(item.organizationId)).resolves.toMatchObject({status:'SENT'});
    expect(h.hasCommittedHandoffResult).not.toHaveBeenCalled();
  });
  it('rejects missing or incompatible persisted receipt and scope evidence',async()=>{
    const h=harness({kind:'SENT',remoteReference:'local-handoff:'+item.id},'HANDOFF',false);
    await expect(h.worker.runOnce(item.organizationId)).rejects.toThrow('AUTOMATION_EFFECT_SETTLEMENT_LOST');
  });
  it.each(['SEND_TEXT','IO_AI'] as const)('never accepts a lost %s CAS through handoff readback',async kind=>{
    const h=harness({kind:'SENT',remoteReference:'receipt'},kind);
    await expect(h.worker.runOnce(item.organizationId)).rejects.toThrow('AUTOMATION_EFFECT_SETTLEMENT_LOST');
    expect(h.hasCommittedHandoffResult).not.toHaveBeenCalled();
  });
  it.each(['SENT','FAILED'] as const)('rejects $kind with commit after a lost CAS even for HANDOFF',async kind=>{
    const commit=vi.fn(async()=>{});
    const result:OutboxDispatchResult=kind==='SENT'?{kind,commit,remoteReference:'receipt'}:{kind,commit,error:'FAILED'};
    const h=harness(result);
    await expect(h.worker.runOnce(item.organizationId)).rejects.toThrow('AUTOMATION_EFFECT_SETTLEMENT_LOST');
    expect(commit).toHaveBeenCalledOnce();
    expect(h.hasCommittedHandoffResult).not.toHaveBeenCalled();
  });
  it.each(['SENT','FAILED'] as const)('rejects $kind with resumePayload after a lost CAS even for HANDOFF',async kind=>{
    const resumePayload={outcome:'success'};
    const result:OutboxDispatchResult=kind==='SENT'?{kind,resumePayload,remoteReference:'receipt'}:{kind,resumePayload,error:'FAILED'};
    const h=harness(result);
    await expect(h.worker.runOnce(item.organizationId)).rejects.toThrow('AUTOMATION_EFFECT_SETTLEMENT_LOST');
    expect(h.resumeExecution).toHaveBeenCalledOnce();
    expect(h.hasCommittedHandoffResult).not.toHaveBeenCalled();
  });
  it('keeps uncertain handoffs UNKNOWN without checking terminal receipts',async()=>{
    const h=harness({kind:'UNKNOWN',error:'HANDOFF_REMOTE_OUTCOME_UNKNOWN'});
    await expect(h.worker.runOnce(item.organizationId)).resolves.toMatchObject({status:'UNKNOWN'});
    expect(h.settleOutbox).not.toHaveBeenCalled();
    expect(h.hasCommittedHandoffResult).not.toHaveBeenCalled();
  });
});
