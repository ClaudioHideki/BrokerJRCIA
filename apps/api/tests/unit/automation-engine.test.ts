import { describe, expect, it } from 'vitest';
import { AUTOMATION_NODE_DEFINITIONS, automationNodePorts, type AutomationGraphV1 } from '@jrc/contracts';
import { executeAutomation, validateAutomationGraph } from '../../src/modules/automations/engine.js';

const handoffConfig={handoffVersion:1,destination:{integrationId:'22222222-2222-4222-8222-222222222222',destinationRevision:2,accountId:4,inboxId:8,credentialRevision:3},target:{teamId:7,agentId:null}};
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
describe('automation runtime v2 engine',()=>{
  it('routes business hours by the supplied clock and configured timezone, with date exceptions',async()=>{
    const graph={nodes:[node('start','start'),node('hours','schedule',{timezone:'America/Sao_Paulo',weekly:[{day:2,start:'09:00',end:'18:00'}],exceptions:[{date:'2030-01-01',intervals:[]}]}),node('open','message',{text:'Aberto'}),node('closed','message',{text:'Fechado'}),node('end','end')],edges:[{id:'s',source:'start',target:'hours',port:'next'},{id:'o',source:'hours',target:'open',port:'open'},{id:'c',source:'hours',target:'closed',port:'closed'},{id:'oe',source:'open',target:'end',port:'next'},{id:'ce',source:'closed',target:'end',port:'next'}]};
    const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,graph,runtimeStateVersion:2 as const};
    expect(validateAutomationGraph(graph)).toEqual([]);
    const resolve=async()=>{throw new Error('unexpected dependency');};
    for(const [at,text] of [['2030-01-01T15:00:00Z','Fechado'],['2030-01-08T12:00:00Z','Aberto'],['2030-01-08T21:00:00Z','Fechado']]){
      const result=await executeAutomation(root,{text:'Olá',eventType:'MESSAGE',now:new Date(at!)},resolve);
      expect(result).toMatchObject({status:'COMPLETED',effects:[{kind:'SEND_TEXT',payload:{text}}]});
      expect(result.trace.find(entry=>entry.nodeId==='hours')?.output).toMatchObject({open:text==='Aberto',timezone:'America/Sao_Paulo'});
    }
  });
  it.each(AUTOMATION_NODE_DEFINITIONS.filter(definition=>definition.availability==='AVAILABLE').map(definition=>definition.type))('executes and simulates available %s without external IO',async type=>{
    const configs:Record<string,Record<string,unknown>>={handoff:handoffConfig,message:{text:'Olá'},input:{variable:'answer',text:'Nome?'},menu:{text:'Escolha',options:[{value:'1',label:'A'},{value:'2',label:'B'}]},condition:{field:'message',operator:'equals',value:'oi'},variable:{variable:'name',value:'Ana'},delay:{seconds:5}};
    const common={configVersion:2,target:'result',errorVariable:'failure'};
    Object.assign(configs,{'data-set':{...common,valueSource:{kind:'LITERAL',value:{active:false}}},'data-rename':{...common,source:'message'},'data-pick':{...common,source:'message',keys:['name']},'data-merge':{...common,sources:['message','second']},'data-map':{...common,source:'message',field:'name'},'data-filter':{...common,source:'message',field:'name',operator:'equals',valueSource:{kind:'LITERAL',value:'A'}},'json-parse':{...common,source:'message'},'json-stringify':{...common,source:'message'},expression:{...common,source:'message',operation:'UPPER'}});
    configs.schedule={timezone:'UTC',weekly:[{day:1,start:'09:00',end:'18:00'}]};
    const current=node('current',type,configs[type]??{});
    const nodes=type==='start'?[current,node('end','end')]:['end','handoff'].includes(type)?[node('start','start'),current]:[node('start','start'),current,node('end','end')];
    const edges=type==='start'?[]:[{id:'s',source:'start',target:'current',port:'next'}];
    edges.push(...automationNodePorts(current).map(port=>({id:port,source:'current',target:'end',port})));
    const graph={nodes,edges};expect(validateAutomationGraph(graph)).toEqual([]);
    const result=await executeAutomation({automationId:'11111111-1111-4111-8111-111111111111',version:1,graph,runtimeStateVersion:2},{text:'oi',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('Unexpected external dependency');});
    expect(result.effects.every(effect=>effect.kind==='SEND_TEXT'||effect.kind==='HANDOFF')).toBe(true);
    expect(['WAITING','COMPLETED','HANDOFF']).toContain(result.status);
    if(type==='handoff')expect(result.effects).toEqual([{nodeId:'current',ordinal:0,kind:'HANDOFF',payload:handoffConfig}]);
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
  it('keeps an early timer waiting after serialization and ignores a message during the delay',async()=>{
    const graph={nodes:[node('start','start'),node('delay','delay',{seconds:5}),node('message','message',{text:'Pronto, {{message}}'}),node('end','end')],edges:[
      {id:'a',source:'start',target:'delay',port:'next'},{id:'b',source:'delay',target:'message',port:'next'},{id:'c',source:'message',target:'end',port:'next'}]} as AutomationGraphV1;
    const root={automationId:'11111111-1111-4111-8111-111111111111',version:3,graph,runtimeStateVersion:2 as const};
    const resolve=async()=>{throw new Error('unexpected dependency');};
    const first=await executeAutomation(root,{text:'original',eventType:'MESSAGE',now:new Date('2030-01-01T00:00:00Z')},resolve);
    const early=await executeAutomation(root,{text:'',eventType:'TIMER',now:new Date('2030-01-01T00:00:04Z')},resolve,JSON.parse(JSON.stringify(first.state)));
    expect(early).toMatchObject({status:'WAITING',effects:[],wait:{kind:'DELAY'}});
    expect(early.wait?.wakeAt?.toISOString()).toBe('2030-01-01T00:00:05.000Z');
    const ignored=await executeAutomation(root,{text:'nova',eventType:'MESSAGE',now:new Date('2030-01-01T00:00:04Z')},resolve,early.state);
    expect(ignored).toMatchObject({status:'WAITING',effects:[],state:{variables:{message:'original'}}});
    const due=await executeAutomation(root,{text:'',eventType:'TIMER',now:new Date('2030-01-01T00:00:05Z')},resolve,ignored.state);
    expect(due).toMatchObject({status:'COMPLETED',effects:[{kind:'SEND_TEXT',payload:{text:'Pronto, original'}}]});
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


describe('native URA menu handoff effect',()=>{
  const graph:AutomationGraphV1={nodes:[node('start','start'),node('menu','menu',{text:'Escolha',options:[{value:'1',label:'Comercial'},{value:'2',label:'Suporte'},{value:'3',label:'Financeiro'}]}),
    ...[7,8,9].map((teamId,index)=>node(`h${index+1}`,'handoff',{...handoffConfig,target:{teamId,agentId:null}}))],edges:[{id:'s',source:'start',target:'menu',port:'next'},...[1,2,3].map(index=>({id:`e${index}`,source:'menu',target:`h${index}`,port:`option-${index}`}))]};
  const root={automationId:'11111111-1111-4111-8111-111111111111',version:1,graph};
  const input=(text:string)=>({text,eventType:'MESSAGE' as const,now:new Date('2026-10-01T18:00:00Z')});
  it.each([1,2,3])('simulates menu selection %s with the complete pinned destination and no external resolver',async choice=>{
    const resolver=async()=>{throw new Error('Unexpected external dependency');};
    expect(validateAutomationGraph(graph)).toEqual([]);
    const first=await executeAutomation(root,input('oi'),resolver);
    expect(first.status).toBe('WAITING');expect(first.effects[0]?.payload.text).toContain('3 - Financeiro');
    const selected=await executeAutomation(root,input(String(choice)),resolver,first.state);
    expect(selected).toMatchObject({status:'HANDOFF',effects:[{kind:'HANDOFF',payload:{...handoffConfig,target:{teamId:choice+6,agentId:null}}}]});
    expect(selected.trace.at(-1)?.output).toEqual({status:'HANDOFF_PENDING',destination:handoffConfig.destination,target:{teamId:choice+6,agentId:null}});
  });
  it('repeats invalid menu answers without emitting a handoff',async()=>{
    const resolver=async()=>{throw new Error('Unexpected dependency');};
    const first=await executeAutomation(root,input('oi'),resolver);
    const invalid=await executeAutomation(root,input('9'),resolver,first.state);
    expect(invalid.status).toBe('WAITING');expect(invalid.effects.every(effect=>effect.kind==='SEND_TEXT')).toBe(true);
  });
  it('rejects partial native config and keeps empty legacy payload explicitly unconfirmed',async()=>{
    const simple=(data:Record<string,unknown>)=>({...root,graph:{nodes:[node('start','start'),node('h','handoff',data)],edges:[{id:'s',source:'start',target:'h',port:'next'}]}});
    await expect(executeAutomation(simple({handoffVersion:1}),input('oi'),async()=>root)).rejects.toThrow('AUTOMATION_HANDOFF_CONFIG_INVALID');
    const legacy=await executeAutomation(simple({}),input('oi'),async()=>root);
    expect(legacy.effects[0]?.payload).toEqual({});expect(legacy.trace.at(-1)?.output).toEqual({status:'ACTION_REQUIRED',reason:'HANDOFF_DESTINATION_REQUIRED'});
  });
});
