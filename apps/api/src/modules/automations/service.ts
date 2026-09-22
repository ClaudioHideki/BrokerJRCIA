import { createHash, randomUUID } from 'node:crypto';
import { AUTOMATION_ORIGIN, AutomationGraphV1Schema, type AutomationGraphV1 } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { executeAutomation, validateAutomationGraph } from './engine.js';
import { createPostgresAutomationRepository, type AutomationRepository, type DefinitionRow, type ExecutionRow, type OutboxKind, type OutboxRow, type VersionRow } from './repository.js';
import type { AutomationSummary, PublishedAutomation, RuntimeState } from './types.js';
import { createPostgresMessagingRepository, type MessagingRepository } from '../messaging/repository.js';

export class AutomationError extends Error{constructor(readonly code:string,readonly statusCode=422,readonly details:string[]=[]){super(code);}}
export interface AutomationServiceOptions {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;repository?:AutomationRepository;messaging?:MessagingRepository;enabled?:boolean}
const iso=(value:Date|string)=>value instanceof Date?value.toISOString():value;
const definition=(row:DefinitionRow):AutomationSummary=>({schemaVersion:1 as const,id:row.id,organizationId:row.organizationId,name:row.name,lifecycleStatus:row.lifecycleStatus,
  draft:{revision:row.draftRevision,graph:row.draftGraph},activeVersion:row.activeVersion,updatedAt:iso(row.updatedAt)});
const version=(row:VersionRow)=>({schemaVersion:1 as const,automationId:row.automationId,organizationId:row.organizationId,version:row.version,
  graph:row.graph,checksum:row.checksum,publishedAt:iso(row.publishedAt)});
const execution=(row:ExecutionRow)=>({schemaVersion:1 as const,id:row.id,organizationId:row.organizationId,automationId:row.automationId,version:row.version,
  bindingId:row.bindingId,channelId:row.channelId,status:row.status,currentNodeId:row.currentNodeId,correlationId:row.correlationId,
  startedAt:iso(row.startedAt),updatedAt:iso(row.updatedAt),completedAt:row.completedAt?iso(row.completedAt):null});
const redact=(value:unknown):unknown=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,child])=>[key,/(?:secret|token|password|authorization|credential)/i.test(key)?'[REDACTED]':redact(child)])):typeof value==='string'?value.slice(0,4096):value;
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ? Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,stable(child)])):value;
const canonical=(value:unknown):string=>JSON.stringify(stable(value));

