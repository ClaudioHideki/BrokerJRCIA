import {describe,it,expect} from 'vitest';
import {executeAutomation,validateAutomationGraph} from '../../src/modules/automations/engine.js';
import type {RuntimeState} from '../../src/modules/automations/types.js';
import type {AutomationGraphV1} from '@jrc/contracts';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const graph:AutomationGraphV1={nodes:[node('start','start',{entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS',menuNavigationVersion:1}),
  node('root','menu',{text:'Sistema',options:[{value:'1',label:'Sistema A'},{value:'2',label:'Sistema B'}]}),
  node('profile','menu',{text:'Perfil — digite voltar para retornar',options:[{value:'1',label:'Empresa'},{value:'2',label:'Vigilância'}],
    menuConfigVersion:2,maxAttempts:3,errorMessage:'Opção inválida'}),node('end','end')],
  edges:[{id:'a',source:'start',port:'next',target:'root'},
    {id:'b',source:'root',port:'option-1',target:'profile'},{id:'c',source:'root',port:'option-2',target:'end'},
    {id:'d',source:'profile',port:'option-1',target:'end'},{id:'e',source:'profile',port:'option-2',target:'end'},
    {id:'g',source:'profile',port:'exhausted',target:'end'}]};
const published={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2 as const,graph};
const resolve=async()=>{throw Error('No external dependency permitted')};
describe('opt-in menu back command',()=>{
  it.each(['voltar',' VOLTAR ','0'])('returns to the previous menu for %s without external effects',async text=>{
    expect(validateAutomationGraph(graph)).toEqual([]);
    const first=await executeAutomation(published,{text:'oi',eventType:'MESSAGE',now:new Date()},resolve);
    const profile=await executeAutomation(published,{text:'1',eventType:'MESSAGE',now:new Date()},resolve,first.state);
    const result=await executeAutomation(published,{text,eventType:'MESSAGE',now:new Date(),inputWait:{waitId:profile.state.waiting!.waitId!,admittedAt:Date.now()}},resolve,profile.state);
    expect(result.state.nodeId).toBe('root');
    expect(result.effects.every(effect=>effect.kind==='SEND_TEXT')).toBe(true);
  });
  it('restores branch variables and follows the actual path through a shared menu',async()=>{
    const sharedGraph:AutomationGraphV1={nodes:[graph.nodes[0]!,node('root','menu',{text:'Raiz',options:[{value:'1',label:'A'},{value:'2',label:'B'}]}),
      node('a','menu',{text:'A',variable:'branchA',options:[{value:'1',label:'Continuar'}]}),node('b','menu',{text:'B',variable:'branchB',options:[{value:'1',label:'Continuar'}]}),
      node('shared','menu',{text:'Compartilhado',options:[{value:'1',label:'Finalizar'}]}),node('end','end')],edges:[
      {id:'s',source:'start',port:'next',target:'root'},{id:'r1',source:'root',port:'option-1',target:'a'},{id:'r2',source:'root',port:'option-2',target:'b'},
      {id:'a1',source:'a',port:'option-1',target:'shared'},{id:'b1',source:'b',port:'option-1',target:'shared'},{id:'e',source:'shared',port:'option-1',target:'end'}]};
    const pub={...published,graph:sharedGraph};let state:RuntimeState|undefined;
    const send=async(text:string)=>{const r=await executeAutomation(pub,{text,eventType:'MESSAGE',now:new Date()},resolve,state);state=r.state;return r;};
    await send('oi');await send('2');await send('1');expect(state!.variables.branchB).toBe('1');
    await send('voltar');expect(state!.nodeId).toBe('b');expect(state!.variables.branchB).toBeUndefined();
    await send('0');expect(state!.nodeId).toBe('root');await send('1');await send('1');
    await send('0');expect(state!.nodeId).toBe('a');expect(state!.variables.branchB).toBeUndefined();
  });
  it('preserves the published behavior in flows without the opt-in policy',async()=>{
    const legacy={...published,graph:{...graph,nodes:graph.nodes.map(n=>n.type==='start'?{...n,data:{}}:n)}};
    const first=await executeAutomation(legacy,{text:'oi',eventType:'MESSAGE',now:new Date()},resolve);
    const r=await executeAutomation(legacy,{text:'voltar',eventType:'MESSAGE',now:new Date()},resolve,first.state);
    expect(r.state.nodeId).toBe('root');expect(r.state.menuTrail).toBeUndefined();
    expect(JSON.stringify(r.effects)).not.toContain('Digite 0');
  });
  it('returns safely from a child menu to its caller and can enter the child again',async()=>{
    const child={...published,automationId:'22222222-2222-4222-8222-222222222222',graph:{nodes:[node('cs','start'),node('cm','menu',{text:'Filho',options:[{value:'1',label:'Concluir'}]}),node('ce','end')],edges:[{id:'c1',source:'cs',port:'next',target:'cm'},{id:'c2',source:'cm',port:'option-1',target:'ce'}]}};
    const parent={...published,graph:{nodes:[graph.nodes[0]!,node('root','menu',{text:'Raiz',options:[{value:'1',label:'Filho'}]}),node('call','subflow',{automationId:child.automationId,version:1}),node('end','end')],edges:[{id:'p1',source:'start',port:'next',target:'root'},{id:'p2',source:'root',port:'option-1',target:'call'},{id:'p3',source:'call',port:'next',target:'end'}]}};
    const childResolve=async()=>child;let state:RuntimeState|undefined;
    const send=async(text:string)=>{const r=await executeAutomation(parent,{text,eventType:'MESSAGE',now:new Date()},childResolve,state);state=r.state;return r;};
    await send('oi');await send('1');expect(state!.automationId).toBe(child.automationId);expect(state!.stack).toHaveLength(1);
    await send('voltar');expect(state!.automationId).toBe(parent.automationId);expect(state!.nodeId).toBe('root');expect(state!.stack).toHaveLength(0);
    await send('1');expect((await send('1')).status).toBe('COMPLETED');
  });
  it('keeps the menu on invalid input and rejects stale waits',async()=>{
    const first=await executeAutomation(published,{text:'oi',eventType:'MESSAGE',now:new Date()},resolve);
    const profile=await executeAutomation(published,{text:'1',eventType:'MESSAGE',now:new Date()},resolve,first.state);
    const input={text:'voltar',eventType:'MESSAGE' as const,now:new Date(),inputWait:{waitId:'stale',admittedAt:Date.now()}};
    expect((await executeAutomation(published,input,resolve,profile.state)).state.nodeId).toBe('profile');
    const invalid=await executeAutomation(published,{...input,text:'inexistente',inputWait:{waitId:profile.state.waiting!.waitId!,admittedAt:Date.now()}},resolve,profile.state);
    expect(invalid.state.nodeId).toBe('profile');
    expect(invalid.state.waiting?.invalidAttempts).toBe(1);
  });
});
