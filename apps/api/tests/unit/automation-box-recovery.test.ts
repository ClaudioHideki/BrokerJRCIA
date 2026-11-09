import {it,expect,vi} from 'vitest';
import {prepareDirectoryReoffer,createDirectoryHandoffRecovery} from '../../src/modules/automations/box-handoff-recovery.js';
import {catalog,config,org,channel} from './fixtures/box-routing.js';
import {resolveBoxDirectory,resolveRouteHandoff} from '../../src/modules/automations/box-directory.js';
import type {RuntimeState} from '../../src/modules/automations/types.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';
function fixture(){
 const directory=resolveBoxDirectory(config(),catalog(),new Map([[10,[{id:1,name:'Ana'},{id:2,name:'Bruno'}]]]),1);
 const n=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
 const graph={nodes:[n('start','start'),n('menu','directory-menu',{directoryVersion:1,routeKey:'sales',language:'pt',text:'Escolha',backLabel:'Voltar',errorMessage:'Inválida',maxAttempts:3}),
  n('h','handoff',{handoffVersion:3,routeKey:'sales'}),n('departments','menu',{text:'Outro departamento',options:[{value:'1',label:'Comercial'},{value:'2',label:'Fim'}]}),n('end','end')],
 edges:[{id:'s',source:'start',target:'menu',port:'next'},{id:'selected',source:'menu',target:'h',port:'selected'},{id:'back',source:'menu',target:'departments',port:'back'}]};
 const state:RuntimeState={runtimeStateVersion:2,automationId:'44444444-4444-4444-8444-444444444444',version:1,nodeId:null,steps:8,variables:{language:'pt'},stack:[],boxDirectory:directory,boxSelection:{routeKey:'sales',agentId:1,language:'pt',menuNodeId:'menu'}};
 const original=resolveRouteHandoff(directory,'sales',1);
 return {graph,state,original,directory};
}
it('reoffers only previously offered candidates still authorized in the same team/inbox, without replaying greeting',()=>{
 const f=fixture(),encoded=JSON.stringify(f.state);
 const plan=prepareDirectoryReoffer({graph:f.graph,state:f.state},{catalog:catalog(),members:[{id:2,name:'Bruno'}],target:f.original.target,teamId:10,scope:f.directory.scope,credentialRevision:1,nodeId:'h'});
 expect(plan.state.nodeId).toBe('menu');expect(plan.state.boxSelection).toBeUndefined();expect(plan.state.boxDirectory?.routes[0]?.agents).toEqual([{id:2,name:'Bruno',optionValue:'2'}]);
 expect(plan.notice).toContain('indisponível');expect(JSON.stringify(f.state)).toBe(encoded);
 const empty=prepareDirectoryReoffer({graph:f.graph,state:f.state},{catalog:catalog(),members:[],target:f.original.target,teamId:10,scope:f.directory.scope,credentialRevision:1,nodeId:'h'});
 expect(empty.state.nodeId).toBe('departments');
});
it('never interprets a resent unavailable option as a different person after reoffering',async()=>{
 const f=fixture(),plan=prepareDirectoryReoffer({graph:f.graph,state:f.state},{catalog:catalog(),members:[{id:2,name:'Bruno'}],target:f.original.target,teamId:10,scope:f.directory.scope,credentialRevision:1,nodeId:'h'});
 const root={automationId:f.state.automationId,version:1,runtimeStateVersion:2 as const,graph:f.graph},now=new Date('2030-01-01T00:00:00Z');
 const offered=await executeAutomation(root,{text:'',eventType:'RESUME',now},async()=>root,plan.state);
 expect(offered.effects[0]?.payload.text).toContain('2 - Bruno');expect(offered.effects[0]?.payload.text).not.toContain('1 - Bruno');
 const oldAnswer=await executeAutomation(root,{text:'1',eventType:'MESSAGE',now,inputWait:{waitId:offered.wait!.waitId!,admittedAt:+now}},async()=>root,offered.state);
 expect(oldAnswer.status).toBe('WAITING');expect(oldAnswer.effects.every(e=>e.kind==='SEND_TEXT')).toBe(true);
});
it('rejects changed scope, missing offered-menu proof and paths that would replay actions',()=>{
 const f=fixture(),args={catalog:catalog(),members:[{id:2,name:'Bruno'}],target:f.original.target,teamId:10,scope:f.directory.scope,credentialRevision:1,nodeId:'h'};
 expect(()=>prepareDirectoryReoffer({graph:f.graph,state:f.state},{...args,credentialRevision:2})).toThrow('FLOW_BOX_RECOVERY_UNSAFE');
 expect(()=>prepareDirectoryReoffer({graph:f.graph,state:{...f.state,boxSelection:undefined} as never},args)).toThrow('FLOW_BOX_RECOVERY_UNSAFE');
 f.graph.edges.find(e=>e.port==='selected')!.target='end';expect(()=>prepareDirectoryReoffer({graph:f.graph,state:f.state},args)).toThrow('FLOW_BOX_RECOVERY_UNSAFE');
});
it('prepares outside locks and rechecks human-control authority before any recovery write',async()=>{
 const f=fixture();let locked=false,deny=false;const queries:string[]=[];
 const repository={guard:vi.fn(async()=>{if(deny)throw Error('HANDOFF_HUMAN_CONTROL_CHANGED');return {};})};
 const transact=async(_o:string,work:any)=>{locked=true;try{return await work({query:async(sql:string)=>{queries.push(sql);return {rows:[{graph:f.graph,state:f.state,attempts:1}],rowCount:1};}});}finally{locked=false;}};
 const recovery=createDirectoryHandoffRecovery({transact:transact as never,repository:repository as never,client:()=>({teamAgents:async()=>{expect(locked).toBe(false);return [{id:2,name:'Bruno'}];}}) as never});
 const op={organizationId:org,executionId:'execution',channelId:channel,conversationId:'conversation',outboxId:'outbox',id:'operation',leaseToken:'lease',phase:'PREPARED',state:'PENDING',snapshot:{automationId:f.state.automationId,version:1,scope:f.directory.scope,credentialRevision:1,target:f.original.target,routeTeamId:10}} as any;
 const plan=await recovery.prepare({organizationId:org,nodeId:'h'} as never,op,{} as never,catalog());
 deny=true;await expect(transact(org,plan.commit)).rejects.toThrow('HANDOFF_HUMAN_CONTROL_CHANGED');
 expect(queries.some(sql=>/^\s*(UPDATE|INSERT)/i.test(sql))).toBe(false);
});
