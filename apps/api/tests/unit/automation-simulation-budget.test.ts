import {describe,expect,it} from 'vitest';
import {simulateConversation,SimulationInputSchema} from '../../src/modules/automations/simulation.js';
import type {PublishedAutomation} from '../../src/modules/automations/types.js';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+':'+port,source,target,port});
const root:PublishedAutomation={automationId:'11111111-1111-4111-8111-111111111111',version:1,runtimeStateVersion:2,graph:{
 nodes:[node('start','start'),node('menu','menu',{menuConfigVersion:1,maxAttempts:100,text:'Escolha',options:[{value:'1',label:'Sim'},{value:'2',label:'Não'}]}),node('end','end')],
 edges:[edge('start','menu'),edge('menu','end','option-1'),edge('menu','end','option-2'),edge('menu','end','exhausted')]}};

describe('bounded simulation reconstruction',()=>{
 it('reconstructs all 100 invalid menu replies and follows the production exhaustion branch',async()=>{
  const result=await simulateConversation(root,{text:'Oi',events:Array.from({length:100},()=>({type:'MESSAGE' as const,text:'inválido'}))},async()=>root);
  expect(result.status).toBe('COMPLETED');
  expect(result.trace).toContainEqual(expect.objectContaining({nodeId:'menu',output:{invalidAttempts:100,maxAttempts:100,port:'exhausted'}}));
  expect(result.effects).toHaveLength(100);
 });
 it('also permits the legacy replies request to reach the hundredth attempt',async()=>{
  const result=await simulateConversation(root,{text:'Oi',replies:Array(100).fill('x')},async()=>root);
  expect(result.status).toBe('COMPLETED');
 });
 it('rejects aggregate UTF-8 input above 512 KiB, even when each individual reply fits',()=>{
  const result=SimulationInputSchema.safeParse({text:'Oi',events:Array.from({length:100},()=>({type:'MESSAGE',text:'á'.repeat(3000)}))});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toContainEqual(expect.objectContaining({message:'AUTOMATION_SIMULATION_INPUT_LIMIT'}));
 });
 it('rejects amplified output above 1 MiB instead of accumulating or returning a partial trace',async()=>{
  const amplified={...root,graph:{nodes:[node('start','start'),...Array.from({length:20},(_,i)=>node('message'+i,'message',{text:'{{message}}'.repeat(15)})),node('end','end')],edges:[edge('start','message0'),...Array.from({length:20},(_,i)=>edge('message'+i,i===19?'end':'message'+(i+1)))]}};
  await expect(simulateConversation(amplified,{text:'x'.repeat(4096)},async()=>amplified)).rejects.toThrow('AUTOMATION_SIMULATION_OUTPUT_LIMIT');
 });
});
