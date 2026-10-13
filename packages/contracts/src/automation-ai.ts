import {z} from 'zod';
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fieldName=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u).refine(value=>!['__proto__','prototype','constructor'].includes(value));
const target=z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/u).refine(value=>!value.split('.').some(part=>['__proto__','prototype','constructor'].includes(part)));
const category=z.string().min(1).max(128).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
export const AiModelPolicySchema=z.strictObject({name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),inputMicrosPerMillion:integer,outputMicrosPerMillion:integer});
export const AiCredentialPolicySchema=z.strictObject({models:z.array(AiModelPolicySchema).min(1).max(100).refine(values=>new Set(values.map(item=>item.name)).size===values.length),monthlyCostMicros:integer.refine(value=>value>0)});
const common={aiConfigVersion:z.literal(1),credentialId:z.uuid(),credentialRevision:z.number().int().positive(),model:AiModelPolicySchema.shape.name,content:z.string().min(1).refine(value=>bytes(value)<=32768),target,timeoutMs:z.number().int().min(100).max(30000),maxOutputTokens:z.number().int().min(1).max(16384),maxResponseBytes:z.number().int().min(1024).max(65536),maxCostMicros:integer.refine(value=>value>0)};
export const AiNodeConfigSchema=z.discriminatedUnion('operation',[
 z.strictObject({...common,operation:z.literal('generate')}),
 z.strictObject({...common,operation:z.literal('summarize')}),
 z.strictObject({...common,operation:z.literal('classify'),categories:z.array(category).min(2).max(20).refine(values=>new Set(values).size===values.length)}),
 z.strictObject({...common,operation:z.literal('extract'),fields:z.array(z.strictObject({name:fieldName,type:z.enum(['string','number','boolean'])})).min(1).max(20).refine(values=>new Set(values.map(item=>item.name)).size===values.length)}),
]);
export type AiNodeConfig=z.infer<typeof AiNodeConfigSchema>;
export type AiModelPolicy=z.infer<typeof AiModelPolicySchema>;
export function validateAiOutput(config:AiNodeConfig,output:unknown):unknown{
 let serialized:string;try{serialized=JSON.stringify(output);}catch{throw Error('AUTOMATION_AI_OUTPUT_INVALID');}
 if(typeof serialized!=='string')throw Error('AUTOMATION_AI_OUTPUT_INVALID');
 if(bytes(serialized)>config.maxResponseBytes)throw Error('AUTOMATION_AI_OUTPUT_LIMIT');
 if(config.operation==='extract'){
  const fields=Object.fromEntries(config.fields.map(field=>[field.name,field.type==='string'?z.string():field.type==='number'?z.number().finite():z.boolean()]));
  const parsed=z.strictObject(fields).safeParse(output);if(!parsed.success)throw Error('AUTOMATION_AI_OUTPUT_INVALID');return parsed.data;
 }
 if(typeof output!=='string'||!output.trim()||(config.operation==='classify'&&!config.categories.includes(output)))throw Error('AUTOMATION_AI_OUTPUT_INVALID');
 if(bytes(output)>config.maxResponseBytes)throw Error('AUTOMATION_AI_OUTPUT_LIMIT');return output;
}
export function estimateAiCost(model:AiModelPolicy,usage:{inputTokens:number;outputTokens:number}):number{
 const valid=integer.safeParse(usage.inputTokens).success&&integer.safeParse(usage.outputTokens).success;
 if(!valid)throw Error('AUTOMATION_AI_USAGE_INVALID');
 const parsed=AiModelPolicySchema.safeParse(model);if(!parsed.success)throw Error('AUTOMATION_AI_PRICE_INVALID');
 const micro=(BigInt(usage.inputTokens)*BigInt(model.inputMicrosPerMillion)+BigInt(usage.outputTokens)*BigInt(model.outputMicrosPerMillion)+999999n)/1000000n;
 if(micro>BigInt(Number.MAX_SAFE_INTEGER))throw Error('AUTOMATION_AI_COST_OVERFLOW');return Number(micro);
}
export function maximumAiCost(config:AiNodeConfig,model:AiModelPolicy):number{
 // Conservative contract: one input token per UTF8 byte plus bounded server prompt/schema overhead.
 return estimateAiCost(model,{inputTokens:bytes(config.content)+8192,outputTokens:config.maxOutputTokens});
}
export function aiStructuredResponse(config:AiNodeConfig):Record<string,unknown>|null{
 if(config.operation==='classify')return {type:'object',properties:{category:{type:'string',enum:config.categories}},required:['category'],additionalProperties:false};
 if(config.operation==='extract')return {type:'object',properties:Object.fromEntries(config.fields.map(field=>[field.name,{type:field.type}])),required:config.fields.map(field=>field.name),additionalProperties:false};
 return null;
}
export function compatibleAiNodeSchema(type:string,legacy:z.ZodType):z.ZodType{
 return z.unknown().superRefine((value,context)=>{
  const marker=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).aiConfigVersion:undefined;
  const result=(marker===undefined?legacy:AiNodeConfigSchema).safeParse(value);
  if(!result.success)for(const issue of result.error.issues)context.addIssue({...issue,path:issue.path});
  else if(marker!==undefined&&'operation' in (result.data as object)&&(result.data as AiNodeConfig).operation!==type.replace('ai-',''))context.addIssue({code:'custom',path:['operation'],message:'A operação deve corresponder ao tipo do bloco.'});
 });
}
export const AiCredentialCatalogPageSchema=z.strictObject({
 schemaVersion:z.literal(1),scope:z.strictObject({organizationId:z.uuid(),rootAutomationId:z.uuid()}),
 data:z.array(z.strictObject({id:z.uuid(),name:z.string().min(1).max(120),revision:z.number().int().positive(),models:z.array(AiModelPolicySchema).max(100),monthlyCostMicros:integer})).max(200),nextCursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).nullable(),
});
export type AiCredentialCatalogPage=z.infer<typeof AiCredentialCatalogPageSchema>;
const simulationBase={type:z.literal('AI_RESPONSE'),nodeId:z.string().min(1).max(100)};
export const AiSimulationResponseSchema=z.discriminatedUnion('outcome',[
 z.strictObject({...simulationBase,outcome:z.literal('success'),output:z.unknown().refine(value=>{try{return bytes(JSON.stringify(value)??'')<=65536;}catch{return false;}})}),
 z.strictObject({...simulationBase,outcome:z.literal('error')}),z.strictObject({...simulationBase,outcome:z.literal('timeout')}),z.strictObject({...simulationBase,outcome:z.literal('unknown')}),
]);
export type AiSimulationResponse=z.infer<typeof AiSimulationResponseSchema>;
export const AiSimulationWaitSchema=z.strictObject({nodeId:z.string().min(1).max(100),operation:z.enum(['generate','classify','extract','summarize']),categories:z.array(category).max(20).optional(),fields:z.array(z.strictObject({name:fieldName,type:z.enum(['string','number','boolean'])})).max(20).optional(),maxResponseBytes:z.number().int().min(1024).max(65536)});
export type AiSimulationWait=z.infer<typeof AiSimulationWaitSchema>;
