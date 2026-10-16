import {z} from 'zod';
import {DataVariableKeySchema} from './automation-data-v2.js';

const scalar=z.union([z.string().max(4096),z.number().finite(),z.boolean(),z.null()]);
const caseId=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/u);
export const SwitchNodeConfigSchema=z.strictObject({
 switchVersion:z.literal(1),variable:DataVariableKeySchema,
 cases:z.array(z.strictObject({id:caseId,label:z.string().trim().min(1).max(80),value:scalar})).min(1).max(20),
}).superRefine((data,ctx)=>{
 const ids=new Set<string>(),values=new Set<string>();
 data.cases.forEach((item,index)=>{
  const value=typeof item.value+':'+JSON.stringify(item.value);
  if(ids.has(item.id))ctx.addIssue({code:'custom',path:['cases',index,'id'],message:'Não repita o identificador da saída.'});
  if(values.has(value))ctx.addIssue({code:'custom',path:['cases',index,'value'],message:'Não repita um valor do mesmo tipo.'});
  ids.add(item.id);values.add(value);
 });
});
export type SwitchNodeConfig=z.infer<typeof SwitchNodeConfigSchema>;
export function switchNodePorts(data:Record<string,unknown>):string[]{
 const ids=Array.isArray(data.cases)?data.cases.slice(0,20).flatMap(item=>{
  const parsed=caseId.safeParse(item&&typeof item==='object'?item.id:undefined);return parsed.success?[parsed.data]:[];
 }):[];
 return [...new Set(ids.map(id=>'case-'+id)),'default'];
}
/** No coercion, expression evaluation or prototype traversal. Missing is distinct from null. */
export function selectSwitchPort(config:SwitchNodeConfig,variables:Record<string,unknown>):string{
 const value=Object.hasOwn(variables,config.variable)?variables[config.variable]:undefined;
 const match=config.cases.find(item=>item.value===value);
 return match?'case-'+match.id:'default';
}
