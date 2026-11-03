import {expect,it} from 'vitest';
import {executeFlow,validateFlow,type FlowGraph} from '../src/flows.js';
const graph:FlowGraph={nodes:[{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{}},
 {id:'capture',type:'input',label:'Capture',position:{x:1,y:0},data:{inputConfigVersion:3,inputType:'image',maxAttempts:2,variable:'attachment'}},
 {id:'end',type:'end',label:'End',position:{x:2,y:0},data:{}}],edges:[{id:'a',source:'start',target:'capture',port:'next'},{id:'b',source:'capture',target:'end',port:'next'}]};
it.each([3,4,'3'])('does not downgrade typed media/future marker %s to legacy textual capture even without modern ports',version=>{
 const value={...graph,nodes:graph.nodes.map(node=>node.id==='capture'?{...node,data:{...node.data,inputConfigVersion:version}}:node)};
 expect(validateFlow(value)).toContain('Capture: esta versão de captura exige o Flow canônico.');
 expect(()=>executeFlow(value,{text:'caption'})).toThrow('esta versão de captura exige o Flow canônico');
});
