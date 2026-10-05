import { describe, expect, it, vi } from 'vitest';
import type { AttendanceCatalog } from '@jrc/contracts';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import type { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
import type { AccountRow } from '../../src/modules/integrations/chatwoot-context.js';
import type { OutboxRow } from '../../src/modules/automations/repository.js';
import type { HandoffOperation, HandoffRepository } from '../../src/modules/attendance/handoff-types.js';
import { createNativeHandoffService } from '../../src/modules/attendance/handoff-service.js';

function fixture() {
  const events:string[]=[]; let locked=false,allowed=true,fresh=true;
  const operation:HandoffOperation={id:'operation',organizationId:'tenant-a',outboxId:'outbox',executionId:'execution',channelId:'channel',conversationId:'conversation',leaseToken:'lease',phase:'PREPARED',state:'PENDING',error:null,
    snapshot:{scope:{organizationId:'tenant-a',channelId:'channel',integrationId:'integration',destinationRevision:2,accountId:7,inboxId:9},origin:'https://central.example.test',credentialRevision:4,bindingId:'binding',bindingRevision:3,automationId:'automation',version:1,ownerRevision:5,controlRevision:8,sessionId:'session',sessionRevision:6,cycle:1,remoteConversationId:21,target:{teamId:3,agentId:null}}};
  const item={id:'outbox',organizationId:'tenant-a',channelId:'channel',conversationId:'conversation',executionId:'execution',leaseToken:'lease',kind:'HANDOFF',payload:{}} as OutboxRow;
  const account={organization_id:'tenant-a',base_url:operation.snapshot!.origin,credential_version:4} as AccountRow;
  let canonical={id:21,account_id:7,inbox_id:9,status:'pending',meta:{sender:{id:8},assignee:null as null|{id:number;type:string},team:null as null|{id:number}}};
  const network=(event:string)=>{expect(locked).toBe(false);events.push(event);};
  const client={attendanceConversation:vi.fn(async()=>{network('read');return structuredClone(canonical);}),
    assignAttendanceConversation:vi.fn(async()=>{network('assign');canonical.meta.team={id:3};}),
    handoffFlowConversation:vi.fn(async()=>{network('open');canonical.status='open';})};
  const repository:HandoffRepository={prepare:vi.fn(async()=>({operation:structuredClone(operation),fresh})),
    guard:vi.fn(async()=>{events.push('guard');if(!allowed)throw new Error('HANDOFF_CONTEXT_CHANGED');return account;}),
    stage:vi.fn(async(_tx,op,phase)=>{operation.phase=phase;operation.state=phase==='OPENED'?'PENDING':'UNKNOWN';events.push(phase);return structuredClone(operation);}),
    fail:vi.fn(async(_tx,_op,error,uncertain)=>{operation.error=error;operation.state=uncertain?'UNKNOWN':'ACTION_REQUIRED';}),
    confirm:vi.fn(async()=>{events.push('confirm');operation.state='APPLIED';operation.phase='CONFIRMED';}),
    next:vi.fn(async()=>operation.state==='UNKNOWN'||operation.state==='PENDING'?structuredClone(operation):null)};
  const attendanceService={validateTarget:vi.fn(async()=>{network('target');return {credentialRevision:4};}),catalog:vi.fn(async()=>{network('catalog');return {scope:operation.snapshot!.scope,credentialRevision:4,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},remoteBot:null,capabilities:{agentBot:'SUPPORTED'},teams:[{id:3,autoAssignment:false}]} as AttendanceCatalog;})};
  const options={transact:async<T>(_org:string,work:(tx:TenantTransaction)=>Promise<T>)=>{expect(locked).toBe(false);locked=true;try{return await work({} as TenantTransaction);}finally{locked=false;}},client:()=>client as unknown as ChatwootClient,attendanceService,repository};
  return {operation,item,client,repository,events,attendanceService,service:()=>createNativeHandoffService(options),deny:()=>{allowed=false;},restart:()=>{fresh=false;},canonical};
}

