import { describe, expect, it } from 'vitest';
import { AUTOMATION_NODE_DEFINITIONS, automationNodePorts, type AutomationGraphV1 } from '@jrc/contracts';
import { executeAutomation, validateAutomationGraph } from '../../src/modules/automations/engine.js';

const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
describe('automation runtime v2 engine',()=>{
  it.each(AUTOMATION_NODE_DEFINITIONS.filter(definition=>definition.availability==='AVAILABLE').map(definition=>definition.type))('executes and simulates available %s without external IO',async type=>{
    const configs:Record<string,Record<string,unknown>>={message:{text:'Olá'},input:{variable:'answer',text:'Nome?'},menu:{text:'Escolha',options:[{value:'1',label:'A'},{value:'2',label:'B'}]},condition:{field:'message',operator:'equals',value:'oi'},variable:{variable:'name',value:'Ana'}};
    const current=node('current',type,configs[type]??{});
    const nodes=type==='start'?[current,node('end','end')]:type==='end'?[node('start','start'),current]:[node('start','start'),current,node('end','end')];
    const edges=type==='start'?[]:[{id:'s',source:'start',target:'current',port:'next'}];
    edges.push(...automationNodePorts(current).map(port=>({id:port,source:'current',target:'end',port})));
    const graph={nodes,edges};expect(validateAutomationGraph(graph)).toEqual([]);
    const result=await executeAutomation({automationId:'11111111-1111-4111-8111-111111111111',version:1,graph},{text:'oi',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('Unexpected external dependency');});
    expect(result.effects.every(effect=>effect.kind==='SEND_TEXT')).toBe(true);
    expect(['WAITING','COMPLETED']).toContain(result.status);
    if(type==='message')expect(result.effects[0]?.payload.text).toBe('Olá');
    if(type==='variable')expect(result.state.variables.name).toBe('Ana');
    if(type==='input'||type==='menu')expect(result.wait?.kind).toBe('EVENT');
  });
  it('keeps a valid historical SQL graph executable although new creation is unavailable', async()=>{
    const sql=node('sql','sql',{target:'result',credentialId:'22222222-2222-4222-8222-222222222222',query:'SELECT 1'});
    const graph={nodes:[node('start','start'),sql,node('end','end')],edges:[{id:'s',source:'start',target:'sql',port:'next'},...automationNodePorts(sql).map(port=>({id:port,source:'sql',target:'end',port}))]};
    expect(validateAutomationGraph(graph)).toEqual([]);
    const result=await executeAutomation({automationId:'11111111-1111-4111-8111-111111111111',version:1,graph},{text:'',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('unexpected');});
    expect(result).toMatchObject({status:'WAITING',effects:[{kind:'IO_SQL'}]});
  });
  it('persists a delay and resumes from the same immutable version',async()=>{
    const graph={nodes:[node('start','start'),node('delay','delay',{seconds:5}),node('message','message',{text:'Pronto, {{message}}'}),node('end','end')],edges:[
      {id:'a',source:'start',target:'delay',port:'next'},{id:'b',source:'delay',target:'message',port:'next'},{id:'c',source:'message',target:'end',port:'next'}]} as AutomationGraphV1;
    expect(validateAutomationGraph(graph)).toEqual([]);
    const root={automationId:'11111111-1111-4111-8111-111111111111',version:3,graph,runtimeStateVersion:2 as const};
    const first=await executeAutomation(root,{text:'olá',eventType:'MESSAGE',now:new Date('2030-01-01T00:00:00Z')},async()=>{throw new Error('unexpected');});
    expect(first).toMatchObject({status:'WAITING',wait:{kind:'DELAY',nodeId:'delay'}});expect(first.wait?.wakeAt?.toISOString()).toBe('2030-01-01T00:00:05.000Z');
    const resumed=await executeAutomation(root,{text:'',eventType:'TIMER',now:new Date('2030-01-01T00:00:05Z')},async()=>{throw new Error('unexpected');},first.state);
    expect(resumed.status).toBe('COMPLETED');expect(resumed.effects).toEqual([expect.objectContaining({kind:'SEND_TEXT',payload:{text:'Pronto, olá'}})]);
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
    expect(validateAutomationGraph(graph)).toEqual([]);const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,graph,runtimeStateVersion:2 as const};
    const first=await executeAutomation(root,{text:'oi',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('unexpected');});expect(first).toMatchObject({status:'WAITING',wait:{kind:'IO'},effects:[{kind:'IO_HTTP'}]});
    const resumed=await executeAutomation(root,{text:'',eventType:'RESUME',now:new Date(),payload:{outcome:'success',output:{status:200}}},async()=>{throw new Error('unexpected');},first.state);expect(resumed.status).toBe('COMPLETED');expect(resumed.state.variables['http.result']).toEqual({status:200});
  });
});
