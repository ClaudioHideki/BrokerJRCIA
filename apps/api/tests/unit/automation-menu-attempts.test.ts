import {describe,expect,it,vi} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation,RuntimeState} from '../../src/modules/automations/types.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const now=new Date('2030-01-01T00:00:00.000Z');
function definition(data:Record<string,unknown>={},version=1):PublishedAutomation{
 const bounded=data.menuConfigVersion!==undefined;
 return {automationId:'11111111-1111-4111-8111-111111111111',version,runtimeStateVersion:2,graph:{nodes:[node('start','start'),
  node('menu','menu',{text:'Escolha',variable:'choice',options:[{value:'1',label:'Suporte'},{value:'2',label:'Encerrar'}],...data}),
  node('ok','message',{text:'Escolha válida'}),node('end','end'),...(bounded?[node('fallback','message',{text:'Limite atingido'})]:[])],
  edges:[edge('start','menu'),edge('menu','ok','option-1'),edge('menu','end','option-2'),edge('ok','end'),...(bounded?[edge('menu','fallback','exhausted'),edge('fallback','end')]:[])]}};
}
const bounded=()=>definition({menuConfigVersion:1,maxAttempts:3});
const run=(root:PublishedAutomation,text:string,state?:RuntimeState,eventType:'MESSAGE'|'TIMER'|'RESUME'='MESSAGE')=>executeAutomation(root,{text,eventType,now},async()=>root,state);
const persisted=(state:RuntimeState):RuntimeState=>JSON.parse(JSON.stringify(state));
describe('canonical menu invalid-attempt budget',()=>{
 it('stores attempts in the wait and exhausts on the configured third invalid answer after serialization',async()=>{
  const root=bounded(),first=await run(root,'Olá');
  expect(first.state.waiting).toMatchObject({invalidAttempts:0});
  const once=await run(root,'x',persisted(first.state));
  expect(once.state.waiting).toMatchObject({invalidAttempts:1});expect(first.state.waiting).toMatchObject({invalidAttempts:0});
  const twice=await run(root,'x',persisted(once.state));expect(twice.state.waiting).toMatchObject({invalidAttempts:2});
  const final=await run(root,'x',persisted(twice.state));
  expect(final).toMatchObject({status:'COMPLETED',state:{version:1}});expect(final.state.waiting).toBeUndefined();
  expect(final.effects.map(effect=>effect.payload.text)).toEqual(['Limite atingido']);
  expect(final.trace).toContainEqual(expect.objectContaining({nodeId:'menu',output:expect.objectContaining({invalidAttempts:3,maxAttempts:3,port:'exhausted'})}));
 });
 it('takes a valid choice before exhaustion without a fallback or invalid choice variable',async()=>{
  const root=bounded(),first=await run(root,'Olá'),invalid=await run(root,'9',first.state),valid=await run(root,'1',invalid.state);
  expect(valid).toMatchObject({status:'COMPLETED',state:{variables:{choice:'1'}}});
  expect(valid.effects.map(effect=>effect.payload.text)).toEqual(['Escolha válida']);expect(invalid.state.variables.choice).toBeUndefined();
 });
 it('exhausts immediately on the first invalid reply when maxAttempts is one',async()=>{
  const root=definition({menuConfigVersion:1,maxAttempts:1}),first=await run(root,'Olá');
  const result=await run(root,'9',first.state);
  expect(result.status).toBe('COMPLETED');expect(result.effects.map(effect=>effect.payload.text)).toEqual(['Limite atingido']);
 });
 it('fails closed if an exhausted branch is absent in a damaged published graph',async()=>{
  const root=definition({menuConfigVersion:1,maxAttempts:1}),first=await run(root,'Olá');
  root.graph.edges=root.graph.edges.filter(edge=>edge.port!=='exhausted');
  await expect(run(root,'9',first.state)).rejects.toThrow('AUTOMATION_MENU_EXHAUSTED_CONNECTION_MISSING');
 });
 it('preserves repeated invalid responses for unconfigured menus and unmarked maxAttempts',async()=>{
  for(const data of [{},{maxAttempts:1}]){
   const root=definition(data);let result=await run(root,'Olá');
   for(let attempt=0;attempt<5;attempt++)result=await run(root,'9',persisted(result.state));
   expect(result.status).toBe('WAITING');expect(result.state.waiting).not.toHaveProperty('invalidAttempts');
  }
 });
 it.each(['TIMER','RESUME'] as const)('does not count a %s as an invalid menu answer',async kind=>{
  const root=bounded(),first=await run(root,'Olá'),once=await run(root,'9',first.state);
  const ignored=await run(root,'',persisted(once.state),kind);
  expect(ignored).toMatchObject({status:'WAITING',effects:[],state:{waiting:once.state.waiting}});
 });
 it('resets the budget when the same menu is entered again after an input node',async()=>{
  const root=bounded();root.graph.nodes.push(node('again','input',{variable:'next'}));
  root.graph.edges=root.graph.edges.filter(item=>item.id!=='menu:option-1');root.graph.edges.push(edge('menu','again','option-1'),edge('again','menu'));
  const first=await run(root,'Olá'),invalid=await run(root,'9',first.state),answer=await run(root,'1',invalid.state),again=await run(root,'continuar',answer.state);
  expect(again.state.waiting).toMatchObject({nodeId:'menu',invalidAttempts:0});
  expect((await run(root,'9',again.state)).state.waiting).toMatchObject({invalidAttempts:1});
 });
 it('continues a historical execution under its pinned graph after a bounded version is published',async()=>{
  const old=definition({},1),newer=definition({menuConfigVersion:1,maxAttempts:1},2),first=await run(old,'Olá');
  const result=await executeAutomation(newer,{text:'9',eventType:'MESSAGE',now},async()=>old,persisted(first.state));
  expect(result).toMatchObject({status:'WAITING',state:{version:1}});expect(result.state.waiting).not.toHaveProperty('invalidAttempts');
 });
 it('uses the same exhaustion path in simulation without external calls or consuming virtual time as a reply',async()=>{
  const root=bounded(),send=vi.spyOn(globalThis,'fetch');
  try{
   const preview=await simulateConversation(root,{text:'Olá',clock:now.toISOString(),events:[{type:'ELAPSE',seconds:60},...['9','x','0'].map(text=>({type:'MESSAGE' as const,text}))]},async()=>root);
   expect(preview.status).toBe('COMPLETED');expect(preview.effects.at(-1)?.payload.text).toBe('Limite atingido');expect(send).not.toHaveBeenCalled();
  }finally{send.mockRestore();}
 });
 it('fails closed for a corrupt bounded counter instead of restarting its budget',async()=>{
  const root=bounded(),first=await run(root,'Olá');
  for(const invalidAttempts of [-1,1.5,3,NaN]){
   const state={...first.state,waiting:{...first.state.waiting!,invalidAttempts}};
   await expect(run(root,'9',state)).rejects.toThrow('AUTOMATION_MENU_WAIT_INVALID');
  }
  const missing=persisted(first.state);delete missing.waiting!.invalidAttempts;
  await expect(run(root,'9',missing)).rejects.toThrow('AUTOMATION_MENU_WAIT_INVALID');
 });
});
