import {AutomationGraphV1Schema,publishedDependencyPolicy,withDependencyPolicyV1,validateAutomationGraph,
 SUBFLOW_MAX_DEPTH,SUBFLOW_MAX_VERSIONS,SUBFLOW_MAX_GRAPH_BYTES,type FlowNode} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {AutomationRepository} from './repository.js';
import type {PublishedAutomation} from './types.js';
import {AutomationError} from './errors.js';

export interface SubflowSnapshot{
 readonly root:PublishedAutomation;
 readonly versions:readonly PublishedAutomation[];
 resolve(automationId:string,version:number):Promise<PublishedAutomation>;
}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);
  Object.freeze(value);
 }
 return value;
}
/** The transaction fixes every reference before simulation or the canonical engine runs. */
export async function prepareSubflowSnapshot(tx:TenantTransaction,org:string,root:PublishedAutomation,
 repository:AutomationRepository,purpose:'NEW'|'HISTORICAL'):Promise<SubflowSnapshot>{
 let policy:1|undefined;
 try{policy=publishedDependencyPolicy(root.graph);}
 catch{throw new AutomationError('AUTOMATION_DEPENDENCY_POLICY_INVALID',422,[{
  nodeId:root.graph.nodes.find(node=>node.type==='start')?.id??null,field:'data.dependencyPolicyVersion',
  code:'DEPENDENCY_POLICY_INVALID',message:'A política de dependências desta publicação não é suportada.'}]);}
 if(purpose==='NEW')policy=1;
 const versions=new Map<string,PublishedAutomation>();let bytes=0;
 const fail:(code:string,caller:FlowNode,field:string,message:string)=>never=(code,caller,field,message)=>{throw new AutomationError(`AUTOMATION_${code}`,422,[{
  nodeId:caller.id,field,code,message}]);};
 const capture=(value:PublishedAutomation,caller?:FlowNode):PublishedAutomation=>{
  const parsed=AutomationGraphV1Schema.safeParse(value.graph);
  if(!parsed.success)throw new AutomationError('AUTOMATION_PUBLISHED_GRAPH_INVALID',409);
  // Copy before freezing: repository rows and editable drafts are never mutated.
  const graph=JSON.parse(JSON.stringify(parsed.data)) as PublishedAutomation['graph'];
  const addedBytes=Buffer.byteLength(JSON.stringify(graph),'utf8');
  const origin=caller??root.graph.nodes.find(node=>node.type==='start')!;
  if(policy===1&&versions.size>=SUBFLOW_MAX_VERSIONS)fail('SUBFLOW_VERSION_LIMIT',origin,'data.version',`A publicação aceita até ${SUBFLOW_MAX_VERSIONS} versões únicas, incluindo o fluxo principal.`);
  if(policy===1&&bytes+addedBytes>SUBFLOW_MAX_GRAPH_BYTES)fail('SUBFLOW_SIZE_LIMIT',origin,'data.version','Os grafos desta publicação excedem 2 MiB agregados.');
  bytes+=addedBytes;const snapshot=freeze({...value,graph});versions.set(`${value.automationId}:${value.version}`,snapshot);return snapshot;
 };
 const preparedRoot=capture({...root,graph:purpose==='NEW'?withDependencyPolicyV1(root.graph):root.graph});
 const active=new Set<string>([root.automationId]);
 type Summary={height:number;ids:Set<string>};const validated=new Map<string,Summary>();
 const visit=async(current:PublishedAutomation,depth:number,rootCaller?:FlowNode,path:string[]=[]):Promise<Summary>=>{
  const summary:Summary={height:0,ids:new Set([current.automationId])};
  for(const node of current.graph.nodes.filter(item=>item.type==='subflow')){
   const id=String(node.data.automationId),v=Number(node.data.version),key=`${id}:${v}`,caller=rootCaller??node;
   const context=rootCaller?`${caller.label}: dependência ${path.join(' → ')}; bloco ${node.label}`:node.label;
   if(active.has(id))fail('SUBFLOW_RECURSION',caller,'data.automationId',`${context}: ciclo detectado no subfluxo (${key}).`);
   if(policy===1&&depth>=SUBFLOW_MAX_DEPTH)fail('SUBFLOW_DEPTH_LIMIT',caller,'data.automationId',`${context}: são permitidas até ${SUBFLOW_MAX_DEPTH} chamadas de subfluxo simultâneas.`);
   let child=versions.get(key);
   if(!child){
    if(purpose==='NEW'){
     const definition=await repository.getDefinition(tx,org,id);
     if(!definition)fail('SUBFLOW_VERSION_NOT_FOUND',caller,'data.version',`${context}: versão publicada indisponível (${key}).`);
     if(definition.lifecycleStatus==='ARCHIVED')fail('SUBFLOW_ARCHIVED',caller,'data.automationId',`${context}: automação arquivada; selecione uma dependência ativa.`);
    }
    const row=await repository.getVersion(tx,org,id,v);
    if(!row)fail('SUBFLOW_VERSION_NOT_FOUND',caller,'data.version',`${context}: versão publicada indisponível (${key}).`);
    child=capture({automationId:id,version:v,graph:row.graph,runtimeStateVersion:row.runtimeStateVersion??1},caller);
   }
   let childSummary=validated.get(key);
   if(childSummary){
    // A cached subtree may be reached under a different ancestor or at a greater depth.
    if([...childSummary.ids].some(ancestor=>active.has(ancestor)))fail('SUBFLOW_RECURSION',caller,'data.automationId',`${context}: ciclo detectado no subfluxo (${key}).`);
    if(policy===1&&depth+1+childSummary.height>SUBFLOW_MAX_DEPTH)fail('SUBFLOW_DEPTH_LIMIT',caller,'data.automationId',`${context}: são permitidas até ${SUBFLOW_MAX_DEPTH} chamadas de subfluxo simultâneas.`);
   }else{
    active.add(id);childSummary=await visit(child,depth+1,caller,[...path,key]);active.delete(id);
    if((child.runtimeStateVersion??1)!==(root.runtimeStateVersion??1))fail('SUBFLOW_RUNTIME_VERSION_MISMATCH',caller,'data.version',`${context}: publique uma versão com o mesmo contrato de dados do fluxo principal (${key}).`);
    const diagnostics=validateAutomationGraph(child.graph);
    if(diagnostics.length)fail('SUBFLOW_GRAPH_INVALID',caller,'data.version',`${context}: a versão publicada contém um grafo inválido (${key}).`);
    validated.set(key,childSummary);
   }
   summary.height=Math.max(summary.height,1+childSummary.height);
   for(const childId of childSummary.ids)summary.ids.add(childId);
  }
  return summary;
 };
 await visit(preparedRoot,0);
 return Object.freeze({root:preparedRoot,versions:Object.freeze([...versions.values()]),
  async resolve(id:string,v:number){const child=versions.get(`${id}:${v}`);if(!child)throw new AutomationError('AUTOMATION_SUBFLOW_SNAPSHOT_REFERENCE_MISSING',409);return child;}});
}
