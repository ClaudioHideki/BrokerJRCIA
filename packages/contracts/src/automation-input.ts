import {z} from 'zod';
import {DataVariableKeySchema} from './automation-data-v2.js';
import type {FlowNode} from './flows.js';

const InputCaptureV1Schema=z.object({
  inputConfigVersion:z.literal(1),
  variable:DataVariableKeySchema,
  text:z.string().max(4096).optional(),
  timeoutSeconds:z.number().int().min(1).max(604800).optional(),
}).passthrough();
export const InputCaptureTypeSchema=z.enum(['text','number','cpf','cnpj','email','phone','date']);
export type InputCaptureType=z.infer<typeof InputCaptureTypeSchema>;
export const InputCaptureV2Schema=InputCaptureV1Schema.extend({
  inputConfigVersion:z.literal(2),inputType:InputCaptureTypeSchema,
  maxAttempts:z.number().int().min(1).max(100),
  errorMessage:z.string().trim().min(1).max(4096).optional(),
});
export const InputCaptureV3Schema=InputCaptureV2Schema.extend({inputConfigVersion:z.literal(3),inputType:z.enum(['image','file'])});
export const AutomationInputMediaKindSchema=z.enum(['image','document','audio','video','sticker']);
const mediaFields={kind:AutomationInputMediaKindSchema,fileName:z.string().min(1).max(255)};
export const AutomationInputMediaSchema=z.discriminatedUnion('source',[
  z.strictObject({source:z.literal('CANONICAL_MESSAGE'),messageId:z.uuid(),mediaId:z.uuid(),...mediaFields}),
  z.strictObject({source:z.literal('CENTRAL_ATTACHMENT_REFERENCE'),referenceId:z.uuid(),...mediaFields}),
  z.strictObject({source:z.literal('SIMULATION_FIXTURE'),...mediaFields}),
]);
export type AutomationInputMedia=z.infer<typeof AutomationInputMediaSchema>;
export const AutomationMediaSimulationEventSchema=z.strictObject({type:z.literal('MEDIA'),...mediaFields});
export type AutomationMediaSimulationEvent=z.infer<typeof AutomationMediaSimulationEventSchema>;
export const InputCaptureConfigSchema=z.discriminatedUnion('inputConfigVersion',[InputCaptureV1Schema,InputCaptureV2Schema,InputCaptureV3Schema]);
export type InputCaptureConfig=z.infer<typeof InputCaptureConfigSchema>;

export function compatibleInputCaptureSchema(legacy:z.ZodType):z.ZodType{
  return z.unknown().superRefine((value,context)=>{
    const marked=Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&'inputConfigVersion' in value);
    const parsed=(marked?InputCaptureConfigSchema:legacy).safeParse(value);
    if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:issue.path});
  });
}
export function inputCapturePorts(node:FlowNode):string[]{
  return ['next',...([2,3].includes(Number(node.data.inputConfigVersion))?['exhausted']:[]),
    ...([1,2,3].includes(Number(node.data.inputConfigVersion))&&node.data.timeoutSeconds!==undefined?['timeout']:[])];
}

/** References only. A canonical message reference is not evidence of binary custody. */
export function parseMediaInputCapture(type:'image'|'file',raw:unknown):{valid:true;value:AutomationInputMedia}|{valid:false}{
  const media=AutomationInputMediaSchema.safeParse(raw);
  return media.success&&media.data.kind===(type==='image'?'image':'document')?{valid:true,value:media.data}:{valid:false};
}

/** Format/check digits only: this does not verify ownership or consult a registry. */
export function parseInputCapture(type:InputCaptureType,raw:string):{valid:true;value:string|number}|{valid:false}{
  const value=raw.trim();
  if(raw.length>4096||!value)return {valid:false};
  if(type==='text')return {valid:true,value:raw};
  if(type==='number'){
    if(!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value))return {valid:false};
    const number=Number(value.replace(',','.'));
    return Number.isFinite(number)?{valid:true,value:number}:{valid:false};
  }
  if(type==='email')return z.email().safeParse(value).success?{valid:true,value}:{valid:false};
  if(type==='date'){
    const time=Date.parse(value+'T00:00:00.000Z');
    return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value
      ?{valid:true,value}:{valid:false};
  }
  if(type==='phone'){
    const phone=value.replace(/[ ()-]/g,'');
    return /^\+?[\d ()-]+$/.test(value)&&/^\+?[1-9]\d{7,14}$/.test(phone)?{valid:true,value:phone}:{valid:false};
  }
  const normalized=value.toUpperCase().replace(/[./-]/g,'');
  const format=type==='cpf'?/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/
    :/^(?:[A-Z0-9]{12}\d{2}|[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2})$/;
  if(!format.test(value.toUpperCase())||/^(.)\1+$/.test(normalized))return {valid:false};
  // CNPJ alphanumeric uses ASCII minus 48 and the same modulo-11 weights as numeric CNPJ.
  const base=type==='cpf'?9:12;
  for(let digit=0;digit<2;digit++){
    const length=base+digit;let sum=0;
    for(let index=0;index<length;index++)sum+=(normalized.charCodeAt(index)-48)*(type==='cpf'?length+1-index:(length-1-index)%8+2);
    const remainder=sum%11,expected=remainder<2?0:11-remainder;
    if(Number(normalized[length])!==expected)return {valid:false};
  }
  return {valid:true,value:normalized};
}
