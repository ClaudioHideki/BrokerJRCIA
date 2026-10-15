import {randomUUID} from 'node:crypto';
import type {ConversationEffectConfig,ActionCatalogPage} from '@jrc/contracts';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import {readChatwootAccount,type AccountRow} from '../integrations/chatwoot-context.js';
import {ChatwootClient,ChatwootError} from '../integrations/chatwoot-client.js';
import {lockAttendanceChannel,resolveAttendanceScope} from '../attendance/repository.js';
import {assertEffectAuthority,assertActionResource,readActionResource,readConversationActionValue,
 sameConversationScope,completeResolvedEffect,type EffectAuthority} from './conversation-effects-repository.js';
import {createPostgresAutomationRepository,type OutboxRow} from './repository.js';
import type {OutboxDispatchResult} from './service.js';
import {ConversationEffectContextSchema,ConversationEffectRequestSchema,conversationEffectRequestHash,
 matchConversationEffectReceipt,type ConversationEffectContext,type ConversationEffectRequest,type ConversationEffectReceipt} from './conversation-effect-protocol.js';
import {remoteInteger,confirmEffectObservations,effectRevisionMatches} from './conversation-effect-proof.js';

type Options={transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;client(account:AccountRow):ChatwootClient};
type Intent={outbox_id:string;scope:NonNullable<EffectAuthority['scope']>;credential_revision:number;state:string;
 remote_reference:string|null;owner_revision:number;control_revision:number;cycle:number|null;automation_id:string;version:number;
 remote_context:ConversationEffectContext;request_body:ConversationEffectRequest;confirmed_receipt:ConversationEffectReceipt|null};
const identity=(item:OutboxRow)=>[item.organizationId,item.id];
const intentOf=async(tx:TenantTransaction,item:OutboxRow)=>(await tx.query<Intent>(
 'select * from automation_conversation_effects where organization_id=$1 and outbox_id=$2 for update',identity(item))).rows[0];
const pinsMatch=(a:ConversationEffectContext,b:ConversationEffectContext)=>
 ['account_id','inbox_id','conversation_id','remote_contact_id','contact_inbox_id','routing_source_hash','actor_user_id']
  .every(key=>a[key as keyof ConversationEffectContext]===b[key as keyof ConversationEffectContext]);