export function createAutomationService(options:AutomationServiceOptions){
  const repository=options.repository??createPostgresAutomationRepository(),messaging=options.messaging??createPostgresMessagingRepository(),enabled=options.enabled??true;
  const available=()=>{if(!enabled)throw new AutomationError('AUTOMATION_RUNTIME_DISABLED',503);};
  const getDefinition=async(tx:TenantTransaction,org:string,id:string,lock=false)=>{
    const row=await repository.getDefinition(tx,org,id,lock);if(!row)throw new AutomationError('AUTOMATION_NOT_FOUND',404);return row;};
  const resolveVersion=async(tx:TenantTransaction,org:string,id:string,number:number):Promise<PublishedAutomation>=>{
    const row=await repository.getVersion(tx,org,id,number);if(!row)throw new AutomationError('AUTOMATION_VERSION_NOT_FOUND',404);return {automationId:id,version:number,graph:row.graph};};
  const validateDependencies=async(tx:TenantTransaction,org:string,rootId:string,graph:AutomationGraphV1)=>{
    const active=new Set<string>([rootId]);
    const visit=async(current:AutomationGraphV1)=>{for(const node of current.nodes.filter(node=>node.type==='subflow')){
      const id=String(node.data.automationId),v=Number(node.data.version),key=`${id}:${v}`;
      if(active.has(id))throw new AutomationError('AUTOMATION_SUBFLOW_RECURSION',422,[`Ciclo detectado em ${id}.`]);
      active.add(id);const child=await repository.getVersion(tx,org,id,v);if(!child)throw new AutomationError('AUTOMATION_SUBFLOW_VERSION_NOT_FOUND',422,[key]);
      await visit(child.graph);active.delete(id);
    }};await visit(graph);
  };
  return {
    status:()=>({enabled,engine:'AUTOMATION_RUNTIME_V2' as const}),
    list:(org:string)=>{available();return options.transact(org,async tx=>({data:(await repository.listDefinitions(tx,org)).map(definition)}));},
    get:(org:string,id:string)=>{available();return options.transact(org,async tx=>definition(await getDefinition(tx,org,id)));},
    create:(org:string,input:{name:string;graph:AutomationGraphV1})=>{available();return options.transact(org,async tx=>{
      const graph=AutomationGraphV1Schema.parse(input.graph),name=input.name.trim();if(!name)throw new AutomationError('AUTOMATION_NAME_INVALID',400);
      const errors=validateAutomationGraph(graph);if(errors.length)throw new AutomationError('AUTOMATION_INVALID',422,errors);
      return definition(await repository.insertDefinition(tx,{org,id:randomUUID(),name,graph}));});},
    save:(org:string,id:string,input:{name:string;graph:AutomationGraphV1;revision:number})=>{available();return options.transact(org,async tx=>{
      const graph=AutomationGraphV1Schema.parse(input.graph),errors=validateAutomationGraph(graph);if(errors.length)throw new AutomationError('AUTOMATION_INVALID',422,errors);
      const updated=await repository.updateDefinition(tx,{org,id,name:input.name.trim(),graph,revision:input.revision});if(!updated)throw new AutomationError('AUTOMATION_CHANGED',409);return definition(updated);});},
    validate:(org:string,id:string)=>{available();return options.transact(org,async tx=>{const row=await getDefinition(tx,org,id);const errors=validateAutomationGraph(row.draftGraph);if(!errors.length)await validateDependencies(tx,org,id,row.draftGraph);return {valid:errors.length===0,errors};});},
    simulate:(org:string,id:string,input:{text:string})=>{available();return options.transact(org,async tx=>{const row=await getDefinition(tx,org,id);const errors=validateAutomationGraph(row.draftGraph);if(errors.length)throw new AutomationError('AUTOMATION_INVALID',422,errors);
      return executeAutomation({automationId:id,version:row.activeVersion??1,graph:row.draftGraph},{text:input.text,eventType:'MESSAGE',now:new Date()},(child,childVersion)=>resolveVersion(tx,org,child,childVersion));});},
    publish:(org:string,id:string,revision:number)=>{available();return options.transact(org,async tx=>{const row=await getDefinition(tx,org,id,true);if(row.draftRevision!==revision)throw new AutomationError('AUTOMATION_CHANGED',409);
      const errors=validateAutomationGraph(row.draftGraph);if(errors.length)throw new AutomationError('AUTOMATION_INVALID',422,errors);await validateDependencies(tx,org,id,row.draftGraph);
      const next=(row.activeVersion??0)+1,checksum=createHash('sha256').update(canonical(row.draftGraph)).digest('hex');const published=await repository.insertVersion(tx,{org,id,version:next,graph:row.draftGraph,checksum});await repository.activateVersion(tx,org,id,next);return version(published);});},
    versions:(org:string,id:string)=>{available();return options.transact(org,async tx=>{await getDefinition(tx,org,id);return {data:(await repository.listVersions(tx,org,id)).map(version)};});},
    bindings:(org:string,id:string)=>{available();return options.transact(org,async tx=>{await getDefinition(tx,org,id);return {data:(await repository.listBindings(tx,org,id)).map(row=>({...row,createdAt:iso(row.createdAt),updatedAt:iso(row.updatedAt),schemaVersion:1}))};});},
    bind:(org:string,id:string,input:{channelId:string;version?:number;humanDestinationId?:string|null})=>{available();return options.transact(org,async tx=>{const row=await getDefinition(tx,org,id);const selected=input.version??row.activeVersion;if(!selected)throw new AutomationError('AUTOMATION_NOT_PUBLISHED',409);if(!await repository.getVersion(tx,org,id,selected))throw new AutomationError('AUTOMATION_VERSION_NOT_FOUND',404);
      const channel=await messaging.findChannel(tx,org,input.channelId);if(!channel)throw new AutomationError('CHANNEL_NOT_FOUND',404);
      const binding=await repository.insertBinding(tx,{org,id:randomUUID(),automationId:id,version:selected,channelId:input.channelId,humanDestinationId:input.humanDestinationId??null});
      await messaging.setChannelBot(tx,{organizationId:org,channelId:input.channelId,botPublicId:id,botOriginReference:AUTOMATION_ORIGIN});return {...binding,createdAt:iso(binding.createdAt),updatedAt:iso(binding.updatedAt),schemaVersion:1};});},
    setBindingStatus:(org:string,bindingId:string,input:{status:'ACTIVE'|'PAUSED'|'DISABLED';revision:number})=>{available();return options.transact(org,async tx=>{const row=await repository.setBindingStatus(tx,org,bindingId,input.status,input.revision);if(!row)throw new AutomationError('AUTOMATION_BINDING_CHANGED',409);return {...row,createdAt:iso(row.createdAt),updatedAt:iso(row.updatedAt),schemaVersion:1};});},
    _resolveVersion:resolveVersion,_repository:repository,
  };
}

