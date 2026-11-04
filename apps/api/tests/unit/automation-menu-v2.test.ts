import {describe,expect,it} from 'vitest';
import {automationNodePorts,validateAutomationGraph} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {PublishedAutomation,RuntimeState} from '../../src/modules/automations/types.js';

const now=new Date('2026-11-04T12:00:00Z');
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const menu={menuConfigVersion:2,maxAttempts:3,timeoutSeconds:300,errorMessage:'Opção inválida. Invalid option.',
  text:'Choose / Escolha',variable:'choice',options:[{value:'1',label:'Português'},{value:'2',label:'English'}]};
const definition=():PublishedAutomation=>({automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,
  graph:{nodes:[node('start','start'),node('menu','menu',menu),node('ok','message',{text:'Accepted'}),
    node('timeout','message',{text:'Timeout HML'}),node('exhausted','message',{text:'Limit HML'}),node('end','end')],
    edges:[edge('start','menu'),edge('menu','ok','option-1'),edge('menu','ok','option-2'),edge('menu','timeout','timeout'),
      edge('menu','exhausted','exhausted'),edge('ok','end'),edge('timeout','end'),edge('exhausted','end')]}});
const run=(root:PublishedAutomation,text:string,state?:RuntimeState,at=now,eventType:'MESSAGE'|'TIMER'='MESSAGE',waitId=state?.waiting?.waitId)=>
  executeAutomation(root,{text,eventType,now:at,...(waitId?{inputWait:{waitId,admittedAt:at.getTime()}}:{})},async()=>root,state);
const persisted=(state:RuntimeState):RuntimeState=>JSON.parse(JSON.stringify(state));

describe('opt-in menu V2 localized retry and durable deadline',()=>{
  it('validates the new policy and exposes both configured terminal branches',()=>{
    const root=definition();expect(validateAutomationGraph(root.graph)).toEqual([]);
    expect(automationNodePorts(root.graph.nodes[1]!)).toEqual(['option-1','option-2','exhausted','timeout']);
  });
  it('repeats only the current menu after the configured bilingual error, without a new greeting',async()=>{
    const root=definition(),first=await run(root,'Hello');
    expect(first.wait).toMatchObject({kind:'EVENT',waitId:expect.any(String),deadlineAt:new Date(now.getTime()+300_000)});
    const invalid=await run(root,'original free text',persisted(first.state));
    expect(invalid.effects.map(effect=>effect.payload.text)).toEqual(['Opção inválida. Invalid option.\nChoose / Escolha\n1 - Português\n2 - English']);
    expect(invalid.state.variables.message).toBe('original free text');
    expect(invalid.state.waiting).toMatchObject({invalidAttempts:1,deadlineAt:now.getTime()+300_000});
    expect(invalid.state.waiting?.waitId).not.toBe(first.state.waiting?.waitId);
  });
  it('keeps the original deadline and attempt budget after worker replacement and exhausts once',async()=>{
    const root=definition();let result=await run(root,'Hello');const deadline=result.state.waiting?.deadlineAt;
    for(let index=1;index<=2;index++){
      result=await run(root,'invalid',persisted(result.state),new Date(now.getTime()+index*1000));
      expect(result.state.waiting).toMatchObject({invalidAttempts:index,deadlineAt:deadline});
    }
    result=await run(root,'invalid',persisted(result.state),new Date(now.getTime()+3000));
    expect(result).toMatchObject({status:'COMPLETED',effects:[{kind:'SEND_TEXT',payload:{text:'Limit HML'}}]});
    expect(result.state.waiting).toBeUndefined();
  });
  it('ignores a reply admitted for an obsolete wait rather than consuming an attempt',async()=>{
    const root=definition(),first=await run(root,'Hello'),invalid=await run(root,'invalid',first.state);
    const stale=await run(root,'2',persisted(invalid.state),now,'MESSAGE',first.state.waiting!.waitId);
    expect(stale.effects).toEqual([]);expect(stale.state.waiting).toEqual(invalid.state.waiting);
    expect(stale.state.variables.choice).toBeUndefined();
  });
  it('times out exactly at the configured boundary, while an early timer has no effect',async()=>{
    const root=definition(),first=await run(root,'Hello');
    expect((await run(root,'',first.state,new Date(now.getTime()+299_999),'TIMER')).effects).toEqual([]);
    const expired=await run(root,'',persisted(first.state),new Date(now.getTime()+300_000),'TIMER');
    expect(expired.effects.map(effect=>effect.payload.text)).toEqual(['Timeout HML']);
    expect(expired.status).toBe('COMPLETED');
  });
  it('does not consume a valid choice admitted after the deadline',async()=>{
    const root=definition(),first=await run(root,'Hello');
    const late=await run(root,'2',first.state,new Date(now.getTime()+300_001));
    expect(late.effects.map(effect=>effect.payload.text)).toEqual(['Timeout HML']);
    expect(late.state.variables.choice).toBeUndefined();
  });
  it('accepts the selected numeric option without changing the other branches',async()=>{
    const root=definition(),first=await run(root,'Hello'),result=await run(root,' 2 ',persisted(first.state));
    expect(result).toMatchObject({status:'COMPLETED',state:{variables:{choice:'2'}},effects:[{kind:'SEND_TEXT',payload:{text:'Accepted'}}]});
  });
});
