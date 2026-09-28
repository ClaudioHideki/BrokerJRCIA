import { AutomationDefinitionV1Schema, AutomationPublishedVersionV1Schema, type AutomationDefinitionV1, type AutomationGraphV1, type AutomationPublishedVersionV1 } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';

export interface AutomationNodeCatalogItem {type:string;category:string;label:string;description:string}
export interface AutomationExecution {id:string;automationId:string;version:number;bindingId:string;channelId:string;conversationRef?:string|null;contactRef?:string|null;status:string;currentNodeId:string|null;correlationId:string;startedAt:string;updatedAt:string;completedAt:string|null;durationMs?:number;errorCode?:string|null;input?:unknown;state?:unknown;nodes?:Array<{id:string;nodeId:string;ordinal:number;attempt:number;durationMs:number|null;status:string;input:unknown;output:unknown;errorCode:string|null;startedAt:string;completedAt:string|null}>;outbox?:Array<{id:string;nodeId:string;ordinal:number;kind:string;status:string;attempts:number;remoteReference:string|null;lastError:string|null;createdAt:string;updatedAt:string}>}
const parsed=<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown,message:string):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApiClientError(message,502);return result.data;};
export async function listAutomationsPage(client:ApiClient,cursor?:string){
  const value=await client.request<{data:unknown[];nextCursor?:string|null}>(`/v1/automations${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
  if(value.nextCursor!=null&&(typeof value.nextCursor!=='string'||!value.nextCursor))throw new ApiClientError('Página inválida retornada pelo serviço.',502);
  return {data:value.data.map(item=>parsed(AutomationDefinitionV1Schema,item,'Automação inválida retornada pelo serviço.')),nextCursor:value.nextCursor??null};
}
export async function listAutomations(client:ApiClient){
  const all:AutomationDefinitionV1[]=[],seenIds=new Set<string>(),seenCursors=new Set<string>();let cursor:string|null=null;
  do {const page=await listAutomationsPage(client,cursor??undefined);for(const item of page.data)if(!seenIds.has(item.id)){seenIds.add(item.id);all.push(item);}
    cursor=page.nextCursor;if(cursor&&seenCursors.has(cursor))throw new ApiClientError('Paginação inválida retornada pelo serviço.',502);if(cursor)seenCursors.add(cursor);
  } while(cursor);
  return all;
}
export async function getAutomation(client:ApiClient,id:string){return parsed(AutomationDefinitionV1Schema,await client.request<unknown>(`/v1/automations/${encodeURIComponent(id)}`),'Automação inválida retornada pelo serviço.');}
export async function createAutomation(client:ApiClient,name:string,graph:AutomationGraphV1,idempotencyKey:string=crypto.randomUUID()){return parsed(AutomationDefinitionV1Schema,await client.request('/v1/automations',{method:'POST',headers:{'Idempotency-Key':idempotencyKey},body:JSON.stringify({name,graph})}),'Automação inválida retornada pelo serviço.');}
export async function saveAutomation(client:ApiClient,value:AutomationDefinitionV1){return parsed(AutomationDefinitionV1Schema,await client.request(`/v1/automations/${value.id}`,{method:'PUT',body:JSON.stringify({name:value.name,graph:value.draft.graph,revision:value.draft.revision})}),'Automação inválida retornada pelo serviço.');}
export async function listAutomationNodes(client:ApiClient){return (await client.request<{data:AutomationNodeCatalogItem[]}>('/v1/automation-nodes')).data;}
export async function listVersions(client:ApiClient,id:string){const value=await client.request<{data:unknown[]}>(`/v1/automations/${id}/versions`);return value.data.map(item=>parsed(AutomationPublishedVersionV1Schema,item,'Versão inválida retornada pelo serviço.'));}
export async function listExecutions(client:ApiClient,automationId?:string){const query=automationId?`?automationId=${encodeURIComponent(automationId)}`:'';return (await client.request<{data:AutomationExecution[]}>(`/v1/executions${query}`)).data;}
export type {AutomationDefinitionV1,AutomationGraphV1,AutomationPublishedVersionV1};
