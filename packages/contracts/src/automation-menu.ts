import {z} from 'zod';
import {menuOptions,type FlowNode} from './flows.js';

/** Explicit opt-in keeps historical menu graphs on their original retry policy. */
export const MenuAttemptConfigSchema=z.object({
  menuConfigVersion:z.literal(1),
  maxAttempts:z.number().int().min(1).max(100),
}).passthrough();
export type MenuAttemptConfig=z.infer<typeof MenuAttemptConfigSchema>;

export function compatibleMenuSchema(legacy:z.ZodType):z.ZodType{
  return z.unknown().superRefine((value,context)=>{
    const parsed=legacy.safeParse(value);
    if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:issue.path});
    if(value&&typeof value==='object'&&!Array.isArray(value)&&'menuConfigVersion' in value){
      const attempts=MenuAttemptConfigSchema.safeParse(value);
      if(!attempts.success)for(const issue of attempts.error.issues)context.addIssue({...issue,path:issue.path});
    }
  });
}
export function menuAttemptPorts(node:FlowNode):string[]{
  return [...menuOptions(node).map(option=>`option-${option.value}`),...(node.data.menuConfigVersion===1?['exhausted']:[])];
}
