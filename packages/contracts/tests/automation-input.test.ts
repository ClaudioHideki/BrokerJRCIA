import {describe,expect,it} from 'vitest';
import {getNodeDefinition,automationNodePorts,validateAutomationGraph,type FlowNode} from '../src/index.js';

const input=(data:Record<string,unknown>):FlowNode=>({id:'capture',type:'input',label:'Nome',position:{x:0,y:0},data});
const config={inputConfigVersion:1,variable:'answer',text:'Qual seu nome?',timeoutSeconds:5};

describe('versioned input deadline contract',()=>{
  it('requires the timeout path when an explicit capture deadline is configured',()=>{
    expect(getNodeDefinition('input',1)!.schema.safeParse(config).success).toBe(true);
    expect(automationNodePorts(input(config))).toEqual(['next','timeout']);
    const graph={nodes:[{...input({}),id:'start',type:'start'},input(config),{...input({}),id:'end',type:'end'}],edges:[{id:'a',source:'start',target:'capture',port:'next'},{id:'b',source:'capture',target:'end',port:'next'}]};
    expect(validateAutomationGraph(graph)).toContainEqual(expect.objectContaining({nodeId:'capture',field:'ports.timeout',code:'MISSING_CONNECTION'}));
  });
  it.each([0,-1,1.5,604801,'5',null,NaN,Infinity])('refuses a noninteger or out-of-range explicit deadline: %s',timeoutSeconds=>{
    expect(getNodeDefinition('input',1)!.schema.safeParse({...config,timeoutSeconds}).success).toBe(false);
  });
  it.each([1,604800])('accepts the bounded deadline of %s seconds',timeoutSeconds=>{
    expect(getNodeDefinition('input',1)!.schema.safeParse({...config,timeoutSeconds}).success).toBe(true);
  });
  it('keeps an explicit capture without deadline on only its normal path',()=>{
    const {timeoutSeconds:_,...withoutDeadline}=config;
    expect(getNodeDefinition('input',1)!.schema.safeParse(withoutDeadline).success).toBe(true);
    expect(automationNodePorts(input(withoutDeadline))).toEqual(['next']);
  });
  it('does not infer timeout behavior for an unmarked historical node',()=>{
    expect(automationNodePorts(input({variable:'answer',timeoutSeconds:5}))).toEqual(['next']);
    expect(getNodeDefinition('input',1)!.schema.safeParse({variable:'answer'}).success).toBe(true);
    expect(getNodeDefinition('input',1)!.schema.safeParse({variable:'answer',timeout:5}).success).toBe(false);
  });
  it('refuses a future marker and unsafe capture variable',()=>{
    expect(getNodeDefinition('input',1)!.schema.safeParse({...config,inputConfigVersion:2}).success).toBe(false);
    expect(getNodeDefinition('input',1)!.schema.safeParse({...config,variable:'constructor.x'}).success).toBe(false);
  });
});
