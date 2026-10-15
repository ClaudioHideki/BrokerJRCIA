import {validateConversationAttribute,type ConversationEffectConfig,type MediaEffectConfig,type ConversationAttributeDefinition} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import {lockAttendanceChannel,resolveAttendanceScope} from '../attendance/repository.js';
import {runtimeAuthorityAllows} from '../attendance/runtime-authority.js';
import {readChatwootAttendanceGate} from '../attendance/control-service.js';
import {remoteInteger} from './conversation-effect-proof.js';
export interface ActionResourceRow{id:string;organizationId:string;channelId:string;source:'LOCAL'|'CENTRAL';kind:'LABEL'|'ATTRIBUTE';name:string;key:string;revision:string;status:string;definition:ConversationAttributeDefinition|null;remoteId:number|null}
export interface MediaAssetRow{id:string;organizationId:string;rootAutomationId:string;channelId:string;mediaId:string;revision:number;status:string;name:string;kind:'image'|'audio'|'video'|'document';mimeType:string;byteSize:number;sha256:string}
export interface EffectAuthority{automationId:string;version:number;definitionAutomationId:string;definitionVersion:number;ownerRevision:number;controlRevision:number;cycle:number|null;profile:'STANDALONE'|'CENTRAL';channelTransport:string;scope:Awaited<ReturnType<typeof resolveAttendanceScope>>}
export const sameConversationScope=(a:unknown,b:unknown)=>JSON.stringify(Object.entries((a??{}) as Record<string,unknown>).sort(([x],[y])=>x.localeCompare(y)))===JSON.stringify(Object.entries((b??{}) as Record<string,unknown>).sort(([x],[y])=>x.localeCompare(y)));
export function assertActionResource(org:string,channel:string,config:Extract<ConversationEffectConfig,{operation:'tag'|'attribute'}>,row:ActionResourceRow|null):ActionResourceRow{
 if(!row||row.organizationId!==org||row.channelId!==channel||row.id!==config.resourceId||row.status!=='ACTIVE'||row.kind!==(config.operation==='tag'?'LABEL':'ATTRIBUTE'))throw Error('AUTOMATION_RESOURCE_UNAVAILABLE');
 if(row.revision!==config.resourceRevision)throw Error('AUTOMATION_RESOURCE_CHANGED');return row;
}
export function readConversationActionValue(config:Extract<ConversationEffectConfig,{operation:'attribute'}>,variables:Record<string,unknown>,row:ActionResourceRow):string|number|boolean{
 if(!row.definition)throw Error('AUTOMATION_RESOURCE_UNAVAILABLE');const value=config.valueSource.kind==='LITERAL'?config.valueSource.value:variables[config.valueSource.variable];return validateConversationAttribute(row.definition,value);
}
export function assertMediaAsset(org:string,root:string,channel:string,config:MediaEffectConfig,row:MediaAssetRow|null):MediaAssetRow{
 if(!row||row.organizationId!==org||row.rootAutomationId!==root||row.channelId!==channel||row.id!==config.mediaId||row.status!=='READY')throw Error('AUTOMATION_MEDIA_UNAVAILABLE');if(row.revision!==config.mediaRevision)throw Error('AUTOMATION_MEDIA_CHANGED');return row;
}
const resourceColumns=`id,organization_id as "organizationId",channel_id as "channelId",source,kind,name,key,revision,status,definition,remote_id as "remoteId"`;
export async function readActionResource(tx:TenantTransaction,org:string,id:string,lock=false):Promise<ActionResourceRow|null>{
 const row=(await tx.query<Omit<ActionResourceRow,'remoteId'>&{remoteId:unknown}>(`select ${resourceColumns}
  from automation_action_resources where organization_id=$1 and id=$2 ${lock?'for share':''}`,[org,id])).rows[0];
 return row?{...row,remoteId:row.remoteId===null?null:remoteInteger(row.remoteId)}:null;
}