export function createConversationCentralAdapter(options:Options){
 async function context(org:string,channel:string){return options.transact(org,async tx=>{
  await lockAttendanceChannel(tx,org,channel);
  const scope=await resolveAttendanceScope(tx,org,channel),account=await readChatwootAccount(tx,org);
  if(!scope||!account||account.status!=='READY')throw Error('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE');
  return {scope,account};
 });}
 async function assertContext(tx:TenantTransaction,org:string,channel:string,initial:Awaited<ReturnType<typeof context>>){
  const scope=await resolveAttendanceScope(tx,org,channel),account=await readChatwootAccount(tx,org);
  if(!sameConversationScope(scope,initial.scope)||!account||account.credential_version!==initial.account.credential_version||
   account.base_url!==initial.account.base_url||account.status!=='READY')throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 }
 const catalog={async refresh(org:string,channel:string){
  const initial=await context(org,channel),client=options.client(initial.account);
  let extension:Awaited<ReturnType<ChatwootClient['flowEffectCapabilities']>>|undefined;
  try{extension=await client.flowEffectCapabilities(initial.scope.accountId,initial.scope.inboxId);}
  catch(error){if(!(error instanceof ChatwootError)||![404,405].includes(error.httpStatus??0))throw error;}
  const supported={state:'SUPPORTED' as const,reason:null},missing={state:'UNAVAILABLE' as const,reason:'CENTRAL_EXTENSION_REQUIRED'};
  const supports=(op:'tag'|'attribute'|'note'|'resolve')=>extension?.control_revision_supported&&extension.operations.includes(op)?supported:missing;
  const capabilities:ActionCatalogPage['capabilities']={tag:supports('tag'),attribute:supports('attribute'),note:supports('note'),resolve:supports('resolve'),media:supported};
  await options.transact(org,async tx=>{
   await lockAttendanceChannel(tx,org,channel);await assertContext(tx,org,channel,initial);
   const ids:string[]=[];
   for(const resource of extension?.resources??[]){
    const row=(await tx.query<{id:string}>(`insert into automation_action_resources(organization_id,channel_id,source,kind,name,key,revision,definition,remote_id)
     values($1,$2,'CENTRAL',$3,$4,$5,$6,$7::jsonb,$8) on conflict(organization_id,channel_id,source,kind,key)
     do update set name=excluded.name,revision=excluded.revision,definition=excluded.definition,remote_id=excluded.remote_id,status='ACTIVE',updated_at=now()
     returning id`,[org,channel,resource.kind,resource.name,resource.key,resource.revision,JSON.stringify(resource.definition),resource.id])).rows[0]!;
    ids.push(row.id);
   }
   await tx.query("update automation_action_resources set status='REVOKED',updated_at=now() where organization_id=$1 and channel_id=$2 and source='CENTRAL' and not(id=any($3::uuid[]))",[org,channel,ids]);
   await tx.query(`insert into automation_action_catalogs(organization_id,channel_id,scope,credential_revision,capabilities,expires_at)
    values($1,$2,$3::jsonb,$4,$5::jsonb,clock_timestamp()+interval '45 seconds') on conflict(organization_id,channel_id)
    do update set scope=excluded.scope,credential_revision=excluded.credential_revision,capabilities=excluded.capabilities,expires_at=excluded.expires_at`,
    [org,channel,JSON.stringify(initial.scope),initial.account.credential_version,JSON.stringify(capabilities)]);
  });
 }};

 async function saveReceipt(item:OutboxRow,raw:unknown){return options.transact(item.organizationId,async tx=>{
  await lockAttendanceChannel(tx,item.organizationId,item.channelId);
  const intent=await intentOf(tx,item);
  if(!intent||!['DISPATCHED','UNKNOWN','CONFIRMED'].includes(intent.state))throw Error('AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN');
  const matched=matchConversationEffectReceipt(raw,{context:intent.remote_context,request:intent.request_body});
  if(!matched.matched)throw Error('AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN');
  const reference=`effect:${item.id}`;
  await tx.query(`update automation_conversation_effects set state='CONFIRMED',confirmed_receipt=$3::jsonb,remote_reference=$4,updated_at=now()
   where organization_id=$1 and outbox_id=$2 and state in ('DISPATCHED','UNKNOWN','CONFIRMED')`,[...identity(item),JSON.stringify(matched.receipt),reference]);
  await confirmEffectObservations(tx,item,matched.receipt);
  return {...intent,state:'CONFIRMED',confirmed_receipt:matched.receipt,remote_reference:reference};
 });}

 // Recording a remote fact is independent of continuing a still-authorized execution.
 async function continueEffect(tx:TenantTransaction,item:OutboxRow,intent:Intent,remote:ConversationEffectContext|null,lease:boolean){
  if(!remote||!intent.confirmed_receipt||!pinsMatch(remote,intent.remote_context)||
   remote.control_revision!==intent.confirmed_receipt.control_revision_after||remote.assignee_id!==null||remote.team_id!==null||
   remote.assignee_agent_bot_id!==intent.remote_context.assignee_agent_bot_id||
   (intent.request_body.operation==='resolve'?remote.status!=='resolved':!['open','pending'].includes(remote.status)))return;
  let current:EffectAuthority;
  try{
   await confirmEffectObservations(tx,item,intent.confirmed_receipt);
   current=await assertEffectAuthority(tx,item,undefined,lease);
   const account=await readChatwootAccount(tx,item.organizationId);
   if(!sameConversationScope(current.scope,intent.scope)||account?.credential_version!==intent.credential_revision||
    current.ownerRevision!==intent.owner_revision||current.cycle!==intent.cycle||current.automationId!==intent.automation_id||
    current.version!==intent.version||!await effectRevisionMatches(tx,item,intent.control_revision,current.controlRevision))return;
  }catch(error){if(error instanceof Error&&error.message==='AUTOMATION_EFFECT_AUTHORITY_LOST')return;throw error;}
  if(intent.request_body.operation==='resolve'){await completeResolvedEffect(tx,item);return;}
  await createPostgresAutomationRepository().resumeExecution(tx,{org:item.organizationId,id:item.executionId,eventId:randomUUID(),
   eventKey:`io:${item.id}`,effectReceiptId:item.id,payload:{waitId:item.id,outcome:'success',output:{operation:intent.request_body.operation,confirmed:true}}});
 }
 async function freshContext(item:OutboxRow,intent:Intent){
  try{const ctx=await context(item.organizationId,item.channelId);
   if(!sameConversationScope(ctx.scope,intent.scope)||ctx.account.credential_version!==intent.credential_revision)return null;
   return await options.client(ctx.account).flowEffectContext(intent.scope.accountId,intent.scope.inboxId,intent.remote_context.conversation_id);
  }catch{return null;}
 }
 async function confirmedResult(item:OutboxRow,intent:Intent):Promise<OutboxDispatchResult>{
  const remote=await freshContext(item,intent);
  return {kind:'SENT',remoteReference:intent.remote_reference!,commit:async tx=>{
   await lockAttendanceChannel(tx,item.organizationId,item.channelId);
   const saved=await intentOf(tx,item);if(!saved||saved.state!=='CONFIRMED')throw Error('AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN');
   await continueEffect(tx,item,saved,remote,true);
  }};
 }

 async function dispatch(item:OutboxRow,config:ConversationEffectConfig,expected:EffectAuthority):Promise<OutboxDispatchResult>{
  const initial=await context(item.organizationId,item.channelId),scope=initial.scope;
  const client=options.client(initial.account).withRequestTimeout(config.timeoutMs);
  const map=await options.transact(item.organizationId,async tx=>(await tx.query<{id:unknown;contact:unknown}>(
   'select remote_conversation_id as id,contact_id as contact from chatwoot_conversations where organization_id=$1 and integration_id=$2 and conversation_id=$3',
   [item.organizationId,scope.integrationId,item.conversationId])).rows[0]);
  if(!map)throw Error('AUTOMATION_EFFECT_CAPABILITY_UNAVAILABLE');
  const remote=ConversationEffectContextSchema.parse(await client.flowEffectContext(scope.accountId,scope.inboxId,remoteInteger(map.id)));
  if(remote.remote_contact_id!==remoteInteger(map.contact)||remote.assignee_id!==null||remote.team_id!==null||!['open','pending'].includes(remote.status))
   throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
  const intent=await options.transact(item.organizationId,async tx=>{
   const authority=await assertEffectAuthority(tx,item,expected);await assertContext(tx,item.organizationId,item.channelId,initial);
   if(await intentOf(tx,item))throw Error('AUTOMATION_EFFECT_INTENT_EXISTS');
   const currentMap=(await tx.query<{id:unknown;contact:unknown}>(
    'select remote_conversation_id as id,contact_id as contact from chatwoot_conversations where organization_id=$1 and integration_id=$2 and conversation_id=$3',
    [item.organizationId,scope.integrationId,item.conversationId])).rows[0];
   if(!currentMap||remoteInteger(currentMap.id)!==remote.conversation_id||remoteInteger(currentMap.contact)!==remote.remote_contact_id)
    throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
   let resourceId:number|undefined,resourceRevision:string|undefined,value:unknown=null;
   if(config.operation==='tag'||config.operation==='attribute'){
    const resource=assertActionResource(item.organizationId,item.channelId,config,await readActionResource(tx,item.organizationId,config.resourceId,true));
    if(resource.source!=='CENTRAL'||resource.remoteId===null)throw Error('AUTOMATION_RESOURCE_UNAVAILABLE');
    resourceId=resource.remoteId;resourceRevision=resource.revision;
    if(config.operation==='attribute')value=readConversationActionValue(config,item.payload.variables as Record<string,unknown>,resource);
   }else value=config.operation==='note'?config.text:'RESOLVED';
   const request=ConversationEffectRequestSchema.parse({organization_id:item.organizationId,operation_id:item.id,dispatch_proof:randomUUID(),
    inbox_id:String(scope.inboxId),remote_contact_id:String(remote.remote_contact_id),expected_control_revision:String(remote.control_revision),
    operation:config.operation,value_json:JSON.stringify(value),...(resourceId===undefined?{}:{resource_id:String(resourceId),resource_revision:resourceRevision})});
   return (await tx.query<Intent>(`insert into automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,
    automation_id,version,operation,profile,state,owner_revision,control_revision,cycle,resource_id,resource_revision,request_hash,scope,credential_revision,
    sender_id,remote_conversation_id,dispatch_proof,protocol_version,remote_context,request_body)
    values($1,$2,$3,$4,$5,$6,$7,$8,'CENTRAL','DISPATCHED',$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,2,$20::jsonb,$21::jsonb) returning *`,
    [item.organizationId,item.id,item.channelId,item.conversationId,item.executionId,authority.automationId,authority.version,config.operation,
     authority.ownerRevision,authority.controlRevision,authority.cycle,'resourceId' in config?config.resourceId:null,resourceRevision??null,
     conversationEffectRequestHash({accountId:scope.accountId,remoteConversationId:remote.conversation_id},request),JSON.stringify(scope),
     initial.account.credential_version,remote.actor_user_id,remote.conversation_id,request.dispatch_proof,JSON.stringify(remote),JSON.stringify(request)])).rows[0]!;
  });
  try{return await confirmedResult(item,await saveReceipt(item,await client.applyFlowEffect(scope.accountId,remote.conversation_id,intent.request_body)));}
  catch(error){
   const rejected=error instanceof ChatwootError&&!error.uncertain&&error.httpStatus!==undefined&&error.httpStatus>=400&&error.httpStatus<500;
   await options.transact(item.organizationId,tx=>tx.query(`update automation_conversation_effects set state=$3,updated_at=now()
    where organization_id=$1 and outbox_id=$2 and state='DISPATCHED'`,[...identity(item),rejected?'REJECTED':'UNKNOWN']));
   if(rejected)return {kind:'FAILED',error:'AUTOMATION_EFFECT_REJECTED',commit:async tx=>{
    try{await assertEffectAuthority(tx,item,expected);}catch{return;}
    await createPostgresAutomationRepository().resumeExecution(tx,{org:item.organizationId,id:item.executionId,eventId:randomUUID(),
     eventKey:`io:${item.id}`,effectReceiptId:item.id,payload:{waitId:item.id,outcome:'error',output:{error:'AUTOMATION_EFFECT_REJECTED'}}});
   }};
   return {kind:'UNKNOWN',error:error instanceof ChatwootError?error.code:'AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN'};
  }
 }
 async function reconcileOnce(org:string){
  const items=await options.transact(org,async tx=>(await tx.query<OutboxRow&{intent:Intent}>(`select o.id,o.organization_id as "organizationId",
   o.execution_id as "executionId",e.channel_id as "channelId",e.conversation_id as "conversationId",o.node_id as "nodeId",o.ordinal,o.kind,
   o.payload,o.attempts,o.lease_token as "leaseToken",to_jsonb(r) as intent from automation_conversation_effects r
   join automation_outbox o on o.organization_id=r.organization_id and o.id=r.outbox_id
   join automation_executions e on e.organization_id=o.organization_id and e.id=o.execution_id
   where o.organization_id=$1 and (o.status='UNKNOWN' or o.status='SENT' and e.status='WAITING') and r.protocol_version=2 and r.profile='CENTRAL' and r.operation<>'media'
   and r.state in ('DISPATCHED','UNKNOWN','CONFIRMED') and (o.lease_expires_at is null or o.lease_expires_at<clock_timestamp())
   order by r.created_at limit 10`,[org])).rows);
  for(const item of items)try{
   let intent=item.intent;
   if(intent.state!=='CONFIRMED'){
    const ctx=await context(org,item.channelId);
    if(!sameConversationScope(ctx.scope,intent.scope)||ctx.account.credential_version!==intent.credential_revision)continue;
    const raw=await options.client(ctx.account).flowEffectReceipt(intent.scope.accountId,intent.remote_context.conversation_id,
     {organizationId:org,operationId:item.id,dispatchProof:intent.request_body.dispatch_proof});
    intent=await saveReceipt(item,raw);
   }
   const remote=await freshContext(item,intent);
   await options.transact(org,async tx=>{
    await lockAttendanceChannel(tx,org,item.channelId);
    const saved=await intentOf(tx,item);if(!saved||saved.state!=='CONFIRMED')return;
    await continueEffect(tx,item,saved,remote,false);
    await tx.query(`update automation_outbox set status='SENT',remote_reference=$3,lease_token=null,lease_expires_at=null,last_error=null,updated_at=now()
     where organization_id=$1 and id=$2 and status='UNKNOWN' and (lease_expires_at is null or lease_expires_at<clock_timestamp())`,[org,item.id,saved.remote_reference]);
   });
  }catch{/* Authenticated GET reconciliation only. Never repeat the mutation. */}
  return items.length;
 }
 return {catalog,dispatch,reconcileOnce};
}
