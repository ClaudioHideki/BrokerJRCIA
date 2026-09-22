import { randomUUID } from 'node:crypto';
import { AutomationGraphV1Schema, FlowGraphSchema, flowPorts, menuOptions, renderFlowText, validateFlow,
  type AutomationGraphV1, type FlowNode } from '@jrc/contracts';
import type { PublishedAutomation, RuntimeInput, RuntimeResult, RuntimeState } from './types.js';
import { executeDataNode } from '../automation-integrations/data-nodes.js';

const dataTypes=new Set(['data-set','data-rename','data-pick','data-merge','data-map','data-filter','json-parse','json-stringify','expression']);
const ioTypes=new Set(['http','sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent']);
const runtimeTypes=new Set(['delay','subflow',...dataTypes,...ioTypes]);
const safeKey=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(value)
  && !value.split('.').some(part=>['__proto__','prototype','constructor'].includes(part));
const string=(value:unknown)=>typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';
const next=(graph:AutomationGraphV1,nodeId:string,port='next')=>graph.edges.find(edge=>edge.source===nodeId&&edge.port===port)?.target;
const runtimePorts=(node:FlowNode)=>node.type==='http'?['success','client_error','server_error','timeout','unknown']:['sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent'].includes(node.type)?['success','error']:runtimeTypes.has(node.type)?['next']:flowPorts(node);
const schemaMatches=(schema:unknown,value:unknown):boolean=>{
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return true;
  const candidate=schema as Record<string,unknown>,type=candidate.type;
  if(type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const object=value as Record<string,unknown>,required=Array.isArray(candidate.required)?candidate.required.filter(item=>typeof item==='string') as string[]:[];
    if(required.some(key=>!(key in object)))return false;
    const properties=candidate.properties&&typeof candidate.properties==='object'&&!Array.isArray(candidate.properties)?candidate.properties as Record<string,unknown>:{};
    return Object.entries(properties).every(([key,child])=>!(key in object)||schemaMatches(child,object[key]));
  }
  if(type==='array')return Array.isArray(value)&&value.every(item=>schemaMatches(candidate.items,item));
  if(type==='string')return typeof value==='string';if(type==='number')return typeof value==='number'&&Number.isFinite(value);
  if(type==='integer')return Number.isInteger(value);if(type==='boolean')return typeof value==='boolean';if(type==='null')return value===null;
  return true;
};

export function validateAutomationGraph(graph:unknown):string[]{
  const parsed=AutomationGraphV1Schema.safeParse(graph);if(!parsed.success)return ['Formato de automação inválido.'];
  const candidate=parsed.data;
  const adapted={...candidate,nodes:candidate.nodes.map(node=>runtimeTypes.has(node.type)
    ? {...node,type:'variable',data:{variable:'_runtime',value:''}}:node)};
  const errors=validateFlow(adapted);
  for(const node of candidate.nodes){
    if(node.type==='delay'){
      const seconds=Number(node.data.seconds);if(!Number.isInteger(seconds)||seconds<1||seconds>604800)errors.push(`${node.label}: atraso deve ficar entre 1 segundo e 7 dias.`);
    }
    if(node.type==='subflow'){
      if(typeof node.data.automationId!=='string'||!/^[0-9a-f-]{36}$/i.test(node.data.automationId))errors.push(`${node.label}: automação chamada inválida.`);
      if(!Number.isInteger(Number(node.data.version))||Number(node.data.version)<1)errors.push(`${node.label}: versão do subflow deve estar fixada.`);
      const timeoutMs=Number(node.data.timeoutMs??10000);if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)errors.push(`${node.label}: timeout deve ficar entre 100 e 30000 ms.`);
    }
    if(dataTypes.has(node.type)){
      if(typeof node.data.target!=='string')errors.push(`${node.label}: informe a variável de destino.`);
      if(node.type==='expression'&&typeof node.data.expression!=='string')errors.push(`${node.label}: informe a expressão segura.`);
    }
    if(ioTypes.has(node.type)){
      if(typeof node.data.target!=='string'||!safeKey(node.data.target))errors.push(`${node.label}: informe uma variável de destino válida.`);
      if(node.type!=='code'&&(typeof node.data.credentialId!=='string'||!/^[0-9a-f-]{36}$/i.test(node.data.credentialId)))errors.push(`${node.label}: selecione uma credencial do cofre.`);
      if(node.type==='http'&&(typeof node.data.url!=='string'||!node.data.url.startsWith('https://')))errors.push(`${node.label}: use uma URL HTTPS.`);
      if(node.type==='sql'&&typeof node.data.query!=='string')errors.push(`${node.label}: informe a consulta parametrizada.`);
      if(node.type==='code'&&typeof node.data.code!=='string')errors.push(`${node.label}: informe o código da transformação.`);
    }
  }
  const runtimeLabels=candidate.nodes.filter(node=>runtimeTypes.has(node.type)).map(node=>node.label);
  const filtered=errors.filter(error=>!runtimeLabels.some(label=>error.startsWith(`${label}: saída inválida.`)||error.startsWith(`${label}: conecte a saída`)));
  for(const node of candidate.nodes.filter(item=>runtimeTypes.has(item.type)))for(const port of runtimePorts(node))if(!candidate.edges.some(edge=>edge.source===node.id&&edge.port===port))filtered.push(`${node.label}: conecte a saída ${port}.`);
  return [...new Set(filtered)];
}

