import {HistoryImportCapabilitySchema,HistoryImportOperationSchema,HistoryImportSelectionSchema,type HistoryImportOperation,type HistoryImportSelection} from '@jrc/contracts';
import {z} from 'zod';
import type {ApiClient} from '../api/client.js';
export function historyImportApi(client:ApiClient,organizationId:string,channelId:string,signal:AbortSignal){
 const base=`/v1/channels/${encodeURIComponent(z.string().uuid().parse(channelId))}/history-import`;
 z.string().uuid().parse(organizationId);
 function scope<T extends {organizationId:string;channelId:string}>(value:T):T{if(value.organizationId!==organizationId||value.channelId!==channelId)throw new Error('Resposta de outra empresa ou caixa.');return value;}
 async function operation(path:string,init:RequestInit,expected:{id?:string;requestId?:string}={}){
  const value=scope(HistoryImportOperationSchema.parse(await client.request(path,{...init,signal})));
  if((expected.id&&value.id!==expected.id)||(expected.requestId&&value.requestId!==expected.requestId))throw new Error('Resposta de outra operação.');return value;
 }
 return {
  async capability(){return scope(HistoryImportCapabilitySchema.parse(await client.request(`${base}/capability`,{signal})));},
  start(selection:HistoryImportSelection,requestId:string){z.string().uuid().parse(requestId);return operation(base,{method:'POST',headers:{'idempotency-key':requestId},body:JSON.stringify(HistoryImportSelectionSchema.parse(selection))},{requestId});},
  byRequest(requestId:string){z.string().uuid().parse(requestId);return operation(`${base}/by-request/${requestId}`,{}, {requestId});},
  get(id:string,requestId:string){z.string().uuid().parse(id);return operation(`${base}/${id}`,{}, {id,requestId});},
  advance(value:HistoryImportOperation){return operation(`${base}/${value.id}/advance`,{method:'POST',body:'{}'},{id:value.id,requestId:value.requestId});},
  cancel(value:HistoryImportOperation){return operation(`${base}/${value.id}/cancel`,{method:'POST',body:'{}'},{id:value.id,requestId:value.requestId});},
 };
}
