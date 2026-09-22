import { describe,expect,it,vi } from 'vitest';
import { createEventRouter } from '../../src/modules/automations/service.js';
import type { AutomationRepository } from '../../src/modules/automations/repository.js';

describe('automation event router',()=>{
  it('deduplicates the canonical event before creating another execution',async()=>{let inserted=true;const routeEvent=vi.fn().mockResolvedValue({resumed:false,execution:{id:'33333333-3333-4333-8333-333333333333',organizationId:'11111111-1111-4111-8111-111111111111',automationId:'22222222-2222-4222-8222-222222222222',version:1,bindingId:'44444444-4444-4444-8444-444444444444',channelId:'55555555-5555-4555-8555-555555555555',conversationId:null,status:'QUEUED',currentNodeId:null,correlationId:'66666666-6666-4666-8666-666666666666',state:{},input:{},errorCode:null,attempts:0,startedAt:new Date(),updatedAt:new Date(),completedAt:null,leaseToken:null}});
    const repository=new Proxy({}, {get:(_target,key)=>key==='insertEvent'?async()=>{const result=inserted;inserted=false;return result}:key==='routeEvent'?routeEvent:vi.fn()}) as AutomationRepository;
    const router=createEventRouter({repository,transact:async(_org,work)=>work({} as never)}),event={channelId:'55555555-5555-4555-8555-555555555555',eventKey:'message:upstream-1',text:'Olá'};
    expect((await router.route('11111111-1111-4111-8111-111111111111',event)).duplicate).toBe(false);
    expect(await router.route('11111111-1111-4111-8111-111111111111',event)).toEqual({duplicate:true,execution:null});expect(routeEvent).toHaveBeenCalledTimes(1);
  });
});
