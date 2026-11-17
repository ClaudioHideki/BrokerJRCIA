import {oiaVisualReconstructionFlow,OIA_DEPARTMENTS} from './oia-visual-reconstruction.js';
import {FlowGraphSchema,menuOptions,type FlowGraph} from './flows.js';
import {validateAutomationGraph} from './automations-v1.js';

/** Conversion is explicit and structural. It creates a new graph; published source stays immutable. */
export function convertOiaToBoxTemplate(input:FlowGraph):FlowGraph{
 const bad=():never=>{throw Error('FLOW_BOX_OIA_CONVERSION_REQUIRED');};
 const graph=FlowGraphSchema.parse(structuredClone(input));
 if(graph.nodes.some(n=>n.type==='subflow'||n.type==='directory-menu'))return bad();
 const remove=new Set<string>(),replace=new Map<string,FlowGraph['nodes'][number]>(),edges:FlowGraph['edges']=[],handoffs:FlowGraph['nodes']=[];
 const edge=(source:string,target:string,port='next')=>{
  const found=graph.edges.filter(e=>e.source===source&&e.port===port);if(found.length!==1||found[0]!.target!==target)return bad();return found[0]!;
 };
 for(const department of OIA_DEPARTMENTS){
  const routeKey=department.id,handoffId=`box-handoff-${routeKey}`;
  handoffs.push({id:handoffId,type:'handoff',label:department.pt,position:{x:3100,y:handoffs.length*180},data:{handoffVersion:3,routeKey}});
  for(const language of ['pt','en'] as const){
   const id=`attendants-${routeKey}-${language}`,menu=graph.nodes.find(n=>n.id===id);
   if(!menu||menu.type!=='menu'||!Array.isArray(menu.data.options)||menu.data.options.length!==department.positions+1||menu.data.menuConfigVersion!==2)return bad();
   const options=menuOptions(menu);
   if(options.length!==department.positions+1||options.some((o,i)=>o.value!==String(i+1)))return bad();
   edge(id,`departments-${language}`,`option-${department.positions+1}`);
   for(let i=1;i<=department.positions;i++){
    const announcement=`announce-${routeKey}-${i}-${language}`,selected=`selected-${routeKey}-${i}`,handoff=`handoff-${routeKey}-${i}`;
    const nodes=[graph.nodes.find(n=>n.id===announcement),graph.nodes.find(n=>n.id===selected),graph.nodes.find(n=>n.id===handoff)];
    if(nodes[0]?.type!=='message'||nodes[1]?.type!=='variable'||nodes[1].data.variable!=='attendant_position'||nodes[2]?.type!=='handoff')return bad();
    const expected=language==='pt'?`Aguarde, vamos encaminhar seu atendimento para ${options[i-1]!.label}, do setor ${department.pt}.`:
     `Please wait, we will transfer your conversation to ${options[i-1]!.label}, ${department.en}.`;
    if(nodes[0].data.text!==expected||nodes[1].data.value!==`${routeKey}-${i}`)return bad();
    edge(id,announcement,`option-${i}`);edge(announcement,selected);edge(selected,handoff);
    remove.add(announcement);remove.add(selected);remove.add(handoff);
   }
   replace.set(id,{...menu,type:'directory-menu',data:{directoryVersion:1,routeKey,language,text:menu.data.text,
    backLabel:options.at(-1)!.label,errorMessage:menu.data.errorMessage,maxAttempts:menu.data.maxAttempts,
    ...(menu.data.timeoutSeconds===undefined?{}:{timeoutSeconds:menu.data.timeoutSeconds})}});
   edges.push({id:`${id}:selected`,source:id,target:handoffId,port:'selected'},
    {id:`${id}:back`,source:id,target:`departments-${language}`,port:'back'});
  }
 }
 // Unrecognized incoming/outgoing edges into removed branches must not disappear silently.
 for(const e of graph.edges){
  if(remove.has(e.target)&&!remove.has(e.source)&&!replace.has(e.source))return bad();
  if(remove.has(e.source)&&!remove.has(e.target))return bad();
 }
 if(graph.nodes.some(n=>n.type==='handoff'&&!remove.has(n.id)))return bad();
 const start=graph.nodes.find(n=>n.type==='start');if(!start)return bad();
 const next:FlowGraph={nodes:[...graph.nodes.filter(n=>!remove.has(n.id)).map(n=>n.id===start.id?{...n,data:{...n.data,boxRoutes:OIA_DEPARTMENTS.map(d=>({routeKey:d.id,labels:{pt:d.pt,en:d.en},mode:'AGENT'}))}}:replace.get(n.id)??n),...handoffs],
  edges:[...graph.edges.filter(e=>!remove.has(e.source)&&!remove.has(e.target)&&!(replace.has(e.source)&&e.port.startsWith('option-'))),...edges]};
 if(validateAutomationGraph(next).length)return bad();return next;
}
export function oiaBoxTemplateFlow():FlowGraph{return convertOiaToBoxTemplate(oiaVisualReconstructionFlow());}
