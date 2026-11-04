import {z} from 'zod';
import {menuOptions,type FlowNode} from './flows.js';

/** Explicit opt-in keeps historical menu graphs on their original retry policy. */
const MenuAttemptConfigV1Schema=z.object({
  menuConfigVersion:z.literal(1),
  maxAttempts:z.number().int().min(1).max(100),
}).passthrough();
export const MenuWaitConfigV2Schema=z.object({
  menuConfigVersion:z.literal(2),
  maxAttempts:z.number().int().min(1).max(100),
  errorMessage:z.string().trim().min(1).max(4096),
  timeoutSeconds:z.number().int().min(1).max(604800).optional(),
}).passthrough();
export const MenuAttemptConfigSchema=z.discriminatedUnion('menuConfigVersion',[MenuAttemptConfigV1Schema,MenuWaitConfigV2Schema]);
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
  return [...menuOptions(node).map(option=>`option-${option.value}`),
    ...([1,2].includes(Number(node.data.menuConfigVersion))?['exhausted']:[]),
    ...(node.data.menuConfigVersion===2&&node.data.timeoutSeconds!==undefined?['timeout']:[])];
}
