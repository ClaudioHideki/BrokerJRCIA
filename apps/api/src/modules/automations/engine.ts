import { randomUUID } from 'node:crypto';
import { FlowGraphSchema, AutomationHandoffConfigSchema, hasNativeHandoffConfig, automationNodePorts, menuOptions,
  type AutomationGraphV1, type FlowNode } from '@jrc/contracts';
import type { PublishedAutomation, RuntimeInput, RuntimeResult, RuntimeState } from './types.js';
import { executeDataNode } from './data-nodes.js';
import {getDataNodeV2Schema,isDataNodeType} from '@jrc/contracts';
import { isBusinessOpen } from './business-hours.js';
import { assertRuntimeState, isRuntimeKey as safeKey, renderRuntimeText as renderFlowText,
  renderRuntimeValue, runtimeJson, runtimeStateVersion, runtimeText } from './runtime-state.js';

const dataTypes=new Set(['data-set','data-rename','data-pick','data-merge','data-map','data-filter','json-parse','json-stringify','expression']);
const ioTypes=new Set(['http','sql','code','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent']);
const string=(value:unknown)=>typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';
const next=(graph:AutomationGraphV1,nodeId:string,port='next')=>graph.edges.find(edge=>edge.source===nodeId&&edge.port===port)?.target;
const runtimePorts = automationNodePorts;
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

export { validateAutomationGraph } from '@jrc/contracts';

