import {AiNodeConfigSchema,aiStructuredResponse,estimateAiCost,validateAiOutput,type AiNodeConfig,type AiModelPolicy} from '@jrc/contracts';
import {AutomationHttpError,validateAutomationTarget,type AutomationHttpRequest,type AutomationHttpResponse} from '../automation-integrations/safe-http.js';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import type {ExternalEffectDispatcher} from './service.js';
import {renderAutomationIoPayload} from './io-payload.js';
export type AiSettlement={kind:'OBSERVED';costMicros:number;inputTokens:number;outputTokens:number}|{kind:'NOT_DISPATCHED'};
export interface AiEffectOptions{
 begin(item:OutboxRow,config:AiNodeConfig):Promise<{secret:Record<string,unknown>;model:AiModelPolicy;reservedMicros:number}>;
 commit(tx:TenantTransaction,item:OutboxRow,result:AiSettlement):Promise<void>;
 request(input:AutomationHttpRequest):Promise<AutomationHttpResponse>;
 audit(item:OutboxRow,detail:{outcome:string;durationMs:number;model:string;usage?:{inputTokens:number;outputTokens:number;costMicros:number}}):Promise<void>;
}
const text=(value:unknown)=>typeof value==='string'?value:'';
const strip=(payload:Record<string,unknown>)=>Object.fromEntries(Object.entries(payload).filter(([key])=>!['nodeType','runtimeStateVersion','variables'].includes(key)));
const instructions={generate:'Gere somente o texto solicitado. Não utilize ferramentas.',summarize:'Resuma o conteúdo fornecido. Retorne somente o resumo. Não utilize ferramentas.',classify:'Classifique o conteúdo em exatamente uma das categorias permitidas. Retorne apenas o objeto solicitado.',extract:'Extraia somente os campos tipados solicitados. Retorne apenas o objeto solicitado.'};
export function createAutomationAiEffectDispatcher(options:AiEffectOptions):ExternalEffectDispatcher{return {async dispatch(item){
 let phase:'prepare'|'begin'|'request'|'response'|'audit'='prepare',reserved=false;const started=Date.now();
 try{
  const original=AiNodeConfigSchema.parse(strip(item.payload));if(item.kind!=='IO_AI'||item.payload.nodeType!=='ai-'+original.operation)throw Error('AUTOMATION_AI_CONFIG_INVALID');
  // Only content is interpolated. Credential/model/category/schema remain fixed publication policy.
  const rendered=renderAutomationIoPayload({...item.payload,content:original.content});
  const config=AiNodeConfigSchema.parse({...original,content:rendered.content});
  phase='begin';const preparation=await options.begin(item,config);reserved=true;
  const target=validateAutomationTarget(text(preparation.secret.baseUrl)),key=text(preparation.secret.apiKey);if(!key.trim())throw Error('AUTOMATION_AI_CREDENTIAL_INVALID');
  const schema=aiStructuredResponse(config),body={model:config.model,messages:[{role:'system',content:instructions[config.operation]},{role:'user',content:config.content}],max_tokens:config.maxOutputTokens,stream:false,...(schema?{response_format:{type:'json_schema',json_schema:{name:'bounded_'+config.operation,strict:true,schema}}}:{})};
  phase='request';const response=await options.request({method:'POST',url:new URL('/v1/chat/completions',target).href,allowedOrigins:[target.origin],headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),timeoutMs:config.timeoutMs,maxResponseBytes:config.maxResponseBytes,redirectLimit:0,retryAttempts:0});
  phase='response';if(response.outcome!=='success'||response.status<200||response.status>=300||Buffer.byteLength(response.body)>config.maxResponseBytes)throw Error('AUTOMATION_AI_RESPONSE_INVALID');
  const data=JSON.parse(response.body) as {model?:unknown;choices?:Array<{finish_reason?:unknown;message?:{content?:unknown;tool_calls?:unknown;refusal?:unknown}}> ;usage?:{prompt_tokens?:unknown;completion_tokens?:unknown}};
  const choice=data.choices?.[0],message=choice?.message;if(data.model!==config.model||data.choices?.length!==1||!message||(message.tool_calls!==undefined&&message.tool_calls!==null)||message.refusal||choice?.finish_reason==='length'||typeof message.content!=='string')throw Error('AUTOMATION_AI_RESPONSE_INVALID');
  const inputTokens=data.usage?.prompt_tokens,outputTokens=data.usage?.completion_tokens;
  if(typeof inputTokens!=='number'||typeof outputTokens!=='number'||!Number.isSafeInteger(inputTokens)||!Number.isSafeInteger(outputTokens)||inputTokens<0||outputTokens<0||inputTokens>Buffer.byteLength(config.content)+8192||outputTokens>config.maxOutputTokens)throw Error('AUTOMATION_AI_USAGE_INVALID');
  const costMicros=estimateAiCost(preparation.model,{inputTokens,outputTokens});if(costMicros>preparation.reservedMicros||costMicros>config.maxCostMicros)throw Error('AUTOMATION_AI_COST_LIMIT');
  let output:unknown=message.content;if(config.operation==='extract')output=JSON.parse(message.content);if(config.operation==='classify'){const parsed=JSON.parse(message.content) as Record<string,unknown>;if(!parsed||Object.keys(parsed).length!==1)throw Error('AUTOMATION_AI_OUTPUT_INVALID');output=parsed.category;}
  output=validateAiOutput(config,output);const usage={inputTokens,outputTokens,costMicros};phase='audit';await options.audit(item,{outcome:'SUCCESS',durationMs:Date.now()-started,model:config.model,usage});
  return {kind:'SENT',remoteReference:'io:'+item.id,resumePayload:{outcome:'success',output,usage},commit:tx=>options.commit(tx,item,{kind:'OBSERVED',...usage})};
 }catch(error){
  if(error instanceof Error&&error.message==='AUTOMATION_AI_RESERVATION_EXISTS')return {kind:'UNKNOWN',error:'AUTOMATION_AI_RESERVATION_EXISTS'};
  if(phase==='begin'&&!reserved&&(!(error instanceof Error)||!['AUTOMATION_AI_CREDENTIAL_UNAVAILABLE','AUTOMATION_AI_CREDENTIAL_CHANGED','AUTOMATION_AI_POLICY_REQUIRED','AUTOMATION_AI_MODEL_NOT_APPROVED','AUTOMATION_AI_COST_LIMIT','AUTOMATION_AI_MONTHLY_BUDGET_EXCEEDED','CREDENTIAL_REVOKED'].includes(error.message)))return {kind:'UNKNOWN',error:'AUTOMATION_AI_RESERVATION_PERSISTENCE_UNKNOWN'};
  const uncertain=phase==='response'||phase==='audit'||phase==='request'&&(!(error instanceof AutomationHttpError)||error.dispatched);
  const code=error instanceof AutomationHttpError?error.code:phase==='prepare'?'AUTOMATION_AI_CONFIG_INVALID':phase==='begin'?'AUTOMATION_AI_POLICY_OR_BUDGET_REJECTED':phase==='audit'?'AUTOMATION_AI_AUDIT_FAILED':'AUTOMATION_AI_RESPONSE_INVALID';
  if(uncertain)return {kind:'UNKNOWN',error:code};
  const outcome=error instanceof AutomationHttpError&&error.code==='AUTOMATION_HTTP_TIMEOUT'?'timeout':'error';
  return {kind:'FAILED',error:code,resumePayload:{outcome,output:{error:code}},...(reserved?{commit:(tx:TenantTransaction)=>options.commit(tx,item,{kind:'NOT_DISPATCHED'})}:{})};
 }
}};}
