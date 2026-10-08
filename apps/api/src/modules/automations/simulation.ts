import { z } from 'zod';
import { executeAutomation } from './engine.js';
import type { PublishedAutomation, RuntimeResult } from './types.js';

export const SimulationEventSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('MESSAGE'),text:z.string().max(4096)}),
  z.strictObject({type:z.literal('ELAPSE'),seconds:z.number().int().min(1).max(604800)}),
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
  resolve:(automationId:string,version:number)=>Promise<PublishedAutomation>):Promise<RuntimeResult>{
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
  return {...result,effects,trace};
}
