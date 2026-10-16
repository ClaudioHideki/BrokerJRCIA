import {describe,expect,it} from 'vitest';
import {automationNodePorts,validateAutomationGraph,type FlowNode} from '@jrc/contracts';
import {executeAutomation} from '../../src/modules/automations/engine.js';

const node=(id:string,type:string,data:Record<string,unknown>={}):FlowNode=>({id,type,label:id,position:{x:0,y:0},data});
const cases=[{id:'text',label:'Texto',value:'1'},{id:'number',label:'Número',value:1},{id:'bool',label:'Booleano',value:false},{id:'null',label:'Nulo',value:null}];
function graph(value:unknown){
 return {nodes:[node('start','start'),node('data','data-set',{configVersion:2,target:'choice',errorVariable:'failure',valueSource:{kind:'LITERAL',value}}),
  node('switch','switch',{switchVersion:1,variable:'choice',cases}),...['text','number','bool','null','fallback'].map(id=>node(id,'message',{text:id})),node('end','end')],
 edges:[{id:'a',source:'start',target:'data',port:'next'},{id:'b',source:'data',target:'switch',port:'success'},{id:'c',source:'data',target:'end',port:'error'},
  ...cases.map(c=>({id:c.id,source:'switch',target:c.id,port:'case-'+c.id})),{id:'default',source:'switch',target:'fallback',port:'default'},
  ...['text','number','bool','null','fallback'].map(id=>({id:'end-'+id,source:id,target:'end',port:'next'}))]};
}
describe('typed Flow switch',()=>{
 it.each([['1','text'],[1,'number'],[false,'bool'],[null,'null'],['false','fallback'],[true,'fallback'],[{},'fallback'],[[],'fallback']] as const)
 ('selects %j without converting its type',async(value,expected)=>{
  const g=graph(value);expect(validateAutomationGraph(g)).toEqual([]);
  const result=await executeAutomation({automationId:'11111111-1111-4111-8111-111111111111',version:1,graph:g,runtimeStateVersion:2},
   {text:'synthetic',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('No subflow');});
  expect(result.status).toBe('COMPLETED');expect(result.effects.map(e=>e.payload.text)).toEqual([expected]);
 });
 it('keeps stable case ports and requires a fallback connection',()=>{
  const g=graph(1),s=g.nodes.find(n=>n.type==='switch')!;
  expect(automationNodePorts(s)).toEqual(['case-text','case-number','case-bool','case-null','default']);
  g.edges=g.edges.filter(e=>e.id!=='default');
  expect(validateAutomationGraph(g)).toEqual(expect.arrayContaining([expect.objectContaining({nodeId:'switch',code:'MISSING_CONNECTION',field:'ports.default'})]));
 });
 it('keeps valid output ids visible while a case value is being corrected',()=>{
  expect(automationNodePorts(node('switch','switch',{switchVersion:1,variable:'choice',cases:[{id:'stable',label:'Caso',value:undefined}]})))
   .toEqual(['case-stable','default']);
 });
 it.each([
  {switchVersion:1,variable:'choice',cases:[...cases,{id:'duplicate',label:'Duplicado',value:1}]},
  {switchVersion:1,variable:'constructor',cases},
  {switchVersion:2,variable:'choice',cases},
  {switchVersion:1,variable:'choice',cases:[{id:'bad',label:'Objeto',value:{}}]},
  {switchVersion:1,variable:'choice',cases:[{id:'same',label:'A',value:1},{id:'same',label:'B',value:2}]},
 ])('rejects invalid switch configuration %#',data=>{
  const g=graph(1);g.nodes.find(n=>n.type==='switch')!.data=data;
  expect(validateAutomationGraph(g)).toEqual(expect.arrayContaining([expect.objectContaining({nodeId:'switch',code:'INVALID_CONFIG'})]));
 });
 it('routes an absent variable to fallback rather than matching explicit null',async()=>{
  const g=graph(1);g.nodes.find(n=>n.type==='switch')!.data.variable='missing';
  const result=await executeAutomation({automationId:'11111111-1111-4111-8111-111111111111',version:1,graph:g,runtimeStateVersion:2},
   {text:'synthetic',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('No subflow');});
  expect(result.effects.map(e=>e.payload.text)).toEqual(['fallback']);
 });
});
