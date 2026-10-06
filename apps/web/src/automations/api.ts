import { LocalAttendanceChannelsSchema, attendanceCatalogSchema, ChatwootStatusSchema, AutomationDefinitionV1Schema, AutomationPublishedVersionV1Schema, NodeDiagnosticSchema, legacyStringsToNodeDiagnostics, type AttendanceDiagnostic, type AutomationDefinitionV1, type AutomationGraphV1, type AutomationPublishedVersionV1 } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import {LocalAttendanceDirectorySchema} from '@jrc/contracts';

export interface AutomationNodeCatalogItem {type:string;category:string;label:string;description:string;version?:number;availability?:'AVAILABLE'|'UNAVAILABLE';unavailableReason?:string|null}
export async function validateAutomation(client: ApiClient, id: string) {
  const result = await client.request<{valid:boolean;diagnostics?:unknown;errors?:unknown}>(`/v1/automations/${encodeURIComponent(id)}/validate`, {method:'POST',body:'{}'});
  if (result.diagnostics !== undefined) return { valid: result.valid, diagnostics: parsed(NodeDiagnosticSchema.array(), result.diagnostics, 'Diagnósticos inválidos retornados pelo serviço.') };
  if (!Array.isArray(result.errors) || !result.errors.every((item):item is string => typeof item === 'string')) throw new ApiClientError('Diagnósticos inválidos retornados pelo serviço.',502);
  return { valid: result.valid, diagnostics: legacyStringsToNodeDiagnostics(result.errors) };
}
export interface AutomationExecution {attendanceDiagnostic?:AttendanceDiagnostic;id:string;automationId:string;version:number;bindingId:string;channelId:string;conversationRef?:string|null;contactRef?:string|null;status:string;currentNodeId:string|null;correlationId:string;startedAt:string;updatedAt:string;completedAt:string|null;durationMs?:number;errorCode?:string|null;input?:unknown;state?:unknown;nodes?:Array<{id:string;nodeId:string;ordinal:number;attempt:number;durationMs:number|null;status:string;input:unknown;output:unknown;errorCode:string|null;startedAt:string;completedAt:string|null}>;outbox?:Array<{id:string;nodeId:string;ordinal:number;kind:string;handoffDestination?:'LOCAL'|'CENTRAL'|null;status:string;attempts:number;remoteReference:string|null;lastError:string|null;createdAt:string;updatedAt:string}>}
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

export async function listHandoffConnections(client: ApiClient, signal?: AbortSignal) {
  const status = parsed(ChatwootStatusSchema, await client.request('/v1/integrations/chatwoot', {signal:signal??null}), 'Conexões inválidas retornadas pelo serviço.');
  return status.connections.filter(connection => connection.status === 'READY' && connection.inboxId !== null);
}
export async function listLocalHandoffChannels(client: ApiClient, organizationId: string, signal?: AbortSignal) {
  const result = parsed(LocalAttendanceChannelsSchema,
    await client.request('/v1/attendance/local-channels', {signal: signal ?? null}),
    'Catálogo local inválido retornado pelo serviço.');
  const ids = new Set<string>();
  for (const item of result.data) {
    if (item.scope.organizationId !== organizationId || ids.has(item.scope.channelId))
      throw new ApiClientError('O catálogo não corresponde ao escopo desta empresa e caixa.', 409);
    ids.add(item.scope.channelId);
  }
  return result.data;
}
export async function getLocalHandoffCatalog(client:ApiClient,organizationId:string,channelId:string,signal?:AbortSignal){
 const value=parsed(LocalAttendanceDirectorySchema,await client.request(`/v1/attendance/local-channels/${encodeURIComponent(channelId)}/catalog`,{signal:signal??null}),'Catálogo humano do Broker inválido.');
 if(value.scope.organizationId!==organizationId||value.scope.channelId!==channelId)throw new ApiClientError('O catálogo não corresponde ao escopo desta empresa e caixa.',409);
 const agents=new Set(value.agents.map(a=>a.id)),teams=new Set(value.teams.map(t=>t.id));
 if(agents.size!==value.agents.length||teams.size!==value.teams.length||value.teams.some(t=>new Set(t.memberIds).size!==t.memberIds.length||t.memberIds.some(id=>!agents.has(id))))throw new ApiClientError('Catálogo humano do Broker inválido.',502);
 return value;
}
export async function getHandoffCatalog(client: ApiClient, organizationId: string, integrationId: string, signal?: AbortSignal) {
  const catalog = parsed(attendanceCatalogSchema,
    await client.request(`/v1/integrations/chatwoot/connections/${encodeURIComponent(integrationId)}/attendance-catalog`, {signal:signal??null}),
    'Catálogo de atendimento inválido retornado pelo serviço.');
  if (catalog.scope.organizationId !== organizationId || catalog.scope.integrationId !== integrationId)
    throw new ApiClientError('O catálogo não corresponde ao escopo desta empresa e caixa.', 409);
  return catalog;
}
