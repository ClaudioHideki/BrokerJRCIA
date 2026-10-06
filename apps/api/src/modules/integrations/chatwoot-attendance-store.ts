import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { AttendanceScope } from '@jrc/contracts';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { interruptChatwootAttendance } from '../attendance/control-service.js';
import { isExpectedHandoffOpening } from '../attendance/handoff-expected-control.js';
import { isExpectedResumeControl } from '../attendance/resume-expected-control.js';
import { IntegrationError } from './integration-error.js';
import { classifyChatwootAttendanceEvent, type ChatwootAttendanceEvent } from './chatwoot-attendance-events.js';
import { parseChatwootReply } from './chatwoot-events.js';

export type ChatwootObservationScope=AttendanceScope & {credentialRevision:number};
type Disposition='WAITING_MAP'|'ECHO_PENDING'|'APPLIED'|'IGNORED'|'RECONCILE';
type Observation={id:string;event:ChatwootAttendanceEvent;disposition:Disposition;reply_payload:Record<string,unknown>|null;conversation_id:string|null;cycle:number|null};
type Control={conversation_id:string;remote_conversation_id:string|null;cycle:number;revision:number;state:string;observed_remote_updated_at:number|null};
const record=(raw:unknown):Record<string,unknown>=>raw!==null&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
const scopeValues=(s:ChatwootObservationScope)=>[s.organizationId,s.integrationId,s.destinationRevision,s.accountId,s.inboxId];

