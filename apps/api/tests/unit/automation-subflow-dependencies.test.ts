import {describe,expect,it,vi} from 'vitest';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {prepareSubflowSnapshot} from '../../src/modules/automations/subflow-dependencies.js';
import {SUBFLOW_MAX_GRAPH_BYTES,withDependencyPolicyV1} from '@jrc/contracts';
import * as contracts from '@jrc/contracts';
import type {AutomationRepository,DefinitionRow,VersionRow} from '../../src/modules/automations/repository.js';
import type {AutomationGraphV1} from '@jrc/contracts';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import type {PublishedAutomation} from '../../src/modules/automations/types.js';

const org='11111111-1111-4111-8111-111111111111',rootId='22222222-2222-4222-8222-222222222222';
const childId='33333333-3333-4333-8333-333333333333';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph=(middle:Array<ReturnType<typeof node>>,startData:Record<string,unknown>={}):AutomationGraphV1=>({
 nodes:[node('start','start',startData),...middle,node('end','end')],
 edges:[node('start','start'),...middle].map((item,at)=>({id:`edge-${at}`,source:item.id,target:middle[at]?.id??'end',port:'next'})),
});
const call=(id:string,automationId:string,version=7)=>node(id,'subflow',{automationId,version,timeoutMs:10000});
const published=(automationId:string,g:AutomationGraphV1):PublishedAutomation=>({automationId,version:7,runtimeStateVersion:2,graph:g});
const input={text:'Oi',eventType:'MESSAGE' as const,now:new Date('2030-01-01T00:00:00.000Z')};
function chain(count:number,policy?:number){
 const ids=[rootId,...Array.from({length:count},(_,at)=>`44444444-4444-4444-8444-${String(at+1).padStart(12,'0')}`)];
 const versions=new Map(ids.map((id,at)=>[id,published(id,graph(at<count?[call(at?'nested-call':'root-call',ids[at+1]!)]:[node('leaf-message','message',{text:'Folha'})],at===0&&policy!==undefined?{dependencyPolicyVersion:policy}:{}))]));
 return {root:versions.get(rootId)!,resolve:async(id:string,v:number)=>{if(v!==7||!versions.has(id))throw new Error('EXACT_REFERENCE_REQUIRED');return versions.get(id)!;},versions};
}
function fixture(rootGraph:AutomationGraphV1,children:Map<string,PublishedAutomation>,options:{archived?:string;changeOnSecondRead?:boolean;onPrepare?:()=>void}={}){
 const reads=new Map<string,number>();
 const definitions=new Map<string,DefinitionRow>([rootId,...children.keys()].map(id=>[id,{id,organizationId:org,name:id,lifecycleStatus:id===options.archived?'ARCHIVED':'PUBLISHED',draftGraph:id===rootId?rootGraph:children.get(id)!.graph,draftRevision:1,activeVersion:9,updatedAt:new Date()}]));
 const rows=new Map<string,VersionRow>([...children].map(([id,value])=>[id,{automationId:id,organizationId:org,version:value.version,graph:value.graph,runtimeStateVersion:value.runtimeStateVersion??1,checksum:'a'.repeat(64),publishedAt:new Date()}]));
 const repository={getDefinition:async(_tx:unknown,tenant:string,id:string)=>tenant===org?definitions.get(id)??null:null,
  getVersion:async(_tx:unknown,tenant:string,id:string,v:number)=>{
   if(tenant!==org||v!==7)return null;reads.set(id,(reads.get(id)??0)+1);
   const row=rows.get(id);if(!row)return null;
   return options.changeOnSecondRead&&(reads.get(id)??0)>1?{...row,graph:graph([node('changed','message',{text:'MUTATED_SECOND_READ'})])}:row;
  },
 } as unknown as AutomationRepository;
 const tx={query:async()=>({rows:[{status:'ACTIVE',moduleEnabled:true}]})} as unknown as TenantTransaction;
 const service=createAutomationService({repository,transact:async(tenant,work)=>{if(tenant!==org)throw new Error('WRONG_TENANT');return work(tx);}});
 return {service,reads,definitions,rows,repository,tx};
}

