import {it,expect,vi} from 'vitest';
import {createBoxRoutingService,postgresBoxProfileStore,type BoxProfileStore} from '../../src/modules/automations/box-routing-service.js';
import {catalog,config,org,channel} from './fixtures/box-routing.js';
import {resolveBoxDirectory} from '../../src/modules/automations/box-directory.js';
import type {BoxDirectorySnapshot} from '@jrc/contracts';
const automation='55555555-5555-4555-8555-555555555555';
const graph={nodes:[{id:'start',type:'start',label:'start',position:{x:0,y:0},data:{boxRoutes:[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT'}]}},
 {id:'h',type:'handoff',label:'h',position:{x:1,y:1},data:{handoffVersion:3,routeKey:'sales'}}],edges:[{id:'e',source:'start',target:'h',port:'next'}]};
function harness(){
 let inTx=false,current:any=null,active:any=null;
 const tx={query:async()=>({rows:[],rowCount:1})} as any;
 const transact=async(_org:string,work:any)=>{expect(inTx).toBe(false);inTx=true;try{return await work(tx);}finally{inTx=false;}};
 const store:BoxProfileStore={read:vi.fn(async(_tx,_org,_automation,_version,_channel,source='LATEST')=>source==='ACTIVE'?active:current),graph:vi.fn(async()=>graph),
  write:vi.fn(async(_tx:any,input:any)=>{if((current?.revision??0)!==input.expectedRevision)throw Error('FLOW_BOX_PROFILE_CHANGED');current={...input,revision:input.expectedRevision+1,activeRevision:active?.revision??null};return current;}),
  activate:vi.fn(async(_tx:any,_org:string,_automation:string,_version:number,_channel:string,revision:number)=>{if(current?.revision!==revision)throw Error('FLOW_BOX_PROFILE_CHANGED');active={...current,activeRevision:revision};current={...current,activeRevision:revision};}),
  assertScope:vi.fn(async(_tx:any,_o:string,_c:string,s:BoxDirectorySnapshot)=>{expect(s.scope.channelId).toBe(channel);}),
 };
 let members=[{id:1,name:'Ana'},{id:2,name:'Bruno'}];
 const teamMembers=vi.fn(async()=>{expect(inTx).toBe(false);return members;});
 const service=createBoxRoutingService({transact,store,catalog:async()=>{expect(inTx).toBe(false);return catalog();},
  teamMembers,
  integration:async()=>catalog().scope.integrationId,
  readiness:{prepare:async()=>{expect(inTx).toBe(false);return {async assertCurrent(){}};}},
 });
 return {service,store,teamMembers,transact,tx,setMembers:(value:typeof members)=>{members=value;}};
}
it('prepares outside locks, saves scoped immutable revisions, and makes identical saves idempotent',async()=>{
 const {service,store,transact}=harness(),input={version:1,expectedRevision:0,config:config()};
 const one=await service.save(org,automation,channel,input,'actor');expect(one.revision).toBe(1);
 const two=await service.save(org,automation,channel,input,'actor');expect(two.revision).toBe(1);expect(store.write).toHaveBeenCalledTimes(1);
 const prepared=await service.prepareBinding(org,automation,1,channel,1);await transact(org,prepared.activateProfile);
 expect((await service.prepareSession(org,automation,1,channel))?.routes[0]?.agents[0]?.name).toBe('Ana');
});
it('rejects stale changes and revoked members rather than choosing another agent',async()=>{
 const {service,setMembers,transact}=harness();await service.save(org,automation,channel,{version:1,expectedRevision:0,config:config()},'actor');
 const prepared=await service.prepareBinding(org,automation,1,channel,1);await transact(org,prepared.activateProfile);
 const changed=config();changed.routes[0]!.membership='SELECTED';changed.routes[0]!.agentIds=[1];
 await expect(service.save(org,automation,channel,{version:1,expectedRevision:0,config:changed},'actor')).rejects.toThrow('FLOW_BOX_PROFILE_CHANGED');
 setMembers([{id:2,name:'Bruno'}]);
 const directory=await service.prepareSession(org,automation,1,channel);
 expect(directory?.routes[0]?.agents.map(a=>a.id)).toEqual([2]);
});
it('loads team members only for configured or explicitly requested teams rather than the entire company',async()=>{
 const {service,teamMembers}=harness();
 await service.get(org,automation,1,channel);expect(teamMembers).not.toHaveBeenCalled();
 const selected=await service.get(org,automation,1,channel,10);expect(teamMembers).toHaveBeenCalledTimes(1);
 expect(selected.teamMembers[0]?.agents.map(a=>a.name)).toEqual(['Ana','Bruno']);
 await expect(service.get(org,automation,1,channel,999)).rejects.toThrow('FLOW_BOX_TEAM_UNAVAILABLE');
});
it('reports an unapplied routing schema explicitly instead of reading incomplete production tables',async()=>{
 const query=vi.fn(async()=>({rows:[{ready:false}],rowCount:1}));
 await expect(postgresBoxProfileStore().read({query} as never,org,automation,1,channel)).rejects.toThrow('FLOW_BOX_SCHEMA_PENDING');
 expect(query).toHaveBeenCalledTimes(1);
});
it('keeps saves staged until explicit atomic activation and resumes only the previously active revision',async()=>{
 const {service,transact}=harness();await service.save(org,automation,channel,{version:1,expectedRevision:0,config:config()},'actor');
 await expect(service.prepareSession(org,automation,1,channel)).rejects.toThrow('FLOW_BOX_PROFILE_REQUIRED');
 let ready=await service.prepareBinding(org,automation,1,channel,1);await transact(org,ready.activateProfile);
 const first=await service.prepareSession(org,automation,1,channel);expect(first?.profileRevision).toBe(1);
 const changed=config();changed.routes[0]!.membership='SELECTED';changed.routes[0]!.agentIds=[2];
 await service.save(org,automation,channel,{version:1,expectedRevision:1,config:changed},'actor');
 expect((await service.prepareSession(org,automation,1,channel))?.profileRevision).toBe(1);
 ready=await service.prepareBinding(org,automation,1,channel,1,'ACTIVE');await transact(org,ready.assertCurrent);
 await expect(service.prepareBinding(org,automation,1,channel,2,'ACTIVE')).rejects.toThrow('FLOW_BOX_PROFILE_CHANGED');
 ready=await service.prepareBinding(org,automation,1,channel,2);await transact(org,ready.activateProfile);
 const second=await service.prepareSession(org,automation,1,channel);expect(second?.profileRevision).toBe(2);expect(second?.routes[0]?.agents.map(a=>a.id)).toEqual([2]);
 await expect(service.prepareBinding(org,automation,1,channel,1,'ACTIVE')).rejects.toThrow('FLOW_BOX_PROFILE_CHANGED');
});
it('rejects profile writes and activation when the organization has become inactive',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('tenant_is_active')?[{active:false}]:[],rowCount:1})),tx={query} as never,store=postgresBoxProfileStore();
 const snapshot=resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:1,name:'Ana'}]]]),1);
 await expect(store.write(tx,{organizationId:org,automationId:automation,version:1,channelId:channel,expectedRevision:0,actorId:org,config:config(),snapshot})).rejects.toThrow('ORGANIZATION_NOT_ACTIVE');
 await expect(store.activate(tx,org,automation,1,channel,1)).rejects.toThrow('ORGANIZATION_NOT_ACTIVE');
 expect(query.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE)/i.test(sql))).toBe(false);
});
