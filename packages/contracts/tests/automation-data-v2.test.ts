import {describe,expect,it} from 'vitest';
import {getNodeDefinition} from '../src/automation-node-definitions.js';
const base={configVersion:2,target:'result',errorVariable:'failure'};
describe('P3 typed local data contract',()=>{
 it('requires a source/value for every newly configured transformation',()=>{
  for(const type of ['data-set','data-rename','data-pick','data-merge','data-map','data-filter','json-parse','json-stringify','expression'])
   expect(getNodeDefinition(type,1)!.schema.safeParse(base).success,type).toBe(false);
 });
 it('validates field references, operators and all members of a source list',()=>{
  for(const [type,config] of [
   ['data-rename',{source:'constructor.bad'}],['data-pick',{source:'profile',keys:['name','__proto__.x']}],
   ['data-merge',{sources:['first',17]}],['data-filter',{source:'rows',field:'active',operator:'execute',value:true}],
   ['data-map',{source:'rows',field:'name..last'}],['json-parse',{source:'constructor'}],
  ] as const)expect(getNodeDefinition(type,1)!.schema.safeParse({...base,...config}).success,type).toBe(false);
 });
 it('requires a distinct safe error variable and rejects extra executable configuration',()=>{
  const valid={...base,valueSource:{kind:'LITERAL',value:{active:true,names:['A','B']}}};
  expect(getNodeDefinition('data-set',1)!.schema.safeParse(valid).success).toBe(true);
  for(const extra of [{errorVariable:'result'},{errorVariable:'__proto__.x'},{code:'process.exit()'},{configVersion:9}])
   expect(getNodeDefinition('data-set',1)!.schema.safeParse({...valid,...extra}).success).toBe(false);
 });
 it('offers success/error for the explicit configuration and preserves historical next',()=>{
  const definition=getNodeDefinition('data-pick',1)!;
  const node={id:'p',label:'P',type:'data-pick',position:{x:0,y:0},data:base};
  expect(definition.ports(node)).toEqual(['success','error']);
  expect(definition.ports({...node,data:{target:'p'}})).toEqual(['next']);
  expect(definition.schema.safeParse({target:'old',unrecognizedHistoricalField:true}).success).toBe(true);
 });
 it('limits literal size, depth and list configuration before publication',()=>{
  const schema=getNodeDefinition('data-set',1)!.schema;
  expect(schema.safeParse({...base,valueSource:{kind:'LITERAL',value:'ç'.repeat(40000)}}).success).toBe(false);
  const nested=Array.from({length:66}).reduce<unknown>(value=>[value],true);
  expect(schema.safeParse({...base,valueSource:{kind:'LITERAL',value:nested}}).success).toBe(false);
  expect(getNodeDefinition('data-pick',1)!.schema.safeParse({...base,source:'p',keys:Array.from({length:65},(_,n)=>`k${n}`)}).success).toBe(false);
 });
});