export async function executeAutomation(
  root:PublishedAutomation,input:RuntimeInput,resolve:(automationId:string,version:number)=>Promise<PublishedAutomation>,previous?:RuntimeState,
):Promise<RuntimeResult>{
  const stateVersion=runtimeStateVersion(previous,root.runtimeStateVersion);
  const variables:RuntimeState['variables']=Object.create(null) as RuntimeState['variables'];
  for(const [key,value] of Object.entries(previous?.variables??{}))if(safeKey(key))variables[key]=runtimeJson(stateVersion===1?string(value):value);
  const acceptsMessage=input.eventType==='MESSAGE'&&(!previous?.waiting||previous.waiting.kind==='EVENT');
  if(stateVersion===1||!previous||acceptsMessage)variables.message=runtimeJson(input.text);
  const state:RuntimeState=previous?{...previous,runtimeStateVersion:stateVersion,variables,stack:[...previous.stack]}:{runtimeStateVersion:stateVersion,automationId:root.automationId,version:root.version,
    nodeId:root.graph.nodes.find(node=>node.type==='start')!.id,variables,steps:0,stack:[]};
  assertRuntimeState(state);
  const finish=(result:RuntimeResult):RuntimeResult=>{assertRuntimeState(result.state);return result;};
  // Ordinals are the emission order within this turn, including nested subflows.
  // Persistence adds the durable turn offset; node IDs are not sequence numbers.
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
      const wakeAt=state.waiting.wakeAt===undefined?undefined:new Date(state.waiting.wakeAt);
      if(wakeAt&&!Number.isFinite(wakeAt.getTime()))throw new Error('AUTOMATION_DELAY_STATE_INVALID');
      if(input.eventType!=='TIMER'||(wakeAt&&input.now.getTime()<wakeAt.getTime()))return finish({status:'WAITING',state,effects,trace,wait:{kind:'DELAY',nodeId:waiting.id,...(wakeAt?{wakeAt}:{})}});
      current=next(published.graph,waiting.id)??null;
    }else if(state.waiting.kind==='IO'){
      if(input.eventType!=='RESUME')return finish({status:'WAITING',state,effects,trace,wait:{kind:'IO',nodeId:waiting.id}});
      const target=string(waiting.data.target),output=input.payload?.output;
      if(safeKey(target))variables[target]=stateVersion===1?runtimeJson(runtimeText(runtimeJson(output??null))):runtimeJson(output);
      const outcome=string(input.payload?.outcome)||'unknown',allowed=automationNodePorts(waiting);
      current=next(published.graph,waiting.id,allowed.includes(outcome)?outcome:allowed.at(-1))??null;
    }else{
      if(input.eventType==='TIMER')throw new Error('AUTOMATION_EVENT_WAIT_REQUIRES_EVENT');
      if(waiting.type==='input'){
        const variable=string(waiting.data.variable);if(safeKey(variable))variables[variable]=runtimeJson(input.text);
        current=next(published.graph,waiting.id)??null;
      }else if(waiting.type==='menu'){
        const selected=input.text.trim(),option=menuOptions(waiting).find(item=>item.value===selected);
        if(!option){const prompt=renderFlowText(waiting.data.text,variables),list=menuOptions(waiting).map(item=>`${item.value} - ${item.label}`).join('\n');
          effects.push({nodeId:waiting.id,ordinal:effects.length,kind:'SEND_TEXT',payload:{text:[prompt,list,'Responda com o número da opção.'].filter(Boolean).join('\n')}});
          return finish({status:'WAITING',state,effects,trace,wait:{kind:'EVENT',nodeId:waiting.id}});}
        const variable=string(waiting.data.variable)||'menu.choice';if(safeKey(variable))variables[variable]=selected;
        current=next(published.graph,waiting.id,`option-${option.value}`)??null;
      }else throw new Error('AUTOMATION_EVENT_WAIT_INVALID');
    }
    delete state.waiting;
  }
  for(let turn=0;turn<500;turn++){
    assertRuntimeState(state);
    if(++state.steps>5000)throw new Error('AUTOMATION_STEP_LIMIT');
    const activeFrame=state.stack.at(-1);if(activeFrame?.deadlineAt&&input.now.getTime()>activeFrame.deadlineAt)throw new Error('AUTOMATION_SUBFLOW_TIMEOUT');
    if(!current){
      const frame=state.stack.pop();
      if(!frame){state.nodeId=null;return finish({status:'COMPLETED',state,effects,trace});}
      if(frame.outputSchema&&!schemaMatches(frame.outputSchema,variables))throw new Error('AUTOMATION_SUBFLOW_OUTPUT_SCHEMA_INVALID');
      if(frame.child)trace.push({nodeId:frame.child.nodeId,type:'subflow-result',label:'Subflow concluído',input:frame.child.input,output:{automationId:frame.child.automationId,version:frame.child.version,correlationId:frame.child.correlationId,variables}});
      published=await getPublished(frame.automationId,frame.version);state.automationId=frame.automationId;state.version=frame.version;current=frame.returnNodeId;continue;
    }
    const node=published.graph.nodes.find(candidate=>candidate.id===current);if(!node)throw new Error('AUTOMATION_NODE_MISSING');
    const record={nodeId:node.id,type:node.type,label:node.label,input:{message:variables.message??''},output:{} as Record<string,unknown>};trace.push(record);
    if(node.type==='end') {current=null;continue;}
    if(node.type==='handoff'){
      const native=hasNativeHandoffConfig(node.data),parsed=native?AutomationHandoffConfigSchema.safeParse(node.data):null;
      if(parsed&&!parsed.success)throw new Error('AUTOMATION_HANDOFF_CONFIG_INVALID');
      const payload=parsed?.success?parsed.data:{};
      record.output=parsed?.success?{status:'HANDOFF_PENDING',destination:parsed.data.destination,target:parsed.data.target}
        :{status:'ACTION_REQUIRED',reason:'HANDOFF_DESTINATION_REQUIRED'};
      effects.push({nodeId:node.id,ordinal:effects.length,kind:'HANDOFF',payload});state.nodeId=null;return finish({status:'HANDOFF',state,effects,trace});
    }
    if(node.type==='message'){
      const text=renderFlowText(node.data.text,variables);record.output={text};effects.push({nodeId:node.id,ordinal:effects.length,kind:'SEND_TEXT',payload:{text}});
    }
    if(node.type==='input'||node.type==='menu'){
      const prompt=renderFlowText(node.data.text,variables),text=node.type==='menu'
        ? [prompt,menuOptions(node).map(item=>`${item.value} - ${item.label}`).join('\n')].filter(Boolean).join('\n'):prompt;
      if(text.trim())effects.push({nodeId:node.id,ordinal:effects.length,kind:'SEND_TEXT',payload:{text}});
      state.nodeId=node.id;state.waiting={kind:'EVENT',nodeId:node.id};return finish({status:'WAITING',state,effects,trace,wait:{kind:'EVENT',nodeId:node.id}});
    }
    if(node.type==='delay'){
      const seconds=Number(node.data.seconds);const wakeAt=new Date(input.now.getTime()+seconds*1000);
      state.nodeId=node.id;state.waiting={kind:'DELAY',nodeId:node.id,...(stateVersion===2?{wakeAt:wakeAt.getTime()}:{})};return finish({status:'WAITING',state,effects,trace,wait:{kind:'DELAY',nodeId:node.id,wakeAt}});
    }
    if(node.type==='subflow'){
      const automationId=string(node.data.automationId),version=Number(node.data.version),returnNodeId=next(published.graph,node.id);
      if(!returnNodeId)throw new Error('AUTOMATION_SUBFLOW_RETURN_MISSING');
      if(state.stack.some(frame=>frame.automationId===automationId)||automationId===published.automationId)throw new Error('AUTOMATION_SUBFLOW_RECURSION');
      const child=await getPublished(automationId,version);
      if(runtimeStateVersion(undefined,child.runtimeStateVersion)!==stateVersion)throw new Error('AUTOMATION_SUBFLOW_RUNTIME_VERSION_MISMATCH');
      const inputMap=node.data.input&&typeof node.data.input==='object'&&!Array.isArray(node.data.input)?node.data.input as Record<string,unknown>:{};
      const childInput=Object.fromEntries(Object.entries(inputMap).map(([key,value])=>[key,stateVersion===2?renderRuntimeValue(value,variables):renderFlowText(value,variables)]));
      if(node.data.inputSchema&&!schemaMatches(node.data.inputSchema,childInput))throw new Error('AUTOMATION_SUBFLOW_INPUT_SCHEMA_INVALID');
      for(const [key,value] of Object.entries(childInput))if(safeKey(key))variables[key]=runtimeJson(value);
      const correlationId=randomUUID(),timeoutMs=Number(node.data.timeoutMs??10000);
      record.output={automationId,version,correlationId,input:childInput,status:'STARTED'};
      state.stack.push({automationId:published.automationId,version:published.version,returnNodeId,deadlineAt:input.now.getTime()+timeoutMs,
        ...(node.data.outputSchema&&typeof node.data.outputSchema==='object'?{outputSchema:node.data.outputSchema as Record<string,unknown>}:{ }),child:{nodeId:node.id,automationId,version,correlationId,input:childInput}});published=child;
      state.automationId=automationId;state.version=version;current=published.graph.nodes.find(candidate=>candidate.type==='start')!.id;continue;
    }
    if(dataTypes.has(node.type)){
      if(node.data.configVersion===2){
        if(!isDataNodeType(node.type)||!getDataNodeV2Schema(node.type).safeParse(node.data).success)throw new Error('AUTOMATION_DATA_CONFIG_INVALID');
        try{record.output=executeDataNode(node.type,node.data,variables,stateVersion===2?'json':'legacy');
          current=next(published.graph,node.id,'success')??null;
        }catch(error){
          const code=error instanceof Error?error.message:'';
          if(!/^(?:AUTOMATION_DATA_|AUTOMATION_JSON_|AUTOMATION_EXPRESSION_|AUTOMATION_STATE_VALUE_)[A-Z_]+$/u.test(code)||code==='AUTOMATION_DATA_RUNTIME_VERSION_MISMATCH')throw error;
          variables[node.data.errorVariable as string]=runtimeJson({code});record.output={outcome:'ERROR',code};
          current=next(published.graph,node.id,'error')??null;
        }
        if(!current)throw new Error('AUTOMATION_DATA_RETURN_MISSING');continue;
      }
      record.output=executeDataNode(node.type,node.data,variables,stateVersion===2?'json':'legacy');
    }
    if(ioTypes.has(node.type)){
      const kind=node.type==='http'?'IO_HTTP':node.type==='sql'?'IO_SQL':node.type==='code'?'IO_CODE':'IO_AI';
      const payload={...node.data,nodeType:node.type,runtimeStateVersion:stateVersion,variables};record.output={queued:true,kind};effects.push({nodeId:node.id,ordinal:effects.length,kind,payload});
      state.nodeId=node.id;state.waiting={kind:'IO',nodeId:node.id};return finish({status:'WAITING',state,effects,trace,wait:{kind:'IO',nodeId:node.id}});
    }
    if(node.type==='variable'){const key=string(node.data.variable);if(safeKey(key))variables[key]=stateVersion===2?renderRuntimeValue(node.data.value,variables):renderFlowText(node.data.value,variables);}
    let port='next';
    if(node.type==='schedule'){
      const open=isBusinessOpen(node.data,input.now);
      record.output={open,timezone:node.data.timezone,at:input.now.toISOString()};
      port=open?'open':'closed';
    }
    if(node.type==='condition'){
      const normalize=(value:string)=>node.data.comparisonMode==='JRC_NORMALIZED'?value.toLowerCase().trim():value;
      const actual=normalize(runtimeText(variables[string(node.data.field)])),expected=normalize(renderFlowText(node.data.value,variables)),operator=string(node.data.operator);
      const ok=operator==='present'?Boolean(actual.trim()):operator==='not_equals'?actual!==expected:operator==='contains'?actual.toLowerCase().includes(expected.toLowerCase())
        :operator==='starts_with'?actual.toLowerCase().startsWith(expected.toLowerCase()):actual===expected;port=ok?'yes':'no';
    }
    current=next(published.graph,node.id,port)??null;state.nodeId=current;
  }
  throw new Error('AUTOMATION_TURN_LIMIT');
}

export function automationPorts(node:FlowNode):string[]{return runtimePorts(node);}
export function parseAutomationGraph(value:unknown):AutomationGraphV1{return FlowGraphSchema.parse(value) as AutomationGraphV1;}