export type AutomationService=ReturnType<typeof createAutomationService>;
export interface RouteAutomationEvent {channelId:string;conversationId?:string|null;eventKey:string;text:string;payload?:Record<string,unknown>}
export function createEventRouter(options:AutomationServiceOptions){
  const repository=options.repository??createPostgresAutomationRepository();return {route:(org:string,event:RouteAutomationEvent)=>options.transact(org,async tx=>{
    const eventId=randomUUID();const inserted=await repository.insertEvent(tx,{org,id:eventId,eventKey:event.eventKey,type:'MESSAGE',payload:event.payload??{text:event.text}});if(!inserted)return {duplicate:true,execution:null};
    const routed=await repository.routeEvent(tx,{org,eventId,executionId:randomUUID(),correlationId:randomUUID(),channelId:event.channelId,conversationId:event.conversationId??null,eventKey:event.eventKey,input:{text:event.text,eventType:'MESSAGE',...(event.payload??{})}});
    return routed?{duplicate:false,execution:execution(routed.execution),resumed:routed.resumed}:{duplicate:false,execution:null};})};
}

export function createExecutionService(options:AutomationServiceOptions){
  const repository=options.repository??createPostgresAutomationRepository();
  const resolve=async(tx:TenantTransaction,org:string,id:string,v:number)=>{const row=await repository.getVersion(tx,org,id,v);if(!row)throw new AutomationError('AUTOMATION_VERSION_NOT_FOUND',404);return {automationId:id,version:v,graph:row.graph};};
  return {
    list:(org:string,automationId?:string)=>options.transact(org,async tx=>({data:(await repository.listExecutions(tx,org,automationId)).map(execution)})),
    get:(org:string,id:string)=>options.transact(org,async tx=>{const row=await repository.getExecution(tx,org,id);if(!row)throw new AutomationError('AUTOMATION_EXECUTION_NOT_FOUND',404);const [nodes,outbox,context]=await Promise.all([repository.listNodeExecutions(tx,org,id),repository.listExecutionOutbox(tx,org,id),repository.getExecutionContext(tx,org,id)]);return {...execution(row),conversationRef:context.conversationId,contactRef:context.contactId,state:redact(row.state),errorCode:row.errorCode,input:redact(row.input),durationMs:(row.completedAt?new Date(row.completedAt):new Date()).getTime()-new Date(row.startedAt).getTime(),nodes:nodes.map(node=>({...node,attempt:Math.floor(node.ordinal/1000)+1,durationMs:node.completedAt?Math.max(0,new Date(node.completedAt).getTime()-new Date(node.startedAt).getTime()):null,input:redact(node.input),output:redact(node.output),startedAt:iso(node.startedAt),completedAt:node.completedAt?iso(node.completedAt):null})),outbox:outbox.map(item=>({...item,lastError:item.lastError,createdAt:iso(item.createdAt),updatedAt:iso(item.updatedAt)}))};}),
    runOnce:(org:string)=>options.transact(org,async tx=>{const leaseToken=randomUUID(),claimed=await repository.claimExecution(tx,org,leaseToken,120000);if(!claimed)return {processed:false};
      try{const root=await resolve(tx,org,claimed.automationId,claimed.version),kind=String(claimed.input.eventType??'MESSAGE') as 'MESSAGE'|'RESUME'|'TIMER';
        const result=await executeAutomation(root,{text:String(claimed.input.text??''),eventType:kind,now:new Date(),payload:claimed.input},(id,v)=>resolve(tx,org,id,v),Object.keys(claimed.state??{}).length?claimed.state as RuntimeState:undefined);
        await repository.saveExecutionResult(tx,claimed,result);return {processed:true,executionId:claimed.id,status:result.status};
      }catch(error){await repository.failExecution(tx,org,claimed.id,leaseToken,error instanceof Error?error.message.slice(0,120):'AUTOMATION_EXECUTION_FAILED',false);return {processed:true,executionId:claimed.id,status:'FAILED' as const};}}),
    cancel:(org:string,id:string)=>options.transact(org,async tx=>{if(!await repository.cancelExecution(tx,org,id))throw new AutomationError('AUTOMATION_EXECUTION_NOT_CANCELABLE',409);return {ok:true};}),
    retry:(org:string,id:string)=>options.transact(org,async tx=>{const row=await repository.getExecution(tx,org,id);if(!row)throw new AutomationError('AUTOMATION_EXECUTION_NOT_FOUND',404);if(row.status==='UNKNOWN')throw new AutomationError('AUTOMATION_EXECUTION_RECONCILIATION_REQUIRED',409);if(!await repository.retryExecution(tx,org,id))throw new AutomationError('AUTOMATION_EXECUTION_NOT_RETRYABLE',409);return {ok:true};}),
    reconcile:(org:string,id:string,actorId:string,input:{outboxId:string;outcome:'CONFIRMED_SENT'|'CONFIRMED_NOT_SENT'|'UNRESOLVED';evidenceCode:string;providerReference?:string})=>options.transact(org,async tx=>{const row=await repository.getExecution(tx,org,id);if(!row)throw new AutomationError('AUTOMATION_EXECUTION_NOT_FOUND',404);if(!await repository.reconcileUnknownOutbox(tx,{org,executionId:id,actorId,...input}))throw new AutomationError('AUTOMATION_EFFECT_NOT_RECONCILABLE',409);return {ok:true,outcome:input.outcome,automaticResend:false};}),
    resume:(org:string,id:string,eventKey:string,payload:Record<string,unknown>)=>options.transact(org,async tx=>{if(!await repository.resumeExecution(tx,{org,id,eventId:randomUUID(),eventKey,payload}))throw new AutomationError('AUTOMATION_EXECUTION_NOT_RESUMABLE',409);return {ok:true};}),
    releaseDueWaits:(org:string,limit=100)=>options.transact(org,tx=>repository.releaseDueWaits(tx,org,limit)),
  };
}

