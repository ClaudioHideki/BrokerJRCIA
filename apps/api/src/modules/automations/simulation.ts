import { z } from 'zod';
import {AiSimulationResponseSchema,AiNodeConfigSchema,validateAiOutput,type AiSimulationWait,HttpSimulationResponseSchema} from '@jrc/contracts';
import { executeAutomation } from './engine.js';
import type { PublishedAutomation, RuntimeResult } from './types.js';

export const SimulationEventSchema=z.union([
  z.strictObject({type:z.literal('MESSAGE'),text:z.string().max(4096)}),
  z.strictObject({type:z.literal('ELAPSE'),seconds:z.number().int().min(1).max(604800)}),
  HttpSimulationResponseSchema,AiSimulationResponseSchema,
]);
export const SimulationInputSchema=z.strictObject({
  text:z.string().max(4096),
  replies:z.array(z.string().max(4096)).max(30).optional(),
  events:z.array(SimulationEventSchema).max(30).optional(),
  clock:z.iso.datetime().optional(),
}).refine(input=>input.replies===undefined||input.events===undefined,{
  path:['events'],message:'Use respostas ou eventos de simulação, nunca ambos.',
});
export type SimulationInput=z.infer<typeof SimulationInputSchema>;

/** Pure conversation reconstruction: no transport, scheduler or credential adapter is injected. */
export async function simulateConversation(root:PublishedAutomation,input:SimulationInput,
  resolve:(automationId:string,version:number)=>Promise<PublishedAutomation>):Promise<RuntimeResult&{httpWaitNodeId?:string;aiWait?:AiSimulationWait}>{
  const parsed=SimulationInputSchema.parse(input);
  let now=new Date(parsed.clock??Date.now());
  let result=await executeAutomation(root,{text:parsed.text,eventType:'MESSAGE',now},resolve);
  const effects=[...result.effects],trace=[...result.trace];
  const events=parsed.events??parsed.replies?.map(text=>({type:'MESSAGE' as const,text}))??[];
  for(const event of events){
    if(result.status!=='WAITING')throw new Error('AUTOMATION_SIMULATION_NOT_WAITING');
    if(event.type==='MESSAGE'){
      // Retain the legacy replies contract; explicit events may observe messages during DELAY.
      if(result.wait?.kind==='IO'||(parsed.replies&&result.wait?.kind!=='EVENT'))throw new Error('AUTOMATION_SIMULATION_NOT_WAITING');
      result=await executeAutomation(root,{text:event.text,eventType:'MESSAGE',now},resolve,result.state);
    }else if(event.type==='AI_RESPONSE'){
      const effect=result.wait?.kind==='IO'&&result.wait.nodeId===event.nodeId?result.effects.find(effect=>effect.kind==='IO_AI'&&effect.nodeId===event.nodeId&&effect.payload.aiConfigVersion===1):undefined;
      if(!effect)throw new Error('AUTOMATION_SIMULATION_AI_WAIT_MISMATCH');
      const config=AiNodeConfigSchema.parse(Object.fromEntries(Object.entries(effect.payload).filter(([key])=>!['nodeType','variables','runtimeStateVersion'].includes(key))));
      let output:unknown={error:event.outcome==='timeout'?'AUTOMATION_AI_TIMEOUT':event.outcome==='unknown'?'AUTOMATION_AI_UNKNOWN':'AUTOMATION_AI_SYNTHETIC_ERROR'};
      if(event.outcome==='success')try{output=validateAiOutput(config,event.output);}catch{throw Error('AUTOMATION_SIMULATION_AI_OUTPUT_INVALID');}
      result=await executeAutomation(root,{text:'',eventType:'RESUME',now,payload:{outcome:event.outcome,output}},resolve,result.state);
    }else if(event.type==='HTTP_RESPONSE'){

      // Only the current turn proves this exact wait is HTTP, including a child subflow.
      // Historical aggregated effects cannot authorize a response to a later SQL/event wait.
      if(result.wait?.kind!=='IO'||result.wait.nodeId!==event.nodeId||
        !result.effects.some(effect=>effect.kind==='IO_HTTP'&&effect.nodeId===event.nodeId))
        throw new Error('AUTOMATION_SIMULATION_HTTP_WAIT_MISMATCH');
      const output=event.outcome==='timeout'||event.outcome==='unknown'
        ?{error:event.outcome==='timeout'?'AUTOMATION_HTTP_TIMEOUT':'AUTOMATION_HTTP_TRANSPORT_FAILED'}
        :{status:event.status,headers:{},body:event.body};
      result=await executeAutomation(root,{text:'',eventType:'RESUME',now,payload:{outcome:event.outcome,output}},resolve,result.state);
    }else{
      const until=new Date(now.getTime()+event.seconds*1000);
      if(!Number.isFinite(until.getTime()))throw new Error('AUTOMATION_SIMULATION_CLOCK_INVALID');
      // Run each due timer at its deadline, including delays created by earlier timers.
      // The engine's durable step limit also bounds loops in this reconstruction.
      while(result.status==='WAITING'&&result.wait?.kind==='DELAY'){
        const wakeAt=result.wait.wakeAt;
        if(!wakeAt)throw new Error('AUTOMATION_SIMULATION_DELAY_UNAVAILABLE');
        if(wakeAt.getTime()>until.getTime())break;
        now=new Date(Math.max(now.getTime(),wakeAt.getTime()));
        result=await executeAutomation(root,{text:'',eventType:'TIMER',now},resolve,result.state);
        effects.push(...result.effects);trace.push(...result.trace);
      }
      now=until;
      continue;
    }
    effects.push(...result.effects);trace.push(...result.trace);
  }
  const httpWaitNodeId=result.wait?.kind==='IO'&&result.effects.some(effect=>effect.kind==='IO_HTTP'&&effect.nodeId===result.wait?.nodeId)?result.wait.nodeId:undefined;
  const aiEffect=result.wait?.kind==='IO'?result.effects.find(effect=>effect.kind==='IO_AI'&&effect.nodeId===result.wait?.nodeId&&effect.payload.aiConfigVersion===1):undefined;
  const aiConfig=aiEffect?AiNodeConfigSchema.parse(Object.fromEntries(Object.entries(aiEffect.payload).filter(([key])=>!['nodeType','variables','runtimeStateVersion'].includes(key)))):undefined;
  const aiWait:AiSimulationWait|undefined=aiConfig&&aiEffect?{nodeId:aiEffect.nodeId,operation:aiConfig.operation,maxResponseBytes:aiConfig.maxResponseBytes,...(aiConfig.operation==='classify'?{categories:aiConfig.categories}:aiConfig.operation==='extract'?{fields:aiConfig.fields}:{})}:undefined;
  return {...result,effects,trace,...(httpWaitNodeId?{httpWaitNodeId}:{}),...(aiWait?{aiWait}:{})};
}
