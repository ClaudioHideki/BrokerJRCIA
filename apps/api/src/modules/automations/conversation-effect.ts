import {ConversationEffectConfigSchema,MediaEffectConfigSchema,type ConversationEffectConfig,type MediaEffectConfig} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import type {ExternalEffectDispatcher,OutboxDispatchResult} from './service.js';
import {renderRuntimeText} from './runtime-state.js';
import type {RuntimeJson} from './types.js';
export interface ConversationEffectPreparation{profile:'STANDALONE'|'CENTRAL';[key:string]:unknown}
export interface ConversationEffectPorts{
 prepare(item:OutboxRow,config:ConversationEffectConfig|MediaEffectConfig):Promise<ConversationEffectPreparation>;
 commitLocal(tx:TenantTransaction,item:OutboxRow,config:ConversationEffectConfig,prepared:ConversationEffectPreparation):Promise<void>;
 dispatchCentral(item:OutboxRow,config:ConversationEffectConfig,prepared:ConversationEffectPreparation):Promise<OutboxDispatchResult>;
 enqueueMedia(item:OutboxRow,config:MediaEffectConfig,prepared:ConversationEffectPreparation):Promise<OutboxDispatchResult>;
 rejectBeforeDispatch?(item:OutboxRow,config:ConversationEffectConfig|MediaEffectConfig,code:string):Promise<OutboxDispatchResult>;
}
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const strip=(data:Record<string,unknown>)=>Object.fromEntries(Object.entries(data).filter(([key])=>!['variables','runtimeStateVersion','nodeType','definitionAutomationId','definitionVersion','waitId'].includes(key)));
export function createConversationEffectDispatcher(ports:ConversationEffectPorts):ExternalEffectDispatcher{return {async dispatch(item){
 let phase:'config'|'prepare'|'effect'='config';
 let validated:ConversationEffectConfig|MediaEffectConfig|undefined;
 try{
  const isMedia=String(item.kind)==='SEND_MEDIA',variables=record(item.payload.variables) as Record<string,RuntimeJson>;
  const parsed=isMedia?MediaEffectConfigSchema.parse(strip(item.payload)):ConversationEffectConfigSchema.parse(strip(item.payload));
  if(parsed.channelId!==item.channelId||!item.conversationId||item.payload.nodeType!==(isMedia?'media':(parsed as ConversationEffectConfig).operation))throw Error('AUTOMATION_EFFECT_CONFIG_INVALID');
  const config=isMedia?MediaEffectConfigSchema.parse({...parsed,caption:renderRuntimeText((parsed as MediaEffectConfig).caption,variables)}):(parsed as ConversationEffectConfig).operation==='note'?ConversationEffectConfigSchema.parse({...parsed,text:renderRuntimeText((parsed as Extract<ConversationEffectConfig,{operation:'note'}>).text,variables)}):parsed;
  validated=config;
  phase='prepare';const prepared=await ports.prepare(item,config);phase='effect';
  if(isMedia)return await ports.enqueueMedia(item,config as MediaEffectConfig,prepared);
  if(prepared.profile==='CENTRAL')return await ports.dispatchCentral(item,config as ConversationEffectConfig,prepared);
  return {kind:'SENT',remoteReference:'local-effect:'+item.id,
   ...((config as ConversationEffectConfig).operation==='resolve'?{}:{resumePayload:{waitId:item.id,outcome:'success',output:{operation:(config as ConversationEffectConfig).operation,confirmed:true}}}),
   commit:tx=>ports.commitLocal(tx,item,config as ConversationEffectConfig,prepared)};
 }catch(error){
  const code=error instanceof Error&&/^AUTOMATION_[A-Z_]+$/u.test(error.message)?error.message:'AUTOMATION_EFFECT_PREPARATION_FAILED';
  if(phase==='effect'||code==='AUTOMATION_EFFECT_INTENT_EXISTS')return {kind:'UNKNOWN',error:code};
  if(code==='AUTOMATION_EFFECT_AUTHORITY_LOST')return {kind:'FAILED',error:code};
  if(phase==='prepare'&&!['AUTOMATION_RESOURCE_UNAVAILABLE','AUTOMATION_RESOURCE_CHANGED','AUTOMATION_ATTRIBUTE_VALUE_INVALID','AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE','AUTOMATION_MEDIA_UNAVAILABLE','AUTOMATION_MEDIA_CHANGED'].includes(code))return {kind:'UNKNOWN',error:code};
  if(validated&&ports.rejectBeforeDispatch)return ports.rejectBeforeDispatch(item,validated,code);
  return {kind:'FAILED',error:code};
 }
}};}