describe('durable native handoff',()=>{
  it('pauses durably, opens then assigns, and returns SENT only after canonical target/open readback',async()=>{
    const f=fixture(),result=await f.service().dispatch(f.item);
    expect(result).toMatchObject({kind:'SENT'});expect(f.operation.state).toBe('APPLIED');
    expect(f.events.filter(e=>['read','assign','open','confirm'].includes(e))).toEqual(['read','open','read','read','assign','read','confirm']);
    expect(f.repository.guard).toHaveBeenCalledTimes(10);
  });
  it('does not POST after target validation fails',async()=>{
    const f=fixture();f.attendanceService.validateTarget.mockRejectedValueOnce(new Error('ATTENDANCE_TEAM_NOT_FOUND'));
    expect(await f.service().dispatch(f.item)).toEqual({kind:'FAILED',error:'ATTENDANCE_TEAM_NOT_FOUND'});
    expect(f.operation.state).toBe('ACTION_REQUIRED');expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
  });
  it('fails closed on automatic assignment, greeting, AgentBot or unknown policy',async()=>{
    const f=fixture();f.attendanceService.catalog.mockResolvedValueOnce({inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:true}} as AttendanceCatalog);
    expect(await f.service().dispatch(f.item)).toMatchObject({kind:'FAILED'});expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
  });
  it('blocks stale scope/human takeover immediately before mutation',async()=>{
    const f=fixture();f.client.attendanceConversation.mockImplementationOnce(async()=>{f.deny();return structuredClone(f.canonical);});
    expect(await f.service().dispatch(f.item)).toEqual({kind:'FAILED',error:'HANDOFF_CONTEXT_CHANGED'});
    expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
  });
  it('persists uncertainty after assignment timeout and never POSTs during restart reconciliation',async()=>{
    const f=fixture();f.client.assignAttendanceConversation.mockRejectedValueOnce(new Error('TIMEOUT'));
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    expect(f.operation.state).toBe('UNKNOWN');f.restart();await f.service().reconcileOnce('tenant-a');
    expect(f.client.assignAttendanceConversation).toHaveBeenCalledTimes(1);expect(f.client.handoffFlowConversation).toHaveBeenCalledTimes(1);expect(f.operation.state).toBe('UNKNOWN');
  });
  it('reconciles assignment timeout by GET after restart, without replaying either POST',async()=>{
    const f=fixture();f.client.assignAttendanceConversation.mockImplementationOnce(async()=>{f.canonical.meta.team={id:3};throw new Error('TIMEOUT');});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');f.restart();
    expect(await f.service().reconcileOnce('tenant-a')).toMatchObject({state:'APPLIED'});expect(f.client.assignAttendanceConversation).toHaveBeenCalledTimes(1);expect(f.client.handoffFlowConversation).toHaveBeenCalledTimes(1);
  });
  it('does not assign after human takeover during open, even if opening was accepted',async()=>{
    const f=fixture();f.client.handoffFlowConversation.mockImplementationOnce(async()=>{f.canonical.status='open';f.deny();});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();expect(f.operation.state).toBe('UNKNOWN');
  });
  it('does not assign an agent removed from the inbox while opening the conversation',async()=>{
    const f=fixture();f.operation.snapshot!.target={teamId:null,agentId:4};
    const catalog={scope:f.operation.snapshot!.scope,credentialRevision:4,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},remoteBot:null,capabilities:{agentBot:'SUPPORTED'},teams:[],agents:[{id:4,inboxMember:true}]} as AttendanceCatalog;
    f.attendanceService.catalog.mockResolvedValueOnce(catalog).mockResolvedValueOnce({...catalog,agents:[{id:4,name:'Synthetic',inboxMember:false}]});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();expect(f.operation.state).toBe('UNKNOWN');
  });
  it('does not overwrite an existing remote human/team or resolved conversation',async()=>{
    for(const change of [{status:'open'},{status:'resolved'},{meta:{sender:{id:8},assignee:{id:4,type:'User'},team:null}},{meta:{sender:{id:8},assignee:null,team:{id:6}}}]){
      const f=fixture();Object.assign(f.canonical,change);expect(await f.service().dispatch(f.item)).toMatchObject({kind:'FAILED'});expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
    }
  });
  it('does not report success for a wrong inbox, team, agent or status readback',async()=>{
    const f=fixture();f.client.assignAttendanceConversation.mockImplementationOnce(async()=>{f.canonical.meta.team={id:6};});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it.each([{type:'agent_bot',assignee_type:'User'},{type:'user',assignee_type:'AgentBot'},{type:undefined,assignee_type:undefined}])('never confirms contradictory or missing human type $type/$assignee_type',async types=>{
    const f=fixture();f.operation.snapshot!.target={teamId:null,agentId:4};
    f.attendanceService.catalog.mockResolvedValue({scope:f.operation.snapshot!.scope,credentialRevision:4,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},remoteBot:null,capabilities:{agentBot:'SUPPORTED'},teams:[],agents:[{id:4,name:'Synthetic',inboxMember:true}]} as AttendanceCatalog);
    f.client.assignAttendanceConversation.mockImplementationOnce(async()=>{Object.assign(f.canonical.meta,{assignee:{id:4,...(types.type?{type:types.type}:{})},...(types.assignee_type?{assignee_type:types.assignee_type}:{})});});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it('never continues from an uncertain opening on restart even when GET proves open',async()=>{
    const f=fixture();f.client.handoffFlowConversation.mockImplementationOnce(async()=>{f.canonical.status='open';throw new Error('TIMEOUT');});
    await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
    expect(await f.service().reconcileOnce('tenant-a')).toMatchObject({state:'UNKNOWN'});expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
  });
  it('does not replay a duplicate dispatch, including a prepared operation after a process crash',async()=>{
    const f=fixture();f.restart();await expect(f.service().dispatch(f.item)).rejects.toThrow('HANDOFF_RECONCILIATION_REQUIRED');expect(f.client.assignAttendanceConversation).not.toHaveBeenCalled();
  });
  it('rejects another tenant during reconciliation before any network call',async()=>{
    const f=fixture();await expect(f.service().reconcileOnce('tenant-b')).rejects.toThrow('HANDOFF_SCOPE_MISMATCH');expect(f.client.attendanceConversation).not.toHaveBeenCalled();
  });
});
