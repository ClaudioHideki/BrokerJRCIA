import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const handoff={handoffVersion:1,destination:{integrationId:'11111111-1111-4111-8111-111111111111',destinationRevision:1,accountId:7,inboxId:9,credentialRevision:1},target:{teamId:3,agentId:null}};
const graph=(data:Record<string,unknown>)=>({nodes:[node('start','start'),node('handoff','handoff',data)],edges:[{id:'e',source:'start',target:'handoff',port:'next'}]});
function setup(data:Record<string,unknown>=handoff){
  const row={id:'draft',organizationId:'tenant-a',name:'Menu',lifecycleStatus:'DRAFT',draftGraph:graph(data),draftRevision:1,activeVersion:null,updatedAt:new Date()};
  const repository={getDefinition:vi.fn(async()=>row),insertVersion:vi.fn(async()=>({automationId:'draft',organizationId:'tenant-a',version:1,graph:row.draftGraph,checksum:'a'.repeat(64),publishedAt:new Date()})),activateVersion:vi.fn()} as unknown as AutomationRepository;
  const tx={query:vi.fn(async()=>({rows:[{status:'ACTIVE',moduleEnabled:true}]}))};
  const assertCurrent=vi.fn(async()=>{}),prepare=vi.fn(async()=>({assertCurrent}));
  const service=createAutomationService({repository,transact:async(_org,work)=>work(tx as never),handoffReadiness:{prepare}});
  return {row,repository,service,prepare,assertCurrent};
}
describe('native handoff publication boundary',()=>{
  it('keeps legacy drafts readable but requires selecting a destination before publishing a new version',async()=>{
    const {service,repository}=setup({});
    await expect(service.get('tenant-a','draft')).resolves.toMatchObject({draft:{graph:graph({})}});
    await expect(service.publish('tenant-a','draft',1)).rejects.toMatchObject({code:'AUTOMATION_HANDOFF_DESTINATION_REQUIRED'});
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });
  it('requires remote readiness before publication and rechecks current scope before persistence',async()=>{
    const {service,prepare,assertCurrent,repository}=setup();
    await service.publish('tenant-a','draft',1);
    expect(prepare).toHaveBeenCalledWith('tenant-a',expect.objectContaining({nodes:expect.any(Array)}),undefined);
    expect(assertCurrent).toHaveBeenCalledOnce();expect(repository.insertVersion).toHaveBeenCalledOnce();
  });
  it('does not publish if destination changed while remote target validation was running',async()=>{
    const {service,assertCurrent,repository}=setup();assertCurrent.mockRejectedValue(new Error('CHATWOOT_CONTEXT_CHANGED'));
    await expect(service.publish('tenant-a','draft',1)).rejects.toThrow('CHATWOOT_CONTEXT_CHANGED');
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });
  it('does not publish a newer unvalidated draft after asynchronous target validation',async()=>{
    const {service,row,prepare,repository}=setup();prepare.mockImplementation(async()=>{row.draftRevision=2;return {assertCurrent:vi.fn()};});
    await expect(service.publish('tenant-a','draft',1)).rejects.toMatchObject({code:'AUTOMATION_CHANGED'});
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });
  it('does not trust a versioned destination when the remote checker is unavailable',async()=>{
    const {repository}=setup();const service=createAutomationService({repository,transact:async(_org,work)=>work({query:async()=>({rows:[{status:'ACTIVE',moduleEnabled:true}]})} as never)});
    await expect(service.publish('tenant-a','draft',1)).rejects.toMatchObject({code:'AUTOMATION_HANDOFF_UNAVAILABLE'});
  });
});
