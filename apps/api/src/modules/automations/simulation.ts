import { z } from 'zod';
import { createHash } from 'node:crypto';
import {AiSimulationResponseSchema,AiNodeConfigSchema,validateAiOutput,type AiSimulationWait,HttpSimulationResponseSchema,
  ActionSimulationResponseSchema,ConversationEffectWaitSchema,type ConversationEffectWait} from '@jrc/contracts';
import { executeAutomation } from './engine.js';
import type { PublishedAutomation, RuntimeInput, RuntimeResult, RuntimeState } from './types.js';

export const SimulationEventSchema=z.union([
  z.strictObject({type:z.literal('MESSAGE'),text:z.string().max(4096)}),
  z.strictObject({type:z.literal('ELAPSE'),seconds:z.number().int().min(1).max(604800)}),
  HttpSimulationResponseSchema,AiSimulationResponseSchema,ActionSimulationResponseSchema,
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

function actionWait(result:RuntimeResult,effects:RuntimeResult['effects']):ConversationEffectWait|undefined {
  const wait=result.wait;
  if(wait?.kind!=='IO'||!wait.waitId)return;
  const effect=effects.find(effect=>effect.nodeId===wait.nodeId&&effect.payload.waitId===wait.waitId&&
    (effect.kind==='IO_CONVERSATION'&&effect.payload.conversationEffectVersion===2||effect.kind==='SEND_MEDIA'&&effect.payload.mediaEffectVersion===2));
  if(!effect)return;
  return ConversationEffectWaitSchema.parse({nodeId:wait.nodeId,waitId:wait.waitId,
    operation:effect.kind==='SEND_MEDIA'?'media':effect.payload.operation});
}

/** Pure conversation reconstruction: no transport, scheduler or credential adapter is injected. */
export async function simulateConversation(root:PublishedAutomation,input:SimulationInput,
  resolve:(automationId:string,version:number)=>Promise<PublishedAutomation>):Promise<RuntimeResult&{httpWaitNodeId?:string;aiWait?:AiSimulationWait;actionWait?:ConversationEffectWait}>{
  const parsed=SimulationInputSchema.parse(input);
  let now=new Date(parsed.clock??Date.now());
  const seed=createHash('sha256').update(JSON.stringify([root.automationId,root.version,root.graph,parsed.text,parsed.clock??null])).digest('hex');
  const effectWaitId:NonNullable<RuntimeInput['effectWaitId']>=scope=>{
    const hash=createHash('sha256').update(JSON.stringify(['jrc-simulation-effect/2',seed,scope.automationId,scope.version,scope.nodeId,scope.step])).digest('hex');
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${((parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
  };
  const run=(input:Omit<RuntimeInput,'effectWaitId'>,state?:RuntimeState)=>executeAutomation(root,{...input,effectWaitId},resolve,state);
  let result=await run({text:parsed.text,eventType:'MESSAGE',now});
  const effects=[...result.effects],trace=[...result.trace];
  const events=parsed.events??parsed.replies?.map(text=>({type:'MESSAGE' as const,text}))??[];
  for(const event of events){
    if(result.status!=='WAITING')throw new Error('AUTOMATION_SIMULATION_NOT_WAITING');
    if(event.type==='MESSAGE'){
      // Retain the legacy replies contract; explicit events may observe messages during DELAY.
      if(result.wait?.kind==='IO'||(parsed.replies&&result.wait?.kind!=='EVENT'))throw new Error('AUTOMATION_SIMULATION_NOT_WAITING');
      result=await run({text:event.text,eventType:'MESSAGE',now,...(result.wait?.waitId?{inputWait:{waitId:result.wait.waitId,admittedAt:now.getTime()}}:{})},result.state);
    }else if(event.type==='ACTION_RESPONSE'){
      // The UUID identifies this exact visit, including loops and subflows.
      // A historical effect at the same node never authorizes another wait.
      const waiting=actionWait(result,effects);
      if(!waiting||waiting.nodeId!==event.nodeId||waiting.waitId!==event.waitId)throw Error('AUTOMATION_SIMULATION_ACTION_WAIT_MISMATCH');
      const output=event.outcome==='success'?{operation:waiting.operation,confirmed:true,...(waiting.operation==='domain'?{simulated:true}:{})}
        :{operation:waiting.operation,error:event.outcome==='timeout'?'AUTOMATION_ACTION_TIMEOUT':event.outcome==='unknown'?'AUTOMATION_ACTION_UNKNOWN':'AUTOMATION_ACTION_SYNTHETIC_ERROR'};
      result=await run({text:'',eventType:'RESUME',now,payload:{waitId:event.waitId,outcome:event.outcome,output}},result.state);
    }else if(event.type==='AI_RESPONSE'){
      const effect=result.wait?.kind==='IO'&&result.wait.nodeId===event.nodeId?result.effects.find(effect=>effect.kind==='IO_AI'&&effect.nodeId===event.nodeId&&effect.payload.aiConfigVersion===1):undefined;
      if(!effect)throw new Error('AUTOMATION_SIMULATION_AI_WAIT_MISMATCH');
      const config=AiNodeConfigSchema.parse(Object.fromEntries(Object.entries(effect.payload).filter(([key])=>!['nodeType','variables','runtimeStateVersion'].includes(key))));
      let output:unknown={error:event.outcome==='timeout'?'AUTOMATION_AI_TIMEOUT':event.outcome==='unknown'?'AUTOMATION_AI_UNKNOWN':'AUTOMATION_AI_SYNTHETIC_ERROR'};
      if(event.outcome==='success')try{output=validateAiOutput(config,event.output);}catch{throw Error('AUTOMATION_SIMULATION_AI_OUTPUT_INVALID');}
      result=await run({text:'',eventType:'RESUME',now,payload:{outcome:event.outcome,output}},result.state);
    }else if(event.type==='HTTP_RESPONSE'){

      // Only the current turn proves this exact wait is HTTP, including a child subflow.
      // Historical aggregated effects cannot authorize a response to a later SQL/event wait.
      if(result.wait?.kind!=='IO'||result.wait.nodeId!==event.nodeId||
        !result.effects.some(effect=>effect.kind==='IO_HTTP'&&effect.nodeId===event.nodeId))
        throw new Error('AUTOMATION_SIMULATION_HTTP_WAIT_MISMATCH');
      const output=event.outcome==='timeout'||event.outcome==='unknown'
        ?{error:event.outcome==='timeout'?'AUTOMATION_HTTP_TIMEOUT':'AUTOMATION_HTTP_TRANSPORT_FAILED'}
        :{status:event.status,headers:{},body:event.body};
      result=await run({text:'',eventType:'RESUME',now,payload:{outcome:event.outcome,output}},result.state);
    }else{
      const until=new Date(now.getTime()+event.seconds*1000);
      if(!Number.isFinite(until.getTime()))throw new Error('AUTOMATION_SIMULATION_CLOCK_INVALID');
      // Run each due timer at its deadline, including delays created by earlier timers.
      // The engine's durable step limit also bounds loops in this reconstruction.
      while(result.status==='WAITING'&&(result.wait?.kind==='DELAY'||result.wait?.kind==='EVENT'&&result.wait.deadlineAt!==undefined)){
        const wakeAt=result.wait.kind==='DELAY'?result.wait.wakeAt:result.wait.deadlineAt;
        if(!wakeAt)throw new Error('AUTOMATION_SIMULATION_DELAY_UNAVAILABLE');
        if(wakeAt.getTime()>until.getTime())break;
        now=new Date(Math.max(now.getTime(),wakeAt.getTime()));
        result=await run({text:'',eventType:'TIMER',now,...(result.wait.waitId?{inputWait:{waitId:result.wait.waitId}}:{})},result.state);
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
  const effectWait=actionWait(result,effects);
  return {...result,effects,trace,...(httpWaitNodeId?{httpWaitNodeId}:{}),...(aiWait?{aiWait}:{}),...(effectWait?{actionWait:effectWait}:{})};
}
