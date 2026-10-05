import { describe,expect,it,vi } from 'vitest';
import { createHandoffReadiness } from '../../src/modules/attendance/handoff-readiness.js';

const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',integration='33333333-3333-4333-8333-333333333333';
const scope={organizationId:org,channelId:channel,integrationId:integration,destinationRevision:1,accountId:7,inboxId:9};
const config={handoffVersion:1,destination:{integrationId:integration,destinationRevision:1,accountId:7,inboxId:9,credentialRevision:1},target:{teamId:3,agentId:null}};
const graph={nodes:[{id:'h',type:'handoff',label:'handoff',position:{x:0,y:0},data:config}],edges:[]};
function setup(){
  let credential=1,revision=1;
  const query=vi.fn(async(sql:string,args:unknown[])=>{
    if(sql.includes('SELECT channel_id FROM chatwoot_connections'))return {rows:args[0]===org&&args[1]===integration?[{channel_id:channel}]:[],rowCount:1};
    if(sql.includes('AS "integrationId"'))return {rows:[{integrationId:integration,destinationRevision:revision,accountId:'7',inboxId:'9',connectionStatus:'READY',accountStatus:'READY',approvalStatus:'APPROVED'}]};
    if(sql.includes('FROM chatwoot_accounts'))return {rows:[{organization_id:org,base_url:'https://central.example.test',account_id:'7',status:'READY',credential_version:credential}]};
    if(sql.includes('FROM chatwoot_destinations'))return {rows:[]};
    if(sql.includes('tenant_is_active'))return {rows:[{active:true}],rowCount:1};
    throw new Error(sql);
  });
  const catalog=vi.fn(async()=>({scope,credentialRevision:1,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},capabilities:{agentBot:'SUPPORTED'},remoteBot:null,teams:[{id:3,autoAssignment:false}]}));
  const validateTarget=vi.fn(async()=>({scope,credentialRevision:1}));
  const tx={query},service=createHandoffReadiness({transact:async(_org,work)=>work(tx as never),catalog:catalog as never,validateTarget});
  return {service,tx,catalog,validateTarget,rotate:()=>{credential++},revise:()=>{revision++}};
}
describe('remote handoff readiness',()=>{
  it('validates only a tenant-owned destination and holds a final local scope/credential fence',async()=>{
    const h=setup(),prepared=await h.service.prepare(org,graph,channel);expect(h.validateTarget).toHaveBeenCalledWith(scope,config.target);
    await prepared.assertCurrent(h.tx as never);h.rotate();await expect(prepared.assertCurrent(h.tx as never)).rejects.toThrow('CHATWOOT_CONTEXT_CHANGED');
  });
  it('rejects a cross-tenant integration before any remote read',async()=>{
    const h=setup();await expect(h.service.prepare('44444444-4444-4444-8444-444444444444',graph)).rejects.toThrow('ATTENDANCE_DESTINATION_NOT_FOUND');expect(h.catalog).not.toHaveBeenCalled();
  });
  it('rejects a valid catalog for another channel at activation',async()=>{
    const h=setup();await expect(h.service.prepare(org,graph,'other-channel')).rejects.toThrow('ATTENDANCE_HANDOFF_CHANNEL_MISMATCH');expect(h.catalog).not.toHaveBeenCalled();
  });
  it('rejects stale graph credential references before remote reads',async()=>{
    const h=setup();h.rotate();await expect(h.service.prepare(org,graph)).rejects.toThrow('CHATWOOT_CONTEXT_CHANGED');expect(h.catalog).not.toHaveBeenCalled();
  });
  it.each([
    [{inboxPolicy:{greetingEnabled:true,autoAssignmentEnabled:false}},'ATTENDANCE_DISABLE_INBOX_GREETING'],
    [{inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:null}},'ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT'],
    [{remoteBot:{id:2}},'ATTENDANCE_REMOVE_COMPETING_AGENT_BOT'],
    [{capabilities:{agentBot:'UNSUPPORTED'}},'ATTENDANCE_REMOVE_COMPETING_AGENT_BOT'],
    [{teams:[{id:3,autoAssignment:true}]},'ATTENDANCE_DISABLE_TEAM_AUTO_ASSIGNMENT'],
  ])('blocks unsafe or unverified remote policy %j',async(patch,error)=>{
    const h=setup(),base=await h.catalog();h.catalog.mockResolvedValue({...base,...patch} as never);
    await expect(h.service.prepare(org,graph)).rejects.toThrow(error as string);expect(h.validateTarget).not.toHaveBeenCalled();
  });
  it('rejects catalog scope mismatch and deleted targets',async()=>{
    const h=setup(),base=await h.catalog();h.catalog.mockResolvedValue({...base,scope:{...scope,accountId:8}});
    await expect(h.service.prepare(org,graph)).rejects.toThrow('CHATWOOT_CONTEXT_CHANGED');
    h.catalog.mockResolvedValue(base);h.validateTarget.mockRejectedValue(new Error('ATTENDANCE_TEAM_NOT_FOUND'));
    await expect(h.service.prepare(org,graph)).rejects.toThrow('ATTENDANCE_TEAM_NOT_FOUND');
  });
});
