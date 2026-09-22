import { describe, expect, it } from 'vitest';
import type { AutomationGraphV1 } from '@jrc/contracts';
import { executeAutomation, validateAutomationGraph } from '../../src/modules/automations/engine.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
describe('automation runtime v2 engine',()=>{
  it('persists a delay and resumes from the same immutable version',async()=>{
    const graph={nodes:[node('start','start'),node('delay','delay',{seconds:5}),node('message','message',{text:'Pronto, {{message}}'}),node('end','end')],edges:[
      {id:'a',source:'start',target:'delay',port:'next'},{id:'b',source:'delay',target:'message',port:'next'},{id:'c',source:'message',target:'end',port:'next'}]} as AutomationGraphV1;
    expect(validateAutomationGraph(graph)).toEqual([]);
    const root={automationId:'11111111-1111-4111-8111-111111111111',version:3,graph};
    const first=await executeAutomation(root,{text:'olá',eventType:'MESSAGE',now:new Date('2030-01-01T00:00:00Z')},async()=>{throw new Error('unexpected');});
    expect(first).toMatchObject({status:'WAITING',wait:{kind:'DELAY',nodeId:'delay'}});expect(first.wait?.wakeAt?.toISOString()).toBe('2030-01-01T00:00:05.000Z');
    const resumed=await executeAutomation(root,{text:'',eventType:'TIMER',now:new Date('2030-01-01T00:00:05Z')},async()=>{throw new Error('unexpected');},first.state);
    expect(resumed.status).toBe('COMPLETED');expect(resumed.effects).toEqual([expect.objectContaining({kind:'SEND_TEXT',payload:{text:'Pronto, '}})]);
  });
  it('pins subflow versions and rejects runtime recursion',async()=>{
    const child={nodes:[node('child-start','start'),node('child-message','message',{text:'filho'}),node('child-end','end')],edges:[{id:'a',source:'child-start',target:'child-message',port:'next'},{id:'b',source:'child-message',target:'child-end',port:'next'}]} as AutomationGraphV1;
    const childId='22222222-2222-4222-8222-222222222222',rootId='11111111-1111-4111-8111-111111111111';
    const parent={nodes:[node('start','start'),node('call','subflow',{automationId:childId,version:7}),node('end','end')],edges:[{id:'a',source:'start',target:'call',port:'next'},{id:'b',source:'call',target:'end',port:'next'}]} as AutomationGraphV1;
    const result=await executeAutomation({automationId:rootId,version:2,graph:parent},{text:'',eventType:'MESSAGE',now:new Date()},async(id,version)=>({automationId:id,version,graph:child}));
    expect(result.status).toBe('COMPLETED');expect(result.effects[0]).toMatchObject({payload:{text:'filho'}});
    const recursive={...parent,nodes:parent.nodes.map(item=>item.id==='call'?{...item,data:{automationId:rootId,version:2}}:item)};
    await expect(executeAutomation({automationId:rootId,version:2,graph:recursive},{text:'',eventType:'MESSAGE',now:new Date()},async()=>({automationId:rootId,version:2,graph:recursive}))).rejects.toThrow('AUTOMATION_SUBFLOW_RECURSION');
  });
  it('queues isolated IO and resumes through its typed outcome',async()=>{
    const graph={nodes:[node('start','start'),node('request','http',{method:'GET',url:'https://api.example.com/health',credentialId:'22222222-2222-4222-8222-222222222222',target:'http.result'}),node('ok','end'),node('client','end'),node('server','end'),node('timeout','end'),node('unknown','end')],edges:[
      {id:'a',source:'start',target:'request',port:'next'},...['success','client_error','server_error','timeout','unknown'].map((port,index)=>({id:`b${index}`,source:'request',target:port==='success'?'ok':port==='client_error'?'client':port==='server_error'?'server':port,port}))]} as AutomationGraphV1;
    expect(validateAutomationGraph(graph)).toEqual([]);const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,graph};
    const first=await executeAutomation(root,{text:'oi',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('unexpected');});expect(first).toMatchObject({status:'WAITING',wait:{kind:'IO'},effects:[{kind:'IO_HTTP'}]});
    const resumed=await executeAutomation(root,{text:'',eventType:'RESUME',now:new Date(),payload:{outcome:'success',output:{status:200}}},async()=>{throw new Error('unexpected');},first.state);expect(resumed.status).toBe('COMPLETED');expect(resumed.state.variables['http.result']).toBe('{"status":200}');
  });
});
