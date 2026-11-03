import type {AutomationGraphV1} from '@jrc/contracts';
export type GraphChange={kind:'added'|'removed'|'configuration'|'presentation'|'connection';label:string;field:string;before:unknown;after:unknown};
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 return JSON.stringify(value)??'undefined';
}
export function compareGraphs(before:AutomationGraphV1,after:AutomationGraphV1):GraphChange[]{
 const changes:GraphChange[]=[];
 const change=(kind:GraphChange['kind'],label:string,field:string,left:unknown,right:unknown)=>{
  if(canonical(left)!==canonical(right))changes.push({kind,label,field,before:left,after:right});
 };
 const previousNodes=new Map(before.nodes.map(node=>[node.id,node])),nextNodes=new Map(after.nodes.map(node=>[node.id,node]));
 for(const id of [...new Set([...previousNodes.keys(),...nextNodes.keys()])].sort()){
  const left=previousNodes.get(id),right=nextNodes.get(id),label=(right??left)!.label;
  if(!left||!right){change(left?'removed':'added',label,'Bloco',left,right);continue;}
  change('configuration',label,'type',left.type,right.type);
  for(const key of [...new Set([...Object.keys(left.data),...Object.keys(right.data)])].sort())change('configuration',label,'data.'+key,left.data[key],right.data[key]);
  change('presentation',label,'label',left.label,right.label);change('presentation',label,'position',left.position,right.position);
 }
 const previousEdges=new Map(before.edges.map(edge=>[edge.id,edge])),nextEdges=new Map(after.edges.map(edge=>[edge.id,edge]));
 for(const id of [...new Set([...previousEdges.keys(),...nextEdges.keys()])].sort()){
  const left=previousEdges.get(id),right=nextEdges.get(id),edge=(right??left)!;
  const label=`${(nextNodes.get(edge.source)??previousNodes.get(edge.source))?.label??edge.source} → ${(nextNodes.get(edge.target)??previousNodes.get(edge.target))?.label??edge.target}`;
  change(!left?'added':!right?'removed':'connection',label,'Conexão',left,right);
 }
 return changes;
}
