import {it,expect,vi} from 'vitest';
import {createExecutionService} from '../../src/modules/automations/service.js';
import {resolveBoxDirectory} from '../../src/modules/automations/box-directory.js';
import {catalog,config,org,channel} from './fixtures/box-routing.js';
it('loads a fresh directory outside locks, captures it server-side and fences the lease before saving effects',async()=>{
 let locked=false;const snapshot=resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:1,name:'Ana'}]]]),1);
 const n=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
 const graph={nodes:[n('start','start',{boxRoutes:[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT'}]}),
  n('menu','directory-menu',{directoryVersion:1,routeKey:'sales',language:'pt',text:'Escolha',backLabel:'Voltar',errorMessage:'Inválida',maxAttempts:3})],edges:[{id:'a',source:'start',target:'menu',port:'next'}]};
 const claimed={id:'execution',organizationId:org,channelId:channel,automationId:'automation',version:1,input:{text:'Oi'},state:{},leaseToken:'lease'};
 const saveExecutionResult=vi.fn(async()=>{}),prepareSession=vi.fn(async()=>{expect(locked).toBe(false);return snapshot;});
 const query=vi.fn(async()=>({rows:[{id:claimed.id}],rowCount:1}));
 const service=createExecutionService({transact:async(_o,work)=>{locked=true;try{return await work({query} as never);}finally{locked=false;}},
  repository:{claimExecution:async()=>claimed,getVersion:async()=>({graph,runtimeStateVersion:2}),saveExecutionResult,failExecution:vi.fn()} as never,
  boxRouting:{prepareSession,assertSession:vi.fn()} as never});
 expect(await service.runOnce(org)).toMatchObject({status:'WAITING'});
 expect(prepareSession).toHaveBeenCalledOnce();expect(saveExecutionResult.mock.calls[0]?.[2]).toMatchObject({state:{boxDirectory:snapshot}});
 expect(query.mock.calls.some(([sql])=>String(sql).includes('lease_token'))).toBe(true);
});