describe('subflow policy and immutable dependency preparation',()=>{
 it('preserves a historical root without a marker across nine children, even if a child is newly marked',async()=>{
  const tree=chain(9);tree.versions.get([...tree.versions.keys()][4]!)!.graph.nodes[0]!.data={dependencyPolicyVersion:1};
  const result=await executeAutomation(tree.root,input,tree.resolve);
  expect(result.status).toBe('COMPLETED');expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Folha']);
 });
 it('limits a new root to eight active child calls rather than taking policy from the current child',async()=>{
  const accepted=chain(8,1);expect((await executeAutomation(accepted.root,input,accepted.resolve)).status).toBe('COMPLETED');
  const rejected=chain(9,1);await expect(executeAutomation(rejected.root,input,rejected.resolve)).rejects.toThrow('AUTOMATION_SUBFLOW_DEPTH_LIMIT');
 });
 it('rejects an unknown or downgraded root policy instead of silently executing it as historical',async()=>{
  for(const policy of [0,2,-1]){const tree=chain(1,policy);await expect(executeAutomation(tree.root,input,tree.resolve)).rejects.toThrow('AUTOMATION_DEPENDENCY_POLICY_INVALID');}
 });
 it('prepares exact versions once before pure simulation and preserves typed input and shared outputs',async()=>{
  const parent=graph([call('root-call',childId),node('after','message',{text:'Pai {{answer}}'})]);
  parent.nodes[1]!.data.input={payload:{enabled:true},answer:'entrada'};
  const child=published(childId,graph([node('value','variable',{variable:'answer',value:'saída'}),node('reply','message',{text:'Filho {{answer}}'})]));
  const {service,reads}=fixture(parent,new Map([[childId,child]]),{changeOnSecondRead:true});
  const fetch=vi.spyOn(globalThis,'fetch');try{
   const result=await service.simulate(org,rootId,{text:'Oi',clock:input.now.toISOString()});
   expect(result.status).toBe('COMPLETED');expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Filho saída','Pai saída']);
   expect(result.state.variables.payload).toEqual({enabled:true});expect(reads.get(childId)).toBe(1);expect(fetch).not.toHaveBeenCalled();
  }finally{fetch.mockRestore();}
 });
 it('does not prepare a newly edited root with an archived child or a chain of nine',async()=>{
  const parent=graph([call('root-call',childId)]),child=published(childId,graph([node('reply','message',{text:'Filho'})]));
  await expect(fixture(parent,new Map([[childId,child]]),{archived:childId}).service.simulate(org,rootId,{text:'Oi'})).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_ARCHIVED',details:[{nodeId:'root-call',field:'data.automationId',code:'SUBFLOW_ARCHIVED'}]});
  const tree=chain(9);tree.versions.delete(rootId);
  await expect(fixture(tree.root.graph,tree.versions).service.simulate(org,rootId,{text:'Oi'})).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_DEPTH_LIMIT',details:[{nodeId:'root-call',code:'SUBFLOW_DEPTH_LIMIT'}]});
 });
 it('reuses one immutable dependency across sibling calls instead of resolving it again inside the engine',async()=>{
  const parent=graph([call('one',childId),call('two',childId)]),child=published(childId,graph([node('reply','message',{text:'Filho'})]));
  const {service,reads}=fixture(parent,new Map([[childId,child]]));const result=await service.simulate(org,rootId,{text:'Oi'});
  expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Filho','Filho']);expect(reads.get(childId)).toBe(1);
 });
 it('copies and freezes prepared versions and rejects any resolver reference outside the snapshot',async()=>{
  const parent=graph([call('root-call',childId)]),child=published(childId,graph([node('reply','message',{text:'Original'})]));
  const f=fixture(parent,new Map([[childId,child]]));const snapshot=await prepareSubflowSnapshot(f.tx,org,published(rootId,parent),f.repository,'NEW');
  child.graph.nodes[1]!.data.text='Alterado';expect((await snapshot.resolve(childId,7)).graph.nodes[1]!.data.text).toBe('Original');
  expect(Object.isFrozen(snapshot.root.graph.nodes[0]!.data)).toBe(true);expect(Object.isFrozen(snapshot.versions)).toBe(true);
  await expect(snapshot.resolve(childId,9)).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_SNAPSHOT_REFERENCE_MISSING'});
  expect(parent.nodes[0]!.data.dependencyPolicyVersion).toBeUndefined();
 });
 it('accepts 32 unique versions including the root and rejects a 33rd version without counting repeated calls',async()=>{
  const ids=Array.from({length:32},(_,i)=>`55555555-5555-4555-8555-${String(i+1).padStart(12,'0')}`);
  const children=new Map(ids.map(id=>[id,published(id,graph([]))]));
  const accepted=graph([...ids.slice(0,31).map((id,i)=>call('call-'+i,id)),call('repeat',ids[0]!)]),f=fixture(accepted,children);
  expect((await prepareSubflowSnapshot(f.tx,org,published(rootId,accepted),f.repository,'NEW')).versions).toHaveLength(32);
  const rejected=graph(ids.map((id,i)=>call('call-'+i,id))),r=fixture(rejected,children);
  await expect(prepareSubflowSnapshot(r.tx,org,published(rootId,rejected),r.repository,'NEW')).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_VERSION_LIMIT'});
 });
 it('measures aggregate UTF-8 bytes and accepts exactly 2 MiB before rejecting one extra byte',async()=>{
  const ids=Array.from({length:9},(_,i)=>`66666666-6666-4666-8666-${String(i+1).padStart(12,'0')}`);
  const parent=graph(ids.map((id,i)=>call('call-'+i,id))),children=new Map(ids.map(id=>[id,published(id,graph([]))]));
  for(const child of children.values())child.graph.nodes[0]!.data.padding='é'.repeat(110000);
  const total=()=>Buffer.byteLength(JSON.stringify(withDependencyPolicyV1(parent)),'utf8')+[...children.values()].reduce((sum,child)=>sum+Buffer.byteLength(JSON.stringify(child.graph),'utf8'),0);
  children.get(ids.at(-1)!)!.graph.nodes[0]!.data.padding+='x'.repeat(SUBFLOW_MAX_GRAPH_BYTES-total());
  expect(total()).toBe(SUBFLOW_MAX_GRAPH_BYTES);const f=fixture(parent,children);
  expect((await prepareSubflowSnapshot(f.tx,org,published(rootId,parent),f.repository,'NEW')).versions).toHaveLength(10);
  children.get(ids.at(-1)!)!.graph.nodes[0]!.data.padding+='x';
  await expect(prepareSubflowSnapshot(f.tx,org,published(rootId,parent),f.repository,'NEW')).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_SIZE_LIMIT'});
 });
 it('allows archived fixed children in historical preparation while keeping the root policy across child markers',async()=>{
  const tree=chain(9);tree.versions.get([...tree.versions.keys()][4]!)!.graph.nodes[0]!.data.dependencyPolicyVersion=1;
  const children=new Map(tree.versions);children.delete(rootId);const archived=[...children.keys()][0]!;
  const f=fixture(tree.root.graph,children,{archived});
  const snapshot=await prepareSubflowSnapshot(f.tx,org,tree.root,f.repository,'HISTORICAL');
  expect((await executeAutomation(snapshot.root,input,snapshot.resolve)).status).toBe('COMPLETED');
  const newRoot={...tree.root,graph:withDependencyPolicyV1(tree.root.graph)};
  await expect(prepareSubflowSnapshot(f.tx,org,newRoot,f.repository,'HISTORICAL')).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_DEPTH_LIMIT'});
 });
 it('revalidates a child archived between preflight and the locked final publication transaction',async()=>{
  const parent=graph([call('root-call',childId)]),child=published(childId,graph([])),f=fixture(parent,new Map([[childId,child]]));
  const insert=vi.fn();Object.assign(f.repository,{insertVersion:insert});let transactions=0;
  const service=createAutomationService({repository:f.repository,transact:async(_org,work)=>{
   if(++transactions===2)f.definitions.get(childId)!.lifecycleStatus='ARCHIVED';return work(f.tx);
  }});
  await expect(service.publish(org,rootId,1)).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_ARCHIVED'});
  expect(insert).not.toHaveBeenCalled();expect(f.reads.get(childId)).toBe(1);
 });
 it('assigns the root policy only in the published graph and rejects client downgrade before any insertion',async()=>{
  const parent=graph([]),f=fixture(parent,new Map());
  const insert=vi.fn(async(_tx:unknown,value:{id:string;version:number;graph:AutomationGraphV1;checksum:string;runtimeStateVersion:2})=>({automationId:value.id,organizationId:org,version:value.version,graph:value.graph,checksum:value.checksum,runtimeStateVersion:value.runtimeStateVersion,publishedAt:input.now}));
  Object.assign(f.repository,{insertVersion:insert,activateVersion:vi.fn()});
  const result=await f.service.publish(org,rootId,1);expect(result.graph.nodes[0]!.data.dependencyPolicyVersion).toBe(1);
  expect(parent.nodes[0]!.data.dependencyPolicyVersion).toBeUndefined();expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  parent.nodes[0]!.data.dependencyPolicyVersion=0;
  await expect(f.service.publish(org,rootId,1)).rejects.toMatchObject({code:'AUTOMATION_DEPENDENCY_POLICY_INVALID'});expect(insert).toHaveBeenCalledTimes(1);
 });
 it('prepares a repeated dependency DAG with bounded validation work instead of expanding every path',async()=>{
  const tree=chain(5);for(const value of tree.versions.values()){
   const child=value.graph.nodes.find(item=>item.type==='subflow');if(child)value.graph=graph([call('one',String(child.data.automationId)),call('two',String(child.data.automationId)),call('three',String(child.data.automationId))]);
  }
  const children=new Map(tree.versions);children.delete(rootId);const f=fixture(tree.root.graph,children),validation=vi.spyOn(contracts,'validateAutomationGraph');
  try{expect((await prepareSubflowSnapshot(f.tx,org,tree.root,f.repository,'NEW')).versions).toHaveLength(6);expect(validation.mock.calls.length).toBeLessThanOrEqual(6);}
  finally{validation.mockRestore();}
 });
 it('still rejects a longer cached subtree and a repeated automation ID under another ancestor',async()=>{
  const tree=chain(8),shared=[...tree.versions.keys()][1]!,wrapper='77777777-7777-4777-8777-777777777777';
  tree.root.graph=graph([call('short-path',shared),call('long-path',wrapper)]);tree.versions.set(wrapper,published(wrapper,graph([call('cached-child',shared)])));
  const children=new Map(tree.versions);children.delete(rootId);const f=fixture(tree.root.graph,children);
  await expect(prepareSubflowSnapshot(f.tx,org,tree.root,f.repository,'NEW')).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_DEPTH_LIMIT',details:[{nodeId:'long-path'}]});
  const parent=graph([call('first',childId),call('second',wrapper)]),sharedChild=published(childId,graph([call('different-version',wrapper,8)]));
  const ancestor=published(wrapper,graph([call('memoized-child',childId)])),c=fixture(parent,new Map([[childId,sharedChild],[wrapper,ancestor]]));
  const original=c.repository.getVersion;c.repository.getVersion=async(tx,tenant,id,v)=>id===wrapper&&v===8?{...c.rows.get(wrapper)!,version:8,graph:graph([])}:original(tx,tenant,id,v);
  await expect(prepareSubflowSnapshot(c.tx,org,published(rootId,parent),c.repository,'NEW')).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_RECURSION',details:[{nodeId:'second'}]});
 });
 it('retains root policy and pinned parent returns after a wait and a replacement engine turn',async()=>{
  for(const [depth,policy] of [[9,undefined],[8,1]] as const){
   const tree=chain(depth,policy),leaf=tree.versions.get([...tree.versions.keys()].at(-1)!)!;
   leaf.graph=graph([node('answer','input',{text:'Nome?',variable:'answer'}),node('leaf-message','message',{text:'Olá {{answer}}'})]);
   tree.versions.get([...tree.versions.keys()][4]!)!.graph.nodes[0]!.data.dependencyPolicyVersion=1;
   const waiting=await executeAutomation(tree.root,input,tree.resolve);expect(waiting.status).toBe('WAITING');expect(waiting.state.stack).toHaveLength(depth);
   const state=JSON.parse(JSON.stringify(waiting.state));const done=await executeAutomation(tree.root,{...input,text:'Ana',now:new Date(input.now.getTime()+100)},tree.resolve,state);
   expect(done.status).toBe('COMPLETED');expect(done.state.stack).toEqual([]);expect(done.state.automationId).toBe(rootId);expect(done.effects.map(effect=>effect.payload.text)).toEqual(['Olá Ana']);
  }
 });
 it('preserves canonical timeout and input/output-schema errors for a newly marked root',async()=>{
  const parent=published(rootId,graph([call('root-call',childId)],{dependencyPolicyVersion:1}));
  parent.graph.nodes[1]!.data.input={count:0};parent.graph.nodes[1]!.data.inputSchema={type:'object',required:['count'],properties:{count:{type:'integer'}}};
  parent.graph.nodes[1]!.data.outputSchema={type:'object',required:['completed'],properties:{completed:{type:'boolean'}}};
  const child=published(childId,graph([node('set','variable',{variable:'completed',value:false})]));
  expect((await executeAutomation(parent,input,async()=>child)).status).toBe('COMPLETED');
  parent.graph.nodes[1]!.data.input={count:false};await expect(executeAutomation(parent,input,async()=>child)).rejects.toThrow('AUTOMATION_SUBFLOW_INPUT_SCHEMA_INVALID');
  parent.graph.nodes[1]!.data.input={count:0};child.graph=graph([]);await expect(executeAutomation(parent,input,async()=>child)).rejects.toThrow('AUTOMATION_SUBFLOW_OUTPUT_SCHEMA_INVALID');
  child.graph=graph([node('wait','input',{text:'Nome?',variable:'answer'})]);const waiting=await executeAutomation(parent,input,async()=>child);
  await expect(executeAutomation(parent,{...input,text:'Ana',now:new Date(input.now.getTime()+10001)},async()=>child,waiting.state)).rejects.toThrow('AUTOMATION_SUBFLOW_TIMEOUT');
 });
});