export const readMediaAsset=async(tx:TenantTransaction,org:string,id:string,lock=false)=>(await tx.query<MediaAssetRow>(`select a.id,a.organization_id as "organizationId",a.root_automation_id as "rootAutomationId",a.channel_id as "channelId",a.media_id as "mediaId",a.revision,case when a.status='REVOKED' then 'REVOKED' when m.status='READY' then 'READY' else 'STORING' end as status,a.name,a.kind,m.mime_type as "mimeType",m.byte_size as "byteSize",m.sha256 from automation_media_assets a join messaging_media m on m.organization_id=a.organization_id and m.channel_id=a.channel_id and m.id=a.media_id where a.organization_id=$1 and a.id=$2 ${lock?'for share of a,m':''}`,[org,id])).rows[0]??null;
export async function assertEffectAuthority(tx:TenantTransaction,item:OutboxRow,expected?:EffectAuthority,requireLease=true):Promise<EffectAuthority>{
 await lockAttendanceChannel(tx,item.organizationId,item.channelId);
 const e=(await tx.query<{automationId:string;version:number;state:Record<string,unknown>;status:string;bindingStatus:string;ownerRevision:number;channelTransport:string}>(`select e.automation_id as "automationId",e.version,e.state,e.status,b.status as "bindingStatus",o.revision as "ownerRevision",c.transport as "channelTransport" from automation_executions e join automation_bindings b on b.organization_id=e.organization_id and b.id=e.binding_id join attendance_owners o on o.organization_id=e.organization_id and o.channel_id=e.channel_id join messaging_channels c on c.organization_id=e.organization_id and c.id=e.channel_id where e.organization_id=$1 and e.id=$2 and e.channel_id=$3 and e.conversation_id=$4 for no key update of e`,[item.organizationId,item.executionId,item.channelId,item.conversationId])).rows[0];
 const owned=(await tx.query(`select id from automation_outbox where organization_id=$1 and id=$2
  and ${requireLease?"status='UNKNOWN' and lease_token=$3 and lease_expires_at>clock_timestamp()":"status in ('UNKNOWN','SENT')"} for update`,requireLease?[item.organizationId,item.id,item.leaseToken]:[item.organizationId,item.id])).rows[0];
 if(!e||!owned||e.status!=='WAITING'||e.bindingStatus!=='ACTIVE'||!await runtimeAuthorityAllows(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId,automationId:e.automationId,version:e.version,executionId:item.executionId},false))throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const waiting=e.state.waiting as {kind?:string;nodeId?:string;waitId?:string}|undefined;
 if(waiting?.kind!=='IO'||waiting.nodeId!==item.nodeId||waiting.waitId!==item.id||item.payload.waitId!==item.id||e.state.automationId!==item.payload.definitionAutomationId||e.state.version!==item.payload.definitionVersion)throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const scope=await resolveAttendanceScope(tx,item.organizationId,item.channelId),gate=await readChatwootAttendanceGate(tx,{organizationId:item.organizationId,channelId:item.channelId,conversationId:item.conversationId!,effectOutboxId:item.id});
 if(!gate.allowed)throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const authority:EffectAuthority={automationId:e.automationId,version:e.version,definitionAutomationId:String(e.state.automationId),definitionVersion:Number(e.state.version),ownerRevision:e.ownerRevision,controlRevision:gate.revision,cycle:gate.cycle,profile:scope?'CENTRAL':'STANDALONE',channelTransport:e.channelTransport,scope};
 if(expected&&(authority.automationId!==expected.automationId||authority.version!==expected.version||authority.definitionAutomationId!==expected.definitionAutomationId||authority.definitionVersion!==expected.definitionVersion||authority.ownerRevision!==expected.ownerRevision||authority.controlRevision!==expected.controlRevision||authority.cycle!==expected.cycle||!sameConversationScope(authority.scope,expected.scope)))throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 return authority;
}
export async function commitLocalConversationEffect(tx:TenantTransaction,item:OutboxRow,config:ConversationEffectConfig,expected:EffectAuthority){
 const current=await assertEffectAuthority(tx,item,expected);if(current.profile!=='STANDALONE')throw Error('AUTOMATION_EFFECT_AUTHORITY_LOST');
 const previous=(await tx.query(`select id from automation_conversation_effects where organization_id=$1 and outbox_id=$2`,[item.organizationId,item.id])).rows[0];if(previous)throw Error('AUTOMATION_EFFECT_INTENT_EXISTS');
 let resource:ActionResourceRow|undefined,value:unknown;
 if(config.operation==='tag'||config.operation==='attribute'){resource=assertActionResource(item.organizationId,item.channelId,config,await readActionResource(tx,item.organizationId,config.resourceId,true));if(resource.source!=='LOCAL')throw Error('AUTOMATION_RESOURCE_UNAVAILABLE');if(config.operation==='attribute')value=readConversationActionValue(config,item.payload.variables as Record<string,unknown>,resource);}
 await tx.query(`insert into automation_conversation_state(organization_id,channel_id,conversation_id) values($1,$2,$3) on conflict do nothing`,[item.organizationId,item.channelId,item.conversationId]);
 await tx.query(`select conversation_id from automation_conversation_state where organization_id=$1 and channel_id=$2 and conversation_id=$3 for update`,[item.organizationId,item.channelId,item.conversationId]);
 if(config.operation==='tag')await tx.query(`update automation_conversation_state set labels=case when labels @> jsonb_build_array($4::text) then labels else labels||jsonb_build_array($4::text) end,revision=revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and conversation_id=$3`,[item.organizationId,item.channelId,item.conversationId,resource!.id]);
 if(config.operation==='attribute')await tx.query(`update automation_conversation_state set attributes=attributes||jsonb_build_object($4::text,$5::jsonb),revision=revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and conversation_id=$3`,[item.organizationId,item.channelId,item.conversationId,resource!.key,JSON.stringify(value)]);
 if(config.operation==='note')await tx.query(`insert into automation_private_notes(organization_id,channel_id,conversation_id,id,body,origin_outbox_id) values($1,$2,$3,$4,$5,$4)`,[item.organizationId,item.channelId,item.conversationId,item.id,config.text]);
 if(config.operation==='resolve')await tx.query(`update automation_conversation_state set status='RESOLVED',revision=revision+1,updated_at=now() where organization_id=$1 and channel_id=$2 and conversation_id=$3`,[item.organizationId,item.channelId,item.conversationId]);
 await tx.query(`insert into automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,automation_id,version,operation,profile,state,owner_revision,control_revision,cycle,resource_id,resource_revision,protocol_version) values($1,$2,$3,$4,$5,$6,$7,$8,'STANDALONE','CONFIRMED',$9,$10,$11,$12,$13,2)`,[item.organizationId,item.id,item.channelId,item.conversationId,item.executionId,current.automationId,current.version,config.operation,current.ownerRevision,current.controlRevision,current.cycle,resource?.id??null,resource?.revision??null]);
 if(config.operation==='resolve')await completeResolvedEffect(tx,item);
}