export async function executeAutomation(
  root:PublishedAutomation,input:RuntimeInput,resolve:(automationId:string,version:number)=>Promise<PublishedAutomation>,previous?:RuntimeState,
):Promise<RuntimeResult>{
  const variables:Record<string,string>=Object.create(null) as Record<string,string>;
  for(const [key,value] of Object.entries(previous?.variables??{}))if(safeKey(key))variables[key]=string(value).slice(0,4096);
  variables.message=input.text.slice(0,4096);
  const state:RuntimeState=previous?{...previous,variables,stack:[...previous.stack]}:{automationId:root.automationId,version:root.version,
    nodeId:root.graph.nodes.find(node=>node.type==='start')!.id,variables,steps:0,stack:[]};
  const effects:RuntimeResult['effects']=[],trace:RuntimeResult['trace']=[];
  const cache=new Map<string,PublishedAutomation>([[`${root.automationId}:${root.version}`,root]]);
  const getPublished=async(automationId:string,version:number)=>{const key=`${automationId}:${version}`,known=cache.get(key);if(known)return known;
    const loaded=await resolve(automationId,version);cache.set(key,loaded);return loaded;};
  let published=await getPublished(state.automationId,state.version);
  let current=state.nodeId;
  if(state.waiting){
    const waiting=published.graph.nodes.find(node=>node.id===state.waiting!.nodeId);
    if(!waiting)throw new Error('AUTOMATION_WAIT_NODE_MISSING');
    if(state.waiting.kind==='DELAY'){
      if(input.eventType!=='TIMER')return {status:'WAITING',state,effects,trace,wait:{kind:'DELAY',nodeId:waiting.id}};
      current=next(published.graph,waiting.id)??null;
    }else if(state.waiting.kind==='IO'){
      if(input.eventType!=='RESUME')return {status:'WAITING',state,effects,trace,wait:{kind:'IO',nodeId:waiting.id}};
      const target=string(waiting.data.target),output=input.payload?.output;
      if(safeKey(target))variables[target]=(typeof output==='string'?output:JSON.stringify(output??null)).slice(0,4096);
      const outcome=string(input.payload?.outcome)||'unknown',allowed=waiting.type==='http'?['success','client_error','server_error','timeout','unknown']:['success','error'];
      current=next(published.graph,waiting.id,allowed.includes(outcome)?outcome:allowed.at(-1))??null;
    }else{
      if(input.eventType==='TIMER')throw new Error('AUTOMATION_EVENT_WAIT_REQUIRES_EVENT');
      if(waiting.type==='input'){
        const variable=string(waiting.data.variable);if(safeKey(variable))variables[variable]=input.text.slice(0,4096);
        current=next(published.graph,waiting.id)??null;
      }else if(waiting.type==='menu'){
        const selected=input.text.trim(),option=menuOptions(waiting).find(item=>item.value===selected);
        if(!option){const prompt=renderFlowText(waiting.data.text,variables),list=menuOptions(waiting).map(item=>`${item.value} - ${item.label}`).join('\n');
          effects.push({nodeId:waiting.id,ordinal:0,kind:'SEND_TEXT',payload:{text:[prompt,list,'Responda com o número da opção.'].filter(Boolean).join('\n')}});
          return {status:'WAITING',state,effects,trace,wait:{kind:'EVENT',nodeId:waiting.id}};}
        const variable=string(waiting.data.variable)||'menu.choice';if(safeKey(variable))variables[variable]=selected;
        current=next(published.graph,waiting.id,`option-${option.value}`)??null;
      }else throw new Error('AUTOMATION_EVENT_WAIT_INVALID');
    }
    delete state.waiting;
  }
  for(let turn=0;turn<500;turn++){
    if(++state.steps>5000)throw new Error('AUTOMATION_STEP_LIMIT');
    const activeFrame=state.stack.at(-1);if(activeFrame?.deadlineAt&&input.now.getTime()>activeFrame.deadlineAt)throw new Error('AUTOMATION_SUBFLOW_TIMEOUT');
    if(!current){
      const frame=state.stack.pop();
      if(!frame){state.nodeId=null;return {status:'COMPLETED',state,effects,trace};}
      if(frame.outputSchema&&!schemaMatches(frame.outputSchema,variables))throw new Error('AUTOMATION_SUBFLOW_OUTPUT_SCHEMA_INVALID');
      if(frame.child)trace.push({nodeId:frame.child.nodeId,type:'subflow-result',label:'Subflow concluído',input:frame.child.input,output:{automationId:frame.child.automationId,version:frame.child.version,correlationId:frame.child.correlationId,variables}});
      published=await getPublished(frame.automationId,frame.version);state.automationId=frame.automationId;state.version=frame.version;current=frame.returnNodeId;continue;
    }
    const node=published.graph.nodes.find(candidate=>candidate.id===current);if(!node)throw new Error('AUTOMATION_NODE_MISSING');
    const record={nodeId:node.id,type:node.type,label:node.label,input:{message:variables.message??''},output:{} as Record<string,unknown>};trace.push(record);
    if(node.type==='end') {current=null;continue;}
    if(node.type==='handoff'){
      effects.push({nodeId:node.id,ordinal:0,kind:'HANDOFF',payload:{}});state.nodeId=null;return {status:'HANDOFF',state,effects,trace};
    }
    if(node.type==='message'){
      const text=renderFlowText(node.data.text,variables);record.output={text};effects.push({nodeId:node.id,ordinal:0,kind:'SEND_TEXT',payload:{text}});
    }
    if(node.type==='input'||node.type==='menu'){
      const prompt=renderFlowText(node.data.text,variables),text=node.type==='menu'
        ? [prompt,menuOptions(node).map(item=>`${item.value} - ${item.label}`).join('\n')].filter(Boolean).join('\n'):prompt;
      if(text.trim())effects.push({nodeId:node.id,ordinal:0,kind:'SEND_TEXT',payload:{text}});
      state.nodeId=node.id;state.waiting={kind:'EVENT',nodeId:node.id};return {status:'WAITING',state,effects,trace,wait:{kind:'EVENT',nodeId:node.id}};
    }
    if(node.type==='delay'){
      const seconds=Number(node.data.seconds);const wakeAt=new Date(input.now.getTime()+seconds*1000);
      state.nodeId=node.id;state.waiting={kind:'DELAY',nodeId:node.id};return {status:'WAITING',state,effects,trace,wait:{kind:'DELAY',nodeId:node.id,wakeAt}};
    }
    if(node.type==='subflow'){
      const automationId=string(node.data.automationId),version=Number(node.data.version),returnNodeId=next(published.graph,node.id);
      if(!returnNodeId)throw new Error('AUTOMATION_SUBFLOW_RETURN_MISSING');
      if(state.stack.some(frame=>frame.automationId===automationId)||automationId===published.automationId)throw new Error('AUTOMATION_SUBFLOW_RECURSION');
      const inputMap=node.data.input&&typeof node.data.input==='object'&&!Array.isArray(node.data.input)?node.data.input as Record<string,unknown>:{};
      const childInput=Object.fromEntries(Object.entries(inputMap).map(([key,value])=>[key,renderFlowText(value,variables)]));
      if(node.data.inputSchema&&!schemaMatches(node.data.inputSchema,childInput))throw new Error('AUTOMATION_SUBFLOW_INPUT_SCHEMA_INVALID');
      for(const [key,value] of Object.entries(childInput))if(safeKey(key))variables[key]=string(value).slice(0,4096);
      const correlationId=randomUUID(),timeoutMs=Number(node.data.timeoutMs??10000);
      record.output={automationId,version,correlationId,input:childInput,status:'STARTED'};
      state.stack.push({automationId:published.automationId,version:published.version,returnNodeId,deadlineAt:input.now.getTime()+timeoutMs,
        ...(node.data.outputSchema&&typeof node.data.outputSchema==='object'?{outputSchema:node.data.outputSchema as Record<string,unknown>}:{ }),child:{nodeId:node.id,automationId,version,correlationId,input:childInput}});published=await getPublished(automationId,version);
      state.automationId=automationId;state.version=version;current=published.graph.nodes.find(candidate=>candidate.type==='start')!.id;continue;
    }
    if(dataTypes.has(node.type))record.output=executeDataNode(node.type,node.data,variables);
    if(ioTypes.has(node.type)){
      const kind=node.type==='http'?'IO_HTTP':node.type==='sql'?'IO_SQL':node.type==='code'?'IO_CODE':'IO_AI';
      const payload={...node.data,nodeType:node.type,variables};record.output={queued:true,kind};effects.push({nodeId:node.id,ordinal:0,kind,payload});
      state.nodeId=node.id;state.waiting={kind:'IO',nodeId:node.id};return {status:'WAITING',state,effects,trace,wait:{kind:'IO',nodeId:node.id}};
    }
    if(node.type==='variable'){const key=string(node.data.variable);if(safeKey(key))variables[key]=renderFlowText(node.data.value,variables);}
    let port='next';
    if(node.type==='condition'){
      const actual=variables[string(node.data.field)]??'',expected=renderFlowText(node.data.value,variables),operator=string(node.data.operator);
      const ok=operator==='present'?Boolean(actual.trim()):operator==='not_equals'?actual!==expected:operator==='contains'?actual.toLowerCase().includes(expected.toLowerCase())
        :operator==='starts_with'?actual.toLowerCase().startsWith(expected.toLowerCase()):actual===expected;port=ok?'yes':'no';
    }
    current=next(published.graph,node.id,port)??null;state.nodeId=current;
  }
  throw new Error('AUTOMATION_TURN_LIMIT');
}

export function automationPorts(node:FlowNode):string[]{return runtimePorts(node);}
export function parseAutomationGraph(value:unknown):AutomationGraphV1{return FlowGraphSchema.parse(value) as AutomationGraphV1;}
