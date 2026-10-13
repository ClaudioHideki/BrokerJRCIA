import {z} from 'zod';
import type {FlowGraph} from './flows.js';

export const SUBFLOW_MAX_DEPTH=8;
export const SUBFLOW_MAX_VERSIONS=32;
export const SUBFLOW_MAX_GRAPH_BYTES=2*1024*1024;

/** Absence is historical; unsupported markers must never fall back to history. */
export function publishedDependencyPolicy(graph:FlowGraph):1|undefined{
 const value=graph.nodes.find(node=>node.type==='start')?.data.dependencyPolicyVersion;
 if(value===undefined)return undefined;
 if(value!==1)throw new Error('AUTOMATION_DEPENDENCY_POLICY_INVALID');
 return 1;
}
export function withDependencyPolicyV1(graph:FlowGraph):FlowGraph{
 publishedDependencyPolicy(graph);
 return {...graph,nodes:graph.nodes.map(node=>node.type==='start'?{...node,data:{...node.data,dependencyPolicyVersion:1}}:node)};
}

/** Immutable references only. Graphs and credentials are not part of the picker. */
export const AutomationSubflowCatalogItemSchema=z.strictObject({
 automationId:z.uuid(),name:z.string().trim().min(1).max(120),
 version:z.number().int().positive(),checksum:z.string().regex(/^[a-f0-9]{64}$/u),
 runtimeStateVersion:z.literal(2),
});
export const AutomationSubflowCatalogPageSchema=z.strictObject({
 schemaVersion:z.literal(1),
 scope:z.strictObject({organizationId:z.uuid(),rootAutomationId:z.uuid()}),
 data:z.array(AutomationSubflowCatalogItemSchema).max(200),
 nextCursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).nullable(),
}).superRefine((page,context)=>{
 const seen=new Set<string>();
 for(const [index,item] of page.data.entries()){
  const key=`${item.automationId}:${item.version}`;
  if(item.automationId===page.scope.rootAutomationId)context.addIssue({code:'custom',path:['data',index,'automationId'],message:'A automação não pode selecionar a si mesma.'});
  if(seen.has(key))context.addIssue({code:'custom',path:['data',index],message:'Versão publicada repetida.'});
  seen.add(key);
 }
});
export type AutomationSubflowCatalogItem=z.infer<typeof AutomationSubflowCatalogItemSchema>;
export type AutomationSubflowCatalogPage=z.infer<typeof AutomationSubflowCatalogPageSchema>;