/** Only after a confirmed effect and the caller's current authority check. */
export async function completeResolvedEffect(tx:TenantTransaction,item:OutboxRow){
 const confirmed=(await tx.query(`select 1 from automation_conversation_effects where organization_id=$1 and outbox_id=$2
  and execution_id=$3 and operation='resolve' and state='CONFIRMED' and protocol_version=2`,[item.organizationId,item.id,item.executionId])).rowCount;
 if(!confirmed)throw Error('AUTOMATION_EFFECT_RECEIPT_NOT_PROVEN');
 await tx.query(`update attendance_sessions set state='RESOLVED',revision=revision+1,updated_at=now()
  where organization_id=$1 and conversation_id=$2 and state in ('BOT_ACTIVE','WAITING_INPUT')`,[item.organizationId,item.conversationId]);
 await tx.query(`update automation_waits set status='RESUMED',resumed_at=now(),resume_event_key=$4
  where organization_id=$1 and execution_id=$2 and id=$3 and status='WAITING'`,[item.organizationId,item.executionId,item.id,`io:${item.id}`]);
 await tx.query(`update automation_executions set status='COMPLETED',current_node_id=null,
  state=(state-'waiting')||'{"nodeId":null,"stack":[]}'::jsonb,completed_at=now(),updated_at=now()
  where organization_id=$1 and id=$2 and status='WAITING'`,[item.organizationId,item.executionId]);
}
