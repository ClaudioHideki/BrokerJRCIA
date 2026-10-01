import { describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { createAutomationService, createEventRouter, createExecutionService, createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { automationRuntimeEnabled } from '../../src/modules/automations/availability.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

function setup({enabled=false, status='ACTIVE', moduleEnabled=true, runtimeReady=async()=>true}={}) {
  const graph=welcomeFlow();
  const row={id:'draft',organizationId:'tenant',name:'Atendimento',lifecycleStatus:'DRAFT',draftGraph:graph,draftRevision:1,activeVersion:null,updatedAt:new Date()};
  const repository={listDefinitions:vi.fn(async()=>({rows:[row],hasMore:false})),getDefinition:vi.fn(async()=>row),insertDefinition:vi.fn(async()=>row),updateDefinition:vi.fn(async()=>row),insertVersion:vi.fn()} as unknown as AutomationRepository;
  const query=vi.fn(async()=>({rows:[{status,moduleEnabled}],rowCount:1}));
  const service=createAutomationService({enabled,repository,runtimeReady,transact:async(_org,work)=>work({query} as unknown as TenantTransaction)});
  return {service,repository,graph};
}

describe('automation availability and offline drafts',()=>{
  it('keeps saved drafts readable and editable while live runtime is paused',async()=>{
    const {service,graph}=setup();
    expect(await service.status('tenant','ADMIN')).toMatchObject({enabled:false,canRead:true,canEdit:true,canSimulate:true,canPublish:false,reasons:['AUTOMATION_RUNTIME_DISABLED']});
    expect((await service.list('tenant')).data).toHaveLength(1);
    expect(await service.create('tenant',{name:'Atendimento',graph})).toMatchObject({lifecycleStatus:'DRAFT'});
    expect(await service.save('tenant','draft',{name:'Atendimento',graph,revision:1})).toMatchObject({draft:{revision:1}});
    expect(await service.validate('tenant','draft')).toEqual({valid:true,diagnostics:[],errors:[]});
    expect(await service.simulate('tenant','draft',{text:'Olá'})).toMatchObject({status:'COMPLETED'});
    await expect(service.publish('tenant','draft',1)).rejects.toMatchObject({code:'AUTOMATION_RUNTIME_DISABLED',statusCode:409});
  });
  it.each([
    {status:'SUSPENDED',moduleEnabled:true,code:'ORGANIZATION_NOT_ACTIVE'},
    {status:'ACTIVE',moduleEnabled:false,code:'AUTOMATION_MODULE_DISABLED'},
  ])('reports $code without hiding saved drafts',async({status,moduleEnabled,code})=>{
    const {service,graph,repository}=setup({enabled:true,status,moduleEnabled});
    expect(await service.status('tenant','ADMIN')).toMatchObject({canRead:true,canEdit:false,canPublish:false,reasons:[code]});
    expect((await service.list('tenant')).data).toHaveLength(1);
    await expect(service.create('tenant',{name:'Atendimento',graph})).rejects.toMatchObject({code,statusCode:403});
    expect(repository.insertDefinition).not.toHaveBeenCalled();
  });
  it('reports current read-only role independently from runtime state',async()=>{
    const {service}=setup({enabled:true});
    expect(await service.status('tenant','VIEWER')).toMatchObject({canRead:true,canEdit:false,canSimulate:false,canPublish:false,reasons:['AUTOMATION_PERMISSION_REQUIRED']});
  });
  it('keeps drafts editable but refuses publication when a dependency is unavailable',async()=>{
    const {service,graph,repository}=setup({enabled:true,runtimeReady:async()=>false});
    expect(await service.status('tenant','ADMIN')).toMatchObject({canEdit:true,canSimulate:true,canPublish:false,reasons:['AUTOMATION_DEPENDENCY_UNAVAILABLE']});
    expect(await service.create('tenant',{name:'Atendimento',graph})).toMatchObject({lifecycleStatus:'DRAFT'});
    await expect(service.publish('tenant','draft',1)).rejects.toMatchObject({code:'AUTOMATION_DEPENDENCY_UNAVAILABLE',statusCode:503});
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });
  it('does not claim executions, release timers or dispatch side effects when the global switch is off',async()=>{
    const transact=vi.fn(async()=>{throw new Error('WORK_SHOULD_NOT_BE_CLAIMED');});
    const execution=createExecutionService({transact,enabled:false});
    expect(await execution.runOnce('tenant')).toEqual({processed:false});
    expect(await execution.releaseDueWaits('tenant')).toBe(0);
    const dispatch=vi.fn(async()=>({kind:'SENT' as const}));
    expect(await createOutboxDispatcher({transact,enabled:false},{dispatch}).runOnce('tenant')).toEqual({processed:false});
    expect(transact).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not schedule incoming automation events when the global switch is off',async()=>{
    const transact=vi.fn(async()=>{throw new Error('EVENT_SHOULD_NOT_BE_STORED');});
    expect(await createEventRouter({transact,enabled:false}).route('tenant',{channelId:'channel',eventKey:'event',text:'Olá'})).toEqual({duplicate:false,execution:null});
    expect(transact).not.toHaveBeenCalled();
  });
  it('uses an explicit false default for all worker processes',()=>{
    expect(automationRuntimeEnabled({})).toBe(false);expect(automationRuntimeEnabled({AUTOMATION_RUNTIME_V2_ENABLED:'false'})).toBe(false);
    expect(automationRuntimeEnabled({AUTOMATION_RUNTIME_V2_ENABLED:'true'})).toBe(true);
    expect(()=>automationRuntimeEnabled({AUTOMATION_RUNTIME_V2_ENABLED:'yes'})).toThrow('AUTOMATION_RUNTIME_V2_ENABLED_INVALID');
  });
});
