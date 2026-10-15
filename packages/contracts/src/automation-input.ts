import {z} from 'zod';
import {DataVariableKeySchema} from './automation-data-v2.js';
import type {FlowNode} from './flows.js';

export const InputCaptureConfigSchema=z.object({
  inputConfigVersion:z.literal(1),
  variable:DataVariableKeySchema,
  text:z.string().max(4096).optional(),
  timeoutSeconds:z.number().int().min(1).max(604800).optional(),
}).passthrough();
export type InputCaptureConfig=z.infer<typeof InputCaptureConfigSchema>;

export function compatibleInputCaptureSchema(legacy:z.ZodType):z.ZodType{
  return z.unknown().superRefine((value,context)=>{
    const marked=Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&'inputConfigVersion' in value);
    const parsed=(marked?InputCaptureConfigSchema:legacy).safeParse(value);
    if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:issue.path});
  });
}
export function inputCapturePorts(node:FlowNode):string[]{
  return node.data.inputConfigVersion===1&&node.data.timeoutSeconds!==undefined?['next','timeout']:['next'];
}