async function lockScope(tx:TenantTransaction,s:ChatwootObservationScope) {
  await lockAttendanceChannel(tx,s.organizationId,s.channelId);
  const current=(await tx.query<{channel_id:string;revision:number;account_id:string;inbox_id:string;credential_version:number}>(`
    SELECT c.channel_id,d.revision,a.account_id,c.inbox_id,a.credential_version FROM chatwoot_connections c
    JOIN chatwoot_accounts a ON a.organization_id=c.organization_id JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    WHERE c.organization_id=$1 AND c.id=$2 FOR SHARE OF c,a,d`,[s.organizationId,s.integrationId])).rows[0];
  if(!current || current.channel_id!==s.channelId || current.revision!==s.destinationRevision || Number(current.account_id)!==s.accountId ||
    Number(current.inbox_id)!==s.inboxId || current.credential_version!==s.credentialRevision)throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
}
async function controlForRemote(tx:TenantTransaction,s:ChatwootObservationScope,remoteId:number):Promise<Control|undefined> {
  return (await tx.query<Control>(`SELECT conversation_id,remote_conversation_id,cycle,revision,state,observed_remote_updated_at FROM chatwoot_attendance_controls
    WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5 AND remote_conversation_id=$6`,[...scopeValues(s),remoteId])).rows[0];
}
export async function mayForwardChatwootAttendanceReply(tx:TenantTransaction,s:ChatwootObservationScope,event:ChatwootAttendanceEvent) {
  if(!event.mayForwardReply)return false;
  if(event.kind==='EXTERNAL_BOT'||event.kind==='AUTOMATED_REPLY'){
    const owner=(await tx.query<{executor:string;remote_binding_id:string|null;bot_id:string|null}>(`SELECT o.executor,o.remote_binding_id,b.bot_id
      FROM attendance_owners o LEFT JOIN flow_chatwoot_bindings b ON b.organization_id=o.organization_id AND b.id=o.remote_binding_id
      WHERE o.organization_id=$1 AND o.channel_id=$2`,[s.organizationId,s.channelId])).rows[0];
    // Transport is allowed only for the selected external executor or the exact legacy Broker bot.
    return owner?.executor==='EXTERNAL'||owner?.executor==='BROKER'&&owner.remote_binding_id!==null&&
      event.kind==='EXTERNAL_BOT'&&Number(owner.bot_id)===event.senderId;
  }
  return event.kind==='HUMAN_PUBLIC';
}
async function queueReply(tx:TenantTransaction,s:ChatwootObservationScope,observation:Observation) {
  if(!observation.reply_payload || !observation.event.mayForwardReply)return;
  if(!await mayForwardChatwootAttendanceReply(tx,s,observation.event)){
    await tx.query('UPDATE chatwoot_attendance_observations SET reply_payload=null WHERE organization_id=$1 AND id=$2',[s.organizationId,observation.id]);return;
  }
  await tx.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,payload)
    VALUES($1,$2,'CHATWOOT_REPLY',$3,$4::jsonb) ON CONFLICT(organization_id,integration_id,dedupe_key) DO NOTHING`,
    [s.organizationId,s.integrationId,`reply:${s.destinationRevision}:${s.accountId}:${s.inboxId}:${observation.event.remoteMessageId}`,JSON.stringify({...observation.reply_payload,
      attendanceObservationId:observation.id,attendanceKind:observation.event.kind,destinationRevision:s.destinationRevision})]);
  await tx.query('UPDATE chatwoot_attendance_observations SET reply_payload=null WHERE organization_id=$1 AND id=$2',[s.organizationId,observation.id]);
}
async function applyObservation(tx:TenantTransaction,s:ChatwootObservationScope,observation:Observation,control:Control) {
  const e=observation.event;
  const selectedExecutor=(e.kind==='EXTERNAL_BOT'||e.kind==='AUTOMATED_REPLY')&&await mayForwardChatwootAttendanceReply(tx,s,e);
  const expectedOpening=await isExpectedHandoffOpening(tx,s,e,control)||await isExpectedResumeControl(tx,s,e,control);
  const hasControl=!selectedExecutor&&!expectedOpening&&(e.interruptsBot || (e.kind==='CONVERSATION_CONTROL'&&e.teamId!==null));
  // Timestamp order may suppress stale observations but never authorizes a transition back to BOT.
  const stale=e.kind==='CONVERSATION_CONTROL'&&e.remoteUpdatedAt!==null&&control.observed_remote_updated_at!==null&&e.remoteUpdatedAt<control.observed_remote_updated_at;
  if(hasControl&&!stale){
    const human=e.kind==='HUMAN_PUBLIC'||e.kind==='HUMAN_PRIVATE'||(e.kind==='CONVERSATION_CONTROL'&&e.assignee.kind==='HUMAN');
    await interruptChatwootAttendance(tx,{organizationId:s.organizationId,channelId:s.channelId,conversationId:control.conversation_id},human);
    await tx.query(`UPDATE chatwoot_attendance_controls SET state=CASE WHEN state='HUMAN' OR $3 THEN 'HUMAN' ELSE 'PAUSED' END,
      revision=revision+1,last_observation_id=$4,observed_remote_updated_at=coalesce($5,observed_remote_updated_at),updated_at=now()
      WHERE organization_id=$1 AND conversation_id=$2`,[s.organizationId,control.conversation_id,human,observation.id,e.kind==='CONVERSATION_CONTROL'?e.remoteUpdatedAt:null]);
  }
  await tx.query(`UPDATE chatwoot_attendance_observations SET conversation_id=$3,cycle=$4,disposition=$5,applied_at=now()
    WHERE organization_id=$1 AND id=$2`,[s.organizationId,observation.id,control.conversation_id,control.cycle,hasControl&&!stale||selectedExecutor?'APPLIED':'IGNORED']);
  await queueReply(tx,s,observation);
}

/** Authenticated callback admission: no network and no dependency on transport queue progress. */
export async function recordChatwootAttendanceEvent(tx:TenantTransaction,s:ChatwootObservationScope,raw:unknown) {
  await lockScope(tx,s);
  let event=classifyChatwootAttendanceEvent(raw,s);
  if(!event)return {observationId:null,duplicate:false,disposition:'IGNORED' as const};
  // A central-origin message is already transported. Keep human control but
  // never enqueue the public reply back to that same inbox.
  const transport=(await tx.query<{transport:string}>('SELECT transport FROM messaging_channels WHERE organization_id=$1 AND id=$2',[s.organizationId,s.channelId])).rows[0]?.transport;
  if(transport==='CENTRAL_TRANSPORT')event={...event,mayForwardReply:false};
  const original=record(raw);
  const key=event.kind==='CONVERSATION_CONTROL'?`control:${event.remoteConversationId}:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`:`message:${event.remoteMessageId}`;
  const prior=(await tx.query<Observation>(`SELECT id,event,disposition,reply_payload,conversation_id,cycle FROM chatwoot_attendance_observations
    WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5 AND event_key=$6`,[...scopeValues(s),key])).rows[0];
  if(prior)return {observationId:prior.id,duplicate:true,disposition:prior.disposition};
  let candidate:string|null=null;
  if(event.kind!=='CONVERSATION_CONTROL'&&event.kind!=='CONTACT_MESSAGE'&&event.kind!=='SYSTEM_MESSAGE'){
    const echo=(await tx.query<{remote_message_id:string}>(`SELECT remote_message_id FROM chatwoot_mirror_attempts
      WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5
        AND remote_conversation_id=$6 AND remote_message_id=$7 AND state='CONFIRMED'`,[...scopeValues(s),event.remoteConversationId,event.remoteMessageId])).rows[0];
    if(echo)event=classifyChatwootAttendanceEvent(raw,s,{...s,remoteConversationId:event.remoteConversationId,remoteMessageId:event.remoteMessageId})!;
    else {
      const marker=z.string().uuid().safeParse(record(original.content_attributes).jrc_broker_message_id);
      if(marker.success)candidate=(await tx.query<{id:string}>(`SELECT a.id FROM chatwoot_mirror_attempts a JOIN messaging_messages m ON m.organization_id=a.organization_id AND m.id=a.message_id
        WHERE a.organization_id=$1 AND a.integration_id=$2 AND a.destination_revision=$3 AND a.account_id=$4 AND a.inbox_id=$5
          AND a.remote_conversation_id=$6 AND a.message_id=$7 AND a.state IN ('DISPATCHED','UNKNOWN') AND m.direction='OUTGOING'
        ORDER BY a.created_at DESC LIMIT 1`,[...scopeValues(s),event.remoteConversationId,marker.data])).rows[0]?.id??null;
    }
  }
  let reply:Record<string,unknown>|null=null;
  if(event.mayForwardReply){
    const attributes={...record(original.content_attributes)}; delete attributes.jrc_broker_message_id;
    try { reply=parseChatwootReply({...original,content_attributes:attributes},{accountId:s.accountId,inboxId:s.inboxId}); }
    catch { /* Unsupported content does not erase authenticated attendance control. */ }
  }
  let control=await controlForRemote(tx,s,event.remoteConversationId);
  if(!control){
    const map=(await tx.query<{conversation_id:string}>('SELECT conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3',
      [s.organizationId,s.integrationId,event.remoteConversationId])).rows[0];
    if(map){await createControl(tx,s,map.conversation_id,event.remoteConversationId);control=await controlForRemote(tx,s,event.remoteConversationId);}
  }
  const disposition:Disposition=candidate?'ECHO_PENDING':event.kind==='BROKER_ECHO'||!event.interruptsBot&&event.kind!=='CONVERSATION_CONTROL'?'IGNORED':control?'APPLIED':'WAITING_MAP';
  const observation=(await tx.query<Observation>(`INSERT INTO chatwoot_attendance_observations(organization_id,id,integration_id,channel_id,destination_revision,credential_revision,
    account_id,inbox_id,remote_conversation_id,event_key,event,disposition,mirror_attempt_id,reply_payload,conversation_id,cycle)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,event,disposition,reply_payload,conversation_id,cycle`,
    [s.organizationId,randomUUID(),s.integrationId,s.channelId,s.destinationRevision,s.credentialRevision,s.accountId,s.inboxId,event.remoteConversationId,key,
      JSON.stringify(event),disposition,candidate,reply?JSON.stringify(reply):null,control?.conversation_id??null,control?.cycle??null])).rows[0]!;
  if(candidate){
    if(control)await tx.query('UPDATE chatwoot_attendance_controls SET revision=revision+1,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2',[s.organizationId,control.conversation_id]);
  } else if(control&&disposition!=='IGNORED')await applyObservation(tx,s,observation,control);
  else if(disposition==='WAITING_MAP')await queueReply(tx,s,observation);
  return {observationId:observation.id,duplicate:false,disposition};
}

async function createControl(tx:TenantTransaction,s:ChatwootObservationScope,conversationId:string,remoteConversationId:number|null) {
  const conversation=(await tx.query<{mode:string}>('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND channel_id=$2 AND id=$3',[s.organizationId,s.channelId,conversationId])).rows[0];
  if(!conversation)throw new IntegrationError('CHATWOOT_CONVERSATION_NOT_BOUND',409);
  await tx.query(`INSERT INTO chatwoot_attendance_controls(organization_id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,remote_conversation_id,cycle,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce((SELECT max(cycle) FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$3),1),$9)
    ON CONFLICT(organization_id,conversation_id) DO NOTHING`,[s.organizationId,s.channelId,conversationId,s.integrationId,s.destinationRevision,s.accountId,s.inboxId,remoteConversationId,conversation.mode==='HUMAN'?'HUMAN':'INITIALIZING']);
}

/** Called after canonical GET, before releasing any bot output for the mapped conversation. */
export async function initializeChatwootAttendanceMap(tx:TenantTransaction,s:ChatwootObservationScope,input:{conversationId:string;remoteConversationId:number;canonical:unknown}) {
  await lockScope(tx,s);
  const raw=record(input.canonical);
  if(raw.id!==input.remoteConversationId||raw.account_id!==s.accountId||raw.inbox_id!==s.inboxId)throw new IntegrationError('CHATWOOT_BINDING_MISMATCH',409);
  const canonical=classifyChatwootAttendanceEvent({...raw,account:{id:s.accountId},event:'conversation_updated'},s);
  if(!canonical||canonical.kind!=='CONVERSATION_CONTROL')throw new IntegrationError('CHATWOOT_CONTROL_INVALID',409);
  await createControl(tx,s,input.conversationId,input.remoteConversationId);
  const current=(await tx.query<Control&{integration_id:string;destination_revision:number}>(`SELECT conversation_id,remote_conversation_id,cycle,revision,state,observed_remote_updated_at,integration_id,destination_revision
    FROM chatwoot_attendance_controls WHERE organization_id=$1 AND conversation_id=$2`,[s.organizationId,input.conversationId])).rows[0]!;
  if(current.integration_id!==s.integrationId||current.destination_revision!==s.destinationRevision||current.remote_conversation_id!==null&&Number(current.remote_conversation_id)!==input.remoteConversationId)
    throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
  await tx.query(`UPDATE chatwoot_attendance_controls SET remote_conversation_id=$3,observed_remote_updated_at=$4,
    state=CASE WHEN state='INITIALIZING' THEN 'READY' ELSE state END,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2`,
    [s.organizationId,input.conversationId,input.remoteConversationId,canonical.remoteUpdatedAt]);
  const pending=(await tx.query<Observation>(`SELECT id,event,disposition,reply_payload,conversation_id,cycle FROM chatwoot_attendance_observations
    WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5 AND remote_conversation_id=$6 AND disposition='WAITING_MAP'
    ORDER BY created_at,id`,[...scopeValues(s),input.remoteConversationId])).rows;
  for(const observation of pending)await applyObservation(tx,s,observation,{...current,observed_remote_updated_at:null});
  if(canonical.interruptsBot||canonical.teamId!==null){
    const human=canonical.assignee.kind==='HUMAN';
    await interruptChatwootAttendance(tx,{organizationId:s.organizationId,channelId:s.channelId,conversationId:input.conversationId},human);
    await tx.query(`UPDATE chatwoot_attendance_controls SET state=CASE WHEN state='HUMAN' OR $3 THEN 'HUMAN' ELSE 'PAUSED' END,revision=revision+1,updated_at=now()
      WHERE organization_id=$1 AND conversation_id=$2`,[s.organizationId,input.conversationId,human]);
  }
}

export async function beginChatwootMirrorAttempt(tx:TenantTransaction,s:ChatwootObservationScope,input:{jobId:string;leaseToken:string;messageId:string;conversationId:string;remoteConversationId:number}) {
  await lockScope(tx,s);
  const job=(await tx.query(`SELECT id FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND integration_id=$3 AND message_id=$4
    AND kind='MIRROR_MESSAGE' AND status='RUNNING' AND lease_token=$5 AND lease_expires_at>now() FOR UPDATE`,[s.organizationId,input.jobId,s.integrationId,input.messageId,input.leaseToken])).rowCount;
  if(!job)throw new IntegrationError('INTEGRATION_LEASE_LOST',409);
  const message=(await tx.query('SELECT id FROM messaging_messages WHERE organization_id=$1 AND id=$2 AND channel_id=$3 AND conversation_id=$4',[s.organizationId,input.messageId,s.channelId,input.conversationId])).rowCount;
  if(!message)throw new IntegrationError('INTEGRATION_MESSAGE_NOT_FOUND',404);
  return (await tx.query<{id:string}>(`INSERT INTO chatwoot_mirror_attempts(organization_id,integration_id,channel_id,destination_revision,account_id,inbox_id,conversation_id,remote_conversation_id,
    cycle,message_id,job_id,lease_token,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce((SELECT max(cycle) FROM attendance_sessions WHERE organization_id=$1 AND conversation_id=$7),1),$9,$10,$11,'DISPATCHED')
    ON CONFLICT(organization_id,job_id,lease_token) DO UPDATE SET updated_at=chatwoot_mirror_attempts.updated_at RETURNING id`,
    [s.organizationId,s.integrationId,s.channelId,s.destinationRevision,s.accountId,s.inboxId,input.conversationId,input.remoteConversationId,input.messageId,input.jobId,input.leaseToken])).rows[0]!;
}

export async function confirmChatwootMirrorAttempt(tx:TenantTransaction,s:ChatwootObservationScope,input:{attemptId:string;remoteMessageId:number}) {
  await lockScope(tx,s);
  const attempt=(await tx.query<{id:string;remote_conversation_id:string;remote_message_id:string|null}>(`SELECT id,remote_conversation_id,remote_message_id FROM chatwoot_mirror_attempts
    WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5 AND id=$6 FOR UPDATE`,[...scopeValues(s),input.attemptId])).rows[0];
  if(!attempt||attempt.remote_message_id!==null&&Number(attempt.remote_message_id)!==input.remoteMessageId)throw new IntegrationError('CHATWOOT_MIRROR_EVIDENCE_CONFLICT',409);
  await tx.query("UPDATE chatwoot_mirror_attempts SET state='CONFIRMED',remote_message_id=$3,updated_at=now() WHERE organization_id=$1 AND id=$2",[s.organizationId,attempt.id,input.remoteMessageId]);
  const pending=(await tx.query<Observation>(`SELECT id,event,disposition,reply_payload,conversation_id,cycle FROM chatwoot_attendance_observations
    WHERE organization_id=$1 AND mirror_attempt_id=$2 AND disposition='ECHO_PENDING' ORDER BY created_at,id`,[s.organizationId,attempt.id])).rows;
  const control=await controlForRemote(tx,s,Number(attempt.remote_conversation_id));
  for(const observation of pending){
    if(observation.event.kind!=='CONVERSATION_CONTROL'&&observation.event.remoteMessageId===input.remoteMessageId){
      await tx.query(`UPDATE chatwoot_attendance_observations SET disposition='IGNORED',reply_payload=null,event=event||'{"kind":"BROKER_ECHO","interruptsBot":false,"mayForwardReply":false}'::jsonb,applied_at=now()
        WHERE organization_id=$1 AND id=$2`,[s.organizationId,observation.id]);
    } else if(control)await applyObservation(tx,s,observation,control);
    else await tx.query("UPDATE chatwoot_attendance_observations SET disposition='WAITING_MAP',mirror_attempt_id=null WHERE organization_id=$1 AND id=$2",[s.organizationId,observation.id]);
  }
  if(pending.length&&control)await tx.query('UPDATE chatwoot_attendance_controls SET revision=revision+1,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2',[s.organizationId,control.conversation_id]);
}

/** A timeout is uncertainty, never proof that the remote POST did not happen. */
export async function failChatwootMirrorAttempt(tx:TenantTransaction,s:ChatwootObservationScope,input:{attemptId:string;uncertain:boolean}) {
  await lockScope(tx,s);
  const attempt=(await tx.query<{remote_conversation_id:string}>(`UPDATE chatwoot_mirror_attempts SET state=$7,updated_at=now()
    WHERE organization_id=$1 AND integration_id=$2 AND destination_revision=$3 AND account_id=$4 AND inbox_id=$5 AND id=$6
      AND state='DISPATCHED' RETURNING remote_conversation_id`,[...scopeValues(s),input.attemptId,input.uncertain?'UNKNOWN':'REJECTED'])).rows[0];
  if(!attempt||input.uncertain)return;
  const pending=(await tx.query<Observation>(`SELECT id,event,disposition,reply_payload,conversation_id,cycle FROM chatwoot_attendance_observations
    WHERE organization_id=$1 AND mirror_attempt_id=$2 AND disposition='ECHO_PENDING' ORDER BY created_at,id`,[s.organizationId,input.attemptId])).rows;
  const control=await controlForRemote(tx,s,Number(attempt.remote_conversation_id));
  for(const observation of pending){
    if(control)await applyObservation(tx,s,observation,control);
    else {await tx.query("UPDATE chatwoot_attendance_observations SET disposition='WAITING_MAP',mirror_attempt_id=null WHERE organization_id=$1 AND id=$2",[s.organizationId,observation.id]);await queueReply(tx,s,observation);}
  }
}
