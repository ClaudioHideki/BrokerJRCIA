import {describe,expect,it} from 'vitest';
import {getNodeDefinition,automationNodePorts,validateAutomationGraph,type FlowNode} from '../src/index.js';
const data={inputConfigVersion:2,inputType:'email',variable:'email',maxAttempts:3,timeoutSeconds:60};
const input:FlowNode={id:'capture',type:'input',label:'Email',position:{x:0,y:0},data};
describe('typed capture publication',()=>{
 it('accepts an explicit validator and requires timeout and exhaustion destinations',()=>{
  expect(getNodeDefinition('input',1)!.schema.safeParse(data).success).toBe(true);
  expect(automationNodePorts(input)).toEqual(['next','exhausted','timeout']);
  const graph={nodes:[{...input,id:'start',type:'start',data:{}},input,{...input,id:'end',type:'end',data:{}}],edges:[{id:'a',source:'start',target:'capture',port:'next'},{id:'b',source:'capture',target:'end',port:'next'}]};
  expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({nodeId:'capture',field:'ports.exhausted',code:'MISSING_CONNECTION'}));
 });
 it.each([{inputType:'file'},{inputType:'regex'},{maxAttempts:0},{maxAttempts:101},{maxAttempts:1.5},{variable:'__proto__.x'},{inputConfigVersion:3}])('rejects unsupported or unsafe typed configuration %j',override=>{
  expect(getNodeDefinition('input',1)!.schema.safeParse({...data,...override}).success).toBe(false);
 });
});
