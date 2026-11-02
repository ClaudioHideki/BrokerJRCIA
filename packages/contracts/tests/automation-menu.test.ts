import {describe,expect,it} from 'vitest';
import {automationNodePorts,getNodeDefinition,validateAutomationGraph,type FlowNode} from '../src/index.js';
const menu=(data:Record<string,unknown>):FlowNode=>({id:'menu',type:'menu',label:'Menu',position:{x:0,y:0},data});
const legacy={text:'Escolha',options:[{value:'1',label:'A'},{value:'2',label:'B'}]};
const bounded={...legacy,menuConfigVersion:1,maxAttempts:3};
describe('versioned menu attempt contract',()=>{
 it('adds a required exhausted exit only for explicitly bounded menus',()=>{
  expect(automationNodePorts(menu(bounded))).toEqual(['option-1','option-2','exhausted']);
  const graph={nodes:[{...menu({}),id:'start',type:'start'},menu(bounded),{...menu({}),id:'end',type:'end'}],edges:[
   {id:'a',source:'start',target:'menu',port:'next'},...['option-1','option-2'].map(port=>({id:port,source:'menu',target:'end',port}))]};
  expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({nodeId:'menu',field:'ports.exhausted',code:'MISSING_CONNECTION'}));
 });
 it.each([0,-1,1.5,101,'3',null,undefined,NaN,Infinity])('rejects invalid maxAttempts %s',maxAttempts=>{
  expect(getNodeDefinition('menu',1)!.schema.safeParse({...bounded,maxAttempts}).success).toBe(false);
 });
 it.each([1,100])('accepts bounded maxAttempts %s',maxAttempts=>expect(getNodeDefinition('menu',1)!.schema.safeParse({...bounded,maxAttempts}).success).toBe(true));
 it('preserves unmarked historical fields without enabling an exhausted path',()=>{
  for(const data of [legacy,{...legacy,maxAttempts:1}]){
   expect(getNodeDefinition('menu',1)!.schema.safeParse(data).success).toBe(true);
   expect(automationNodePorts(menu(data))).toEqual(['option-1','option-2']);
  }
 });
 it('rejects future config versions without weakening choice validation',()=>{
  expect(getNodeDefinition('menu',1)!.schema.safeParse({...bounded,menuConfigVersion:2}).success).toBe(false);
  expect(getNodeDefinition('menu',1)!.schema.safeParse({...bounded,options:[{value:'1',label:'A'},{value:'1',label:'B'}]}).success).toBe(false);
 });
});
