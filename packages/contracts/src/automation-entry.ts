import {z} from 'zod';
import type {FlowGraph} from './flows.js';

export const AutomationEntryConfigSchema=z.object({
  entryConfigVersion:z.literal(1),trigger:z.literal('MESSAGE_RECEIVED'),
  reentry:z.enum(['ALWAYS','ONCE_PER_CONVERSATION']),
  keywords:z.strictObject({
    mode:z.enum(['EXACT','CONTAINS','STARTS_WITH','ENDS_WITH']),
    terms:z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    quantifier:z.enum(['ANY','ALL']),ignoreCase:z.boolean(),ignoreAccents:z.boolean(),
  }).optional(),
}).passthrough();
export type AutomationEntryConfig=z.infer<typeof AutomationEntryConfigSchema>;
export function compatibleAutomationEntrySchema(legacy:z.ZodType):z.ZodType{
  return z.unknown().superRefine((value,context)=>{
    const marked=value&&typeof value==='object'&&!Array.isArray(value)&&'entryConfigVersion' in value;
    const parsed=(marked?AutomationEntryConfigSchema:legacy).safeParse(value);
    if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:issue.path});
  });
}
export function automationEntryConfig(graph:FlowGraph):AutomationEntryConfig|undefined{
  const data=graph.nodes.find(node=>node.type==='start')?.data;
  return data&&data.entryConfigVersion!==undefined?AutomationEntryConfigSchema.parse(data):undefined;
}
export function matchesAutomationEntry(config:AutomationEntryConfig|undefined,text:string):boolean{
  const keywords=config?.keywords;if(!keywords)return true;
  const normalize=(value:string)=>{
    let result=value.trim();if(keywords.ignoreAccents)result=result.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return keywords.ignoreCase?result.toLowerCase():result;
  };
  const value=normalize(text),matches=(term:string)=>{
    const expected=normalize(term);
    return keywords.mode==='EXACT'?value===expected:keywords.mode==='CONTAINS'?value.includes(expected)
      :keywords.mode==='STARTS_WITH'?value.startsWith(expected):value.endsWith(expected);
  };
  return keywords.quantifier==='ALL'?keywords.terms.every(matches):keywords.terms.some(matches);
}