export type OutboxDispatchResult={kind:'SENT';remoteReference?:string;resumePayload?:Record<string,unknown>}|{kind:'NOT_SENT';retryAt:Date;error:string}|{kind:'FAILED';error:string;resumePayload?:Record<string,unknown>};
export interface ExternalEffectDispatcher {dispatch(item:OutboxRow):Promise<OutboxDispatchResult>}
export function createOutboxDispatcher(options:AutomationServiceOptions,external:ExternalEffectDispatcher,kinds:OutboxKind[]=['SEND_TEXT','HANDOFF','RESUME_EVENT']){const repository=options.repository??createPostgresAutomationRepository();return {runOnce:async(org:string)=>{
  const leaseToken=randomUUID(),item=await options.transact(org,tx=>repository.claimOutbox(tx,org,leaseToken,120000,kinds));if(!item)return {processed:false};
  // The row is already UNKNOWN before the external call. A process crash can therefore never cause a blind replay.
  let result:OutboxDispatchResult;try{result=await external.dispatch(item);}catch{return {processed:true,id:item.id,status:'UNKNOWN' as const};}
  if(result.kind==='SENT')await options.transact(org,async tx=>{if(result.resumePayload)await repository.resumeExecution(tx,{org,id:item.executionId,eventId:randomUUID(),eventKey:`io:${item.id}`,payload:result.resumePayload});await repository.settleOutbox(tx,org,item.id,leaseToken,{status:'SENT',...(result.remoteReference?{remoteReference:result.remoteReference}:{})});});
  else if(result.kind==='NOT_SENT')await options.transact(org,tx=>repository.settleOutbox(tx,org,item.id,leaseToken,{status:'PENDING',error:result.error,availableAt:result.retryAt}));
  else await options.transact(org,async tx=>{if(result.resumePayload)await repository.resumeExecution(tx,{org,id:item.executionId,eventId:randomUUID(),eventKey:`io:${item.id}`,payload:result.resumePayload});await repository.settleOutbox(tx,org,item.id,leaseToken,{status:'FAILED',error:result.error});});
  return {processed:true,id:item.id,status:result.kind};
}};}
