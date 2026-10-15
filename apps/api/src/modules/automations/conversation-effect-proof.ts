import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {OutboxRow} from './repository.js';
import type {ConversationEffectReceipt} from './conversation-effect-protocol.js';
import type {ChatwootObservationScope} from '../integrations/chatwoot-attendance-store.js';
import type {ChatwootAttendanceEvent} from '../integrations/chatwoot-attendance-events.js';

export function remoteInteger(value:unknown):number{
 const text=typeof value==='number'?String(value):value;
 if(typeof text!=='string'||! /^[1-9][0-9]{0,15}$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('AUTOMATION_REMOTE_ID_INVALID');
 return Number(text);
}
type Step={before_revision:number;after_revision:number;proven:boolean};
export function effectControlChainMatches(initial:number,current:number,steps:Step[]):boolean{
 let at=initial;
 for(const step of steps){if(!step.proven||step.before_revision!==at||step.after_revision!==at+1)return false;at=step.after_revision;}
 return at===current;
}
export async function effectRevisionMatches(tx:TenantTransaction,item:OutboxRow,initial:number,current:number){
 const steps=(await tx.query<Step>(`select s.before_revision,s.after_revision,
  (o.disposition='IGNORED' and (o.event->>'kind'='BROKER_ECHO' or o.effect_outbox_id=s.outbox_id)) as proven
  from automation_effect_control_steps s join chatwoot_attendance_observations o on o.organization_id=s.organization_id and o.id=s.observation_id
  where s.organization_id=$1 and s.outbox_id=$2 and s.before_revision >= $3 order by s.after_revision`,[item.organizationId,item.id,initial])).rows;
 return effectControlChainMatches(initial,current,steps);
}
export async function recordEffectControlStep(tx:TenantTransaction,org:string,outboxId:string,conversationId:string,observationId:string,phase:'PENDING'|'CONFIRMED'){
 const row=(await tx.query<{revision:number}>(`update chatwoot_attendance_controls set revision=revision+1,updated_at=now()
  where organization_id=$1 and conversation_id=$2 returning revision`,[org,conversationId])).rows[0];
 if(row)await tx.query(`insert into automation_effect_control_steps(organization_id,outbox_id,conversation_id,observation_id,phase,before_revision,after_revision)
  values($1,$2,$3,$4,$5,$6,$7)`,[org,outboxId,conversationId,observationId,phase,row.revision-1,row.revision]);
}
/** Metadata locates an admitted operation; it never proves a human Message is ours. */
export async function candidateConversationEffect(tx:TenantTransaction,scope:ChatwootObservationScope,event:ChatwootAttendanceEvent,raw:unknown){
 const attrs=raw&&typeof raw==='object'?(raw as {content_attributes?:Record<string,unknown>}).content_attributes:undefined;
 const note=event.kind==='HUMAN_PRIVATE'&&attrs?.jrc_flow_effect_organization_id===scope.organizationId&&
  typeof attrs.jrc_flow_effect_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attrs.jrc_flow_effect_id);
 const resolve=event.kind==='CONVERSATION_CONTROL'&&event.status==='resolved'&&event.teamId===null&&
  (event.assignee.kind==='NONE'||event.assignee.kind==='BROKER_BOT');
 if(!note&&!resolve)return null;
 const rows=(await tx.query<{outbox_id:string;state:string;confirmed_receipt:ConversationEffectReceipt|null}>(`select outbox_id,state,confirmed_receipt
  from automation_conversation_effects where organization_id=$1 and channel_id=$2 and profile='CENTRAL' and protocol_version=2
  and scope->>'integrationId'=$3 and scope->>'destinationRevision'=$4 and scope->>'accountId'=$5 and scope->>'inboxId'=$6
  and credential_revision=$7 and remote_conversation_id=$8 and operation=$9
  and state in ('DISPATCHED','UNKNOWN','CONFIRMED')
  and ($10::uuid is null or outbox_id=$10) and ($11::bigint is null or sender_id=$11)
  order by created_at desc limit 2`,[scope.organizationId,scope.channelId,scope.integrationId,String(scope.destinationRevision),
   String(scope.accountId),String(scope.inboxId),scope.credentialRevision,event.remoteConversationId,note?'note':'resolve',
   note?attrs!.jrc_flow_effect_id:null,note?event.senderId??null:null])).rows;
 if(rows.length!==1)return null;
 const row=rows[0]!;
 if(row.state==='CONFIRMED'){
  if(note&&row.confirmed_receipt?.message_id===event.remoteMessageId)return {id:row.outbox_id,confirmed:true};
  if(resolve&&(await tx.query(`select 1 from automation_executions e join automation_conversation_effects r
   on r.organization_id=e.organization_id and r.execution_id=e.id where r.organization_id=$1 and r.outbox_id=$2
   and e.status='WAITING' and e.state->'waiting'->>'waitId'=r.outbox_id::text`,[scope.organizationId,row.outbox_id])).rowCount)
   return {id:row.outbox_id,confirmed:false};
  // An uncorrelated resolved status after an old operation is never an echo.
  return null;
 }
 return {id:row.outbox_id,confirmed:false};
}
export async function confirmEffectObservations(tx:TenantTransaction,item:OutboxRow,receipt:ConversationEffectReceipt){
 const observations=(await tx.query<{id:string;event:ChatwootAttendanceEvent}>(`select id,event from chatwoot_attendance_observations
  where organization_id=$1 and effect_outbox_id=$2 and disposition='ECHO_PENDING' order by created_at,id`,[item.organizationId,item.id])).rows;
 for(const observation of observations){
  const e=observation.event;
  const proven=receipt.operation==='note'?e.kind==='HUMAN_PRIVATE'&&e.remoteMessageId===receipt.message_id&&e.senderId===receipt.actor_user_id:
   receipt.operation==='resolve'&&e.kind==='CONVERSATION_CONTROL'&&e.status==='resolved'&&e.teamId===null&&
   (e.assignee.kind==='NONE'||e.assignee.kind==='BROKER_BOT');
  if(!proven)continue;
  await tx.query(`update chatwoot_attendance_observations set disposition='IGNORED',reply_payload=null,applied_at=now()
   where organization_id=$1 and id=$2 and effect_outbox_id=$3`,[item.organizationId,observation.id,item.id]);
  await recordEffectControlStep(tx,item.organizationId,item.id,item.conversationId!,observation.id,'CONFIRMED');
 }
}
