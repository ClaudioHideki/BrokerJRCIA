import {describe,expect,it} from 'vitest';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {PublishedAutomation,RuntimeInput,RuntimeState} from '../../src/modules/automations/types.js';

const origin=new Date('2026-10-15T12:00:00.000Z').getTime();
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const graph={nodes:[node('start','start'),node('capture','input',{inputConfigVersion:1,variable:'answer',text:'Nome?',timeoutSeconds:5}),node('answered','message',{text:'Recebido {{answer}}'}),node('expired','message',{text:'Prazo encerrado'}),node('end','end')],edges:[edge('start','capture'),edge('capture','answered'),edge('capture','expired','timeout'),edge('answered','end'),edge('expired','end')]};
const root:PublishedAutomation={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph};
const resolve=async()=>root;
const event=(eventType:RuntimeInput['eventType'],offset:number,waitId?:string,admittedAt?:number):RuntimeInput=>({text:eventType==='MESSAGE'?'Maria':'',eventType,now:new Date(origin+offset),...(waitId?{inputWait:{waitId,...(admittedAt===undefined?{}:{admittedAt:origin+admittedAt})}}:{})} as RuntimeInput);
type InputWaiting={kind:string;nodeId:string;waitId?:string;deadlineAt?:number};
const wait=(state:RuntimeState)=>state.waiting as InputWaiting;
const begin=()=>executeAutomation(root,{text:'Oi',eventType:'MESSAGE',now:new Date(origin)},resolve);
const text=(result:Awaited<ReturnType<typeof executeAutomation>>)=>result.effects.map(effect=>effect.payload.text);

describe('capture deadline in the canonical engine',()=>{
  it('expires an exact child wait and returns through the original parent frame after restart',async()=>{
    const child={...root,automationId:'33333333-3333-4333-8333-333333333333'};
    const parent:PublishedAutomation={...root,graph:{nodes:[node('start','start'),node('call','subflow',{automationId:child.automationId,version:1,timeoutMs:30000}),node('parent','message',{text:'Retorno do pai'}),node('end','end')],edges:[edge('start','call'),edge('call','parent'),edge('parent','end')]}};
    const load=async(id:string)=>id===child.automationId?child:parent;
    const first=await executeAutomation(parent,{text:'Oi',eventType:'MESSAGE',now:new Date(origin)},load);
    expect(first.state.automationId).toBe(child.automationId);
    const result=await executeAutomation(parent,event('TIMER',5000,wait(first.state).waitId),load,JSON.parse(JSON.stringify(first.state)) as RuntimeState);
    expect(text(result)).toEqual(['Prazo encerrado','Retorno do pai']);
    expect(result.state).toMatchObject({automationId:parent.automationId,version:1,stack:[],variables:{message:'Oi'}});
  });
  it('persists an absolute deadline and unique wait identity for the current attempt',async()=>{
    const result=await begin();
    expect(wait(result.state)).toMatchObject({kind:'EVENT',nodeId:'capture',deadlineAt:origin+5000,waitId:expect.stringMatching(/^[a-f0-9-]{36}$/u)});
    expect(result.wait).toMatchObject({kind:'EVENT',nodeId:'capture',deadlineAt:new Date(origin+5000),waitId:wait(result.state).waitId});
  });
  it('takes timeout once at the deadline without replacing the latest customer message',async()=>{
    const first=await begin();
    const result=await executeAutomation(root,event('TIMER',5000,wait(first.state).waitId),resolve,first.state);
    expect(result.status).toBe('COMPLETED');
    expect(text(result)).toEqual(['Prazo encerrado']);
    expect(result.state.variables).toEqual({message:'Oi'});
    expect(text(await executeAutomation(root,event('TIMER',6000,wait(first.state).waitId),resolve,result.state))).toEqual([]);
  });
  it('keeps the same persisted deadline while an early timer or worker replacement waits',async()=>{
    const first=await begin(),saved=JSON.parse(JSON.stringify(first.state)) as RuntimeState;
    await expect(executeAutomation(root,event('TIMER',4999,wait(saved).waitId),resolve,saved)).resolves.toMatchObject({status:'WAITING',state:{waiting:wait(saved)},effects:[]});
    expect(wait(saved).deadlineAt).toBe(origin+5000);
  });
  it('accepts an answer admitted at the deadline even when execution runs later',async()=>{
    const first=await begin();
    const result=await executeAutomation(root,event('MESSAGE',9000,wait(first.state).waitId,5000),resolve,first.state);
    expect(result.status).toBe('COMPLETED');
    expect(text(result)).toEqual(['Recebido Maria']);
    expect(result.state.variables.answer).toBe('Maria');
  });
  it('takes timeout for an answer admitted after the deadline without capturing its text',async()=>{
    const first=await begin();
    const result=await executeAutomation(root,event('MESSAGE',9000,wait(first.state).waitId,5001),resolve,first.state);
    expect(text(result)).toEqual(['Prazo encerrado']);
    expect(result.state.variables).toEqual({message:'Oi'});
  });
  it('ignores a different wait identity and any identity forged in an external payload',async()=>{
    const first=await begin(),before=JSON.stringify(first.state);
    const wrong=event('MESSAGE',1000,'22222222-2222-4222-8222-222222222222',1000);
    await expect(executeAutomation(root,wrong,resolve,first.state)).resolves.toMatchObject({status:'WAITING',effects:[],state:first.state});
    const forged={...event('MESSAGE',1000),payload:{inputWait:{waitId:wait(first.state).waitId,admittedAt:origin+1000},waitId:wait(first.state).waitId,admittedAt:origin+1000}};
    await expect(executeAutomation(root,forged,resolve,first.state)).resolves.toMatchObject({status:'WAITING',effects:[],state:first.state});
    expect(JSON.stringify(first.state)).toBe(before);
  });
  it('allocates another wait identity on reentry so an old timer cannot expire it',async()=>{
    const loop={...root,graph:{...graph,edges:graph.edges.map(item=>item.source==='capture'&&item.port==='next'?{...item,target:'capture'}:item)}};
    const first=await executeAutomation(loop,{text:'Oi',eventType:'MESSAGE',now:new Date(origin)},resolve);
    const second=await executeAutomation(loop,event('MESSAGE',1000,wait(first.state).waitId,1000),resolve,first.state);
    expect(wait(second.state).waitId).not.toBe(wait(first.state).waitId);
    expect(wait(second.state).deadlineAt).toBe(origin+6000);
    await expect(executeAutomation(loop,event('TIMER',7000,wait(first.state).waitId),resolve,second.state)).resolves.toMatchObject({status:'WAITING',effects:[],state:second.state});
  });
  it('keeps an unmarked input indefinitely waiting and captures its next message as before',async()=>{
    const legacy={...root,graph:{...graph,nodes:graph.nodes.map(item=>item.id==='capture'?node('capture','input',{variable:'answer',text:'Nome?',timeoutSeconds:5}):item)}};
    const first=await executeAutomation(legacy,{text:'Oi',eventType:'MESSAGE',now:new Date(origin)},resolve);
    expect(wait(first.state)).not.toHaveProperty('deadlineAt');
    const result=await executeAutomation(legacy,event('MESSAGE',100000),resolve,first.state);
    expect(result.state.variables.answer).toBe('Maria');
    expect(text(result)).toEqual(['Recebido Maria']);
  });
});
