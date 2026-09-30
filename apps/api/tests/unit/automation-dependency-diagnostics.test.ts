import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/modules/automations/service.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

const rootId='11111111-1111-4111-8111-111111111111';
const childId='22222222-2222-4222-8222-222222222222';
const missingId='33333333-3333-4333-8333-333333333333';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('root-call','subflow',{automationId:childId,version:7}),node('root-message','message',{text:'Depois'}),node('end','end')],edges:[
  {id:'a',source:'start',target:'root-call',port:'next'},{id:'b',source:'root-call',target:'root-message',port:'next'},{id:'c',source:'root-message',target:'end',port:'next'},
]};

describe('dependency diagnostics remain in the edited root graph',()=>{
  it.each(['nested-only','root-message'])('locates root caller when missing child node is %s',async nestedId=>{
    const nested=node(nestedId,'subflow',{automationId:missingId,version:3});
    const repository={getDefinition:vi.fn(async()=>({draftGraph:graph})),getVersion:vi.fn(async(_tx,_org,id)=>id===childId?{graph:{nodes:[nested],edges:[]}}:null)} as unknown as AutomationRepository;
    const service=createAutomationService({repository,transact:async(_org,work)=>work({} as TenantTransaction)});
    await expect(service.validate('tenant',rootId)).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_VERSION_NOT_FOUND',details:[{
      nodeId:'root-call',field:'data.version',code:'SUBFLOW_VERSION_NOT_FOUND',
      message:expect.stringMatching(new RegExp(`${nestedId}.*${missingId}:3`)),
    }]});
  });
  it.each(['nested-only','root-message'])('locates root caller when recursive child node is %s',async nestedId=>{
    const nested=node(nestedId,'subflow',{automationId:rootId,version:1});
    const repository={getDefinition:vi.fn(async()=>({draftGraph:graph})),getVersion:vi.fn(async()=>({graph:{nodes:[nested],edges:[]}}))} as unknown as AutomationRepository;
    const service=createAutomationService({repository,transact:async(_org,work)=>work({} as TenantTransaction)});
    await expect(service.validate('tenant',rootId)).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_RECURSION',details:[{
      nodeId:'root-call',field:'data.automationId',code:'SUBFLOW_RECURSION',message:expect.stringContaining(nestedId),
    }]});
  });
});
