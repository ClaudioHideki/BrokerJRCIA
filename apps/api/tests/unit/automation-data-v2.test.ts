import {describe,expect,it} from 'vitest';
import {executeAutomation,validateAutomationGraph} from '../../src/modules/automations/engine.js';
import {simulateConversation} from '../../src/modules/automations/simulation.js';
import {executeDataNode} from '../../src/modules/automations/data-nodes.js';
import type {PublishedAutomation,RuntimeJson} from '../../src/modules/automations/types.js';
const node=(id:string,type:string,data:Record<string,unknown>)=>({id,type,label:id,position:{x:0,y:0},data});
const typed=(config:Record<string,unknown>)=>({configVersion:2,target:'result',errorVariable:'failure',...config});
const input={text:'hello',eventType:'MESSAGE' as const,now:new Date('2026-10-09T00:00:00Z')};
const resolve=async()=>{throw new Error('NO_EXTERNAL_RESOLVER');};
const graph=(type:string,data:Record<string,unknown>):PublishedAutomation=>({automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,
 graph:{nodes:[node('start','start',{}),node('transform',type,data),node('yes','message',{text:'success {{result}}'}),node('no','message',{text:'failed {{failure}}'}),node('end','end',{})],
 edges:[{id:'a',source:'start',target:'transform',port:'next'},{id:'b',source:'transform',target:'yes',port:'success'},
 {id:'c',source:'transform',target:'no',port:'error'},{id:'d',source:'yes',target:'end',port:'next'},{id:'e',source:'no',target:'end',port:'next'}]}});
describe('P3 local data execution',()=>{
 it('stores typed objects and literal template text without coercion',()=>{
  const variables:Record<string,RuntimeJson>={name:'Ana'};
  executeDataNode('data-set',typed({valueSource:{kind:'LITERAL',value:{template:'{{name}}',active:true,rows:[1,null]}}}),variables,'json');
  expect(variables.result).toEqual({template:'{{name}}',active:true,rows:[1,null]});
 });
 it('copies a flat dotted variable key as a reference, independently from field paths',()=>{
  const variables:Record<string,RuntimeJson>={'profile.name':{name:'A',nested:{value:2}}};
  executeDataNode('data-set',typed({valueSource:{kind:'VARIABLE',variable:'profile.name'}}),variables,'json');
  expect(variables.result).toEqual(variables['profile.name']);
  executeDataNode('data-pick',typed({source:'result',keys:['nested.value']}),variables,'json');
  expect(variables.result).toEqual({'nested.value':2});
 });
 it('does not consume a missing source or silently drop invalid merge members',()=>{
  const variables:Record<string,RuntimeJson>={result:'keep',first:{name:'A'},second:[]};
  expect(()=>executeDataNode('data-rename',typed({source:'absent'}),variables,'json')).toThrow('AUTOMATION_DATA_REFERENCE_MISSING');
  expect(()=>executeDataNode('data-merge',typed({sources:['first','second']}),variables,'json')).toThrow('AUTOMATION_DATA_OBJECT_REQUIRED');
  expect(variables.result).toBe('keep');
 });
 it('routes invalid JSON to a safe error branch without overwriting an earlier output',async()=>{
  const root=graph('json-parse',typed({source:'message'}));
  const result=await executeAutomation(root,{...input,text:'private malformed json'},resolve);
  expect(result.status).toBe('COMPLETED');
  expect(result.state.variables.failure).toEqual({code:'AUTOMATION_JSON_INVALID'});
  expect(result.effects).toHaveLength(1);
  expect(result.effects[0]?.payload.text).toBe('failed {"code":"AUTOMATION_JSON_INVALID"}');
  expect(result.trace.find(step=>step.nodeId==='transform')?.output).toEqual({outcome:'ERROR',code:'AUTOMATION_JSON_INVALID'});
 });
 it('runs a success branch with typed literal output and no data I/O effect',async()=>{
  const result=await executeAutomation(graph('data-set',typed({valueSource:{kind:'LITERAL',value:[false,3]}})),input,resolve);
  expect(result.status).toBe('COMPLETED');
  expect(result.effects.map(effect=>effect.kind)).toEqual(['SEND_TEXT']);
  expect(result.effects[0]?.payload.text).toBe('success [false,3]');
 });
 it('preserves historical legacy formatting and next-port execution',async()=>{
  const variables:Record<string,RuntimeJson>={source:'{"name":"A"}'};
  executeDataNode('data-pick',{target:'public',source:'source',keys:['name']},variables,'legacy');
  expect(variables.public).toBe('{"name":"A"}');
  const root=graph('data-set',{target:'result',value:{active:true}});
  root.graph.edges=root.graph.edges.filter(edge=>edge.port!=='error').map(edge=>edge.source==='transform'?{...edge,port:'next'}:edge);
  expect((await executeAutomation(root,input,resolve)).effects[0]?.payload.text).toBe('success {"active":true}');
 });
 it('simulates the exact typed engine without injecting any network or message adapter',async()=>{
  const root=graph('data-set',typed({valueSource:{kind:'LITERAL',value:{rows:[1,false],text:'ç'}}}));
  const actual=await executeAutomation(root,input,resolve);
  const simulated=await simulateConversation(root,{text:input.text,clock:input.now.toISOString()},resolve);
  expect(simulated).toEqual(actual);
  expect(simulated.effects.map(effect=>effect.kind)).toEqual(['SEND_TEXT']);
 });
 it('uses the same strict field diagnostics and typed ports for publication as execution',()=>{
  expect(validateAutomationGraph(graph('data-set',typed({valueSource:{kind:'LITERAL',value:true}})).graph)).toEqual([]);
  const diagnostics=validateAutomationGraph(graph('data-pick',typed({source:'constructor.x',keys:['name']})).graph);
  expect(diagnostics).toContainEqual(expect.objectContaining({nodeId:'transform',field:'data.source',code:'INVALID_CONFIG'}));
 });
 it('executes every local transformation with typed results rather than text coercion',()=>{
  const variables:Record<string,RuntimeJson>={first:{name:'A'},second:{active:true},rows:[{name:'A',active:true},{name:'B',active:false}],raw:'{"count":2}',text:' A '};
  const cases:[string,Record<string,unknown>,RuntimeJson][]=[
   ['data-rename',{source:'first'},{name:'A'}],
   ['data-pick',{source:'second',keys:['active']},{active:true}],
   ['data-merge',{sources:['result','second']},{active:true}],
   ['data-map',{source:'rows',field:'name'},['A','B']],
   ['data-filter',{source:'rows',field:'active',operator:'equals',valueSource:{kind:'LITERAL',value:true}},[{name:'A',active:true}]],
   ['json-parse',{source:'raw'},{count:2}],
   ['json-stringify',{source:'second'},'{"active":true}'],
   ['expression',{source:'text',operation:'TRIM'},'A'],
  ];
  for(const [type,config,expected] of cases){executeDataNode(type,typed(config),variables,'json');expect(variables.result,type).toEqual(expected);}
  expect(Object.hasOwn(variables,'first')).toBe(false);
 });
 it('does not overwrite destination or rename source when a JSON result exceeds its limit',()=>{
  const variables:Record<string,RuntimeJson>={source:'ç'.repeat(32769),result:{kept:true}};
  expect(()=>executeDataNode('data-rename',typed({source:'source'}),variables,'json')).toThrow('AUTOMATION_STATE_VALUE_LIMIT');
  expect(variables.result).toEqual({kept:true});expect(variables.source).toBe('ç'.repeat(32769));
 });
});
