import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { interruptChatwootAttendance } from '../attendance/control-service.js';
import type { MessageContent,MessageState } from './types.js';
import {canAdvanceMessageState,lockMessageStatusKey} from './message-state.js';
import { AttendanceError } from '../attendance/types.js';
import { integrationAudit } from '../integrations/chatwoot-service.js';
import type { AbandonQrOutboundObservationRequest, QrOutboundObservationView, AbandonQrDispatchAttemptRequest, QrDispatchAttemptView } from '@jrc/contracts';
import { isOrganizationActive } from '../tenancy/operational-limits.js';

type Scope = { organizationId: string; channelId: string; conversationId: string };
type Observation = { id: string; channel_id: string; conversation_id: string; provider_message_id: string; content: MessageContent; occurred_at: Date; disposition: string };

/** The caller holds the channel lock. An observation never enters the send outbox. */
export async function recordQrOutboundObservation(tx: TenantTransaction, input: Scope & {
  upstreamMessageId: string; content: MessageContent; occurredAt: Date;
}) {
  const row = (await tx.query<{ id: string }>(`INSERT INTO qr_outbound_observations
    (organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,channel_id,provider_message_id)
    DO UPDATE SET provider_message_id=EXCLUDED.provider_message_id RETURNING id`,
    [input.organizationId,input.channelId,input.conversationId,input.upstreamMessageId,input.content,input.occurredAt])).rows[0]!;
  await settleQrOutboundObservation(tx,input.organizationId,row.id);
}

/** Exact provider ID is the only positive correlation. Sender hints, text and dates are never evidence. */
export async function settleQrOutboundObservation(tx: TenantTransaction, org: string, id: string) {
  const o = (await tx.query<Observation>(`SELECT id,channel_id,conversation_id,provider_message_id,content,occurred_at,disposition
    FROM qr_outbound_observations WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[org,id])).rows[0];
  if (!o || o.disposition !== 'RECONCILE') return;
  await lockMessageStatusKey(tx,org,o.channel_id,o.provider_message_id);
  const canonical = (await tx.query<{id:string;source:string;direction:string;conversation_id:string}>(`SELECT id,source,direction,conversation_id FROM messaging_messages
    WHERE organization_id=$1 AND channel_id=$2 AND upstream_message_id=$3`,[org,o.channel_id,o.provider_message_id])).rows[0];
  if (canonical?.direction === 'OUTGOING' && canonical.conversation_id===o.conversation_id) {
    await tx.query(`UPDATE qr_outbound_observations SET disposition=$3,blocking=false,message_id=$4,reason='QR_PROVIDER_ID_CONFIRMED',revision=revision+1,updated_at=now()
      WHERE organization_id=$1 AND id=$2`,[org,id,canonical.source==='EXTERNAL_OBSERVED'?'EXTERNAL_OBSERVED':'BROKER_ECHO',canonical.id]);
    return;
  }
  const attempts = (await tx.query<{pending:boolean;abandoned:boolean}>(`SELECT
    coalesce(bool_or(state IN ('DISPATCHED','UNKNOWN')),false) AS pending,
    coalesce(bool_or(state='ABANDONED'),false) AS abandoned
    FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2`,[org,o.conversation_id])).rows[0]!;
  if (canonical || attempts.pending || attempts.abandoned) {
    await tx.query(`UPDATE qr_outbound_observations SET blocking=$3,reason=$4,updated_at=now() WHERE organization_id=$1 AND id=$2`,
      [org,id,Boolean(canonical)||attempts.pending,canonical?'QR_PROVIDER_ID_CONFLICT':attempts.pending?'QR_ACK_PENDING':'QR_ABANDONED_ATTEMPT_UNRESOLVED']);
    return;
  }
  // A final ACK must survive even when deletion has closed factual ingress.
  // Uncertain attempts remain blocking above; a closed channel never authorizes
  // a new canonical message, a pause, a retry or an attribution for this old ID.
  const writable=(await tx.query('SELECT organization_id FROM public.resolve_qr_channel($1) WHERE organization_id=$2',[o.channel_id,org])).rowCount;
  if(!writable) {
    await tx.query(`UPDATE qr_outbound_observations SET blocking=false,reason='QR_LIFECYCLE_RECONCILE',revision=revision+1,updated_at=now()
      WHERE organization_id=$1 AND id=$2`,[org,id]);
    return;
  }
  const scope={organizationId:org,channelId:o.channel_id,conversationId:o.conversation_id};
  // Pause executors conservatively. This is an external effect, not a human identity or an assignment.
  await interruptChatwootAttendance(tx,scope,false);
  await tx.query(`UPDATE chatwoot_attendance_controls SET state=CASE WHEN state='HUMAN' THEN state ELSE 'PAUSED' END,
    revision=revision+1,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2`,[org,o.conversation_id]);
  const messageId=randomUUID();
  let state:MessageState='SENT';
  const statuses=(await tx.query<{state:MessageState}>(`SELECT state FROM messaging_status_events WHERE organization_id=$1 AND channel_id=$2
    AND upstream_message_id=$3 ORDER BY occurred_at,id`,[org,o.channel_id,o.provider_message_id])).rows;
  for(const status of statuses)if(canAdvanceMessageState(state,status.state))state=status.state;
  await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at)
    VALUES($1,$2,$3,$4,'OUTGOING','EXTERNAL_OBSERVED',$5,$6,$8,$7)`,[messageId,org,o.channel_id,o.conversation_id,o.provider_message_id,o.content,o.occurred_at,state]);
  await tx.query(`UPDATE qr_outbound_observations SET disposition='EXTERNAL_OBSERVED',blocking=false,message_id=$3,
    reason='QR_EXTERNAL_OBSERVED',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,[org,id,messageId]);
}

export async function beginQrDispatchAttempt(tx: TenantTransaction, input: Scope & { messageId: string; leaseToken: string }) {
  await tx.query(`INSERT INTO qr_dispatch_attempts(organization_id,channel_id,conversation_id,message_id,lease_token,lease_expires_at)
    SELECT $1,$2,$3,$4,$5,o.lease_expires_at FROM messaging_outbox o JOIN messaging_channels c
      ON c.organization_id=o.organization_id AND c.id=$2
    WHERE o.organization_id=$1 AND o.message_id=$4 AND o.lease_token=$5 AND c.provider='BAILEYS'
    ON CONFLICT(organization_id,message_id,lease_token) DO NOTHING`,[input.organizationId,input.channelId,input.conversationId,input.messageId,input.leaseToken]);
}

export async function completeQrDispatchAttempt(tx: TenantTransaction, input: Scope & {
  messageId: string; leaseToken: string; state: 'SENT'|'FAILED'|'UNKNOWN'; providerId: string|null;
}) {
  await tx.query(`UPDATE qr_dispatch_attempts SET state=$4,provider_message_id=$5,revision=revision+1,updated_at=now()
    WHERE organization_id=$1 AND message_id=$2 AND lease_token=$3 AND state='DISPATCHED'`,
    [input.organizationId,input.messageId,input.leaseToken,input.state==='SENT'?'CONFIRMED':input.state==='FAILED'?'REJECTED':'UNKNOWN',input.providerId]);
  const pending=await tx.query<{id:string}>(`SELECT id FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2
    AND disposition='RECONCILE' ORDER BY created_at,id`,[input.organizationId,input.conversationId]);
  for(const o of pending.rows) await settleQrOutboundObservation(tx,input.organizationId,o.id);
}

/** A failed callback/worker crash cannot leave DISPATCHED observations permanently waiting for an ACK. */
export async function recoverQrOutboundObservations(tx: TenantTransaction, org: string, limit=20) {
  if(!(await isOrganizationActive(tx,org)))return;
  const channels=(await tx.query<{channel_id:string}>(`SELECT channel_id FROM (SELECT channel_id FROM (
    SELECT channel_id,updated_at FROM qr_dispatch_attempts WHERE organization_id=$1 AND state='DISPATCHED' AND lease_expires_at<=now()
    UNION ALL SELECT channel_id,updated_at FROM qr_outbound_observations WHERE organization_id=$1 AND disposition='RECONCILE'
    ) pending GROUP BY channel_id ORDER BY min(updated_at),channel_id LIMIT $2) fair ORDER BY channel_id`,[org,limit])).rows;
  for(const {channel_id:channel} of channels) {
    await lockAttendanceChannel(tx,org,channel);
    await tx.query(`WITH expired AS (UPDATE qr_dispatch_attempts SET state='UNKNOWN',revision=revision+1,updated_at=now()
      WHERE organization_id=$1 AND channel_id=$2 AND state='DISPATCHED' AND lease_expires_at<=now() RETURNING message_id)
      UPDATE messaging_messages SET state='UNKNOWN',canonical_error_code='QR_ACK_NOT_PERSISTED',updated_at=now()
      WHERE organization_id=$1 AND id IN (SELECT message_id FROM expired) AND state='SENDING'`,[org,channel]);
    await tx.query(`DELETE FROM messaging_outbox o USING messaging_messages m WHERE o.organization_id=$1 AND m.organization_id=o.organization_id
      AND m.id=o.message_id AND m.channel_id=$2 AND m.state='UNKNOWN'`,[org,channel]);
    const pending=(await tx.query<{id:string}>(`SELECT id FROM qr_outbound_observations WHERE organization_id=$1 AND channel_id=$2
      AND disposition='RECONCILE' ORDER BY updated_at,id LIMIT $3`,[org,channel,limit])).rows;
    for(const o of pending)await settleQrOutboundObservation(tx,org,o.id);
  }
}

export async function listQrOutboundObservations(tx:TenantTransaction,org:string,conversationId:string,id?:string):Promise<{data:QrOutboundObservationView[]}> {
  const conversation=(await tx.query('SELECT id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,conversationId])).rows[0];
  if(!conversation)throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
  const data=(await tx.query<QrOutboundObservationView>(`SELECT o.id,o.revision,o.blocking,o.disposition,o.reason,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'messageId',a.message_id,'state',a.state) ORDER BY a.created_at,a.id)
      FROM qr_dispatch_attempts a WHERE a.organization_id=o.organization_id AND a.conversation_id=o.conversation_id
        AND a.state IN ('DISPATCHED','UNKNOWN','ABANDONED')),'[]'::jsonb) AS attempts
    FROM qr_outbound_observations o WHERE o.organization_id=$1 AND o.conversation_id=$2
      AND o.disposition IN ('RECONCILE','ABANDONED') AND ($3::uuid IS NULL OR o.id=$3)
      ORDER BY (o.disposition='RECONCILE') DESC,o.created_at DESC,o.id LIMIT 100`,[org,conversationId,id??null])).rows;
  return {data};
}

/** Administrative acknowledgement of uncertainty, never confirmation of delivery or permission to replay. */
export async function abandonQrOutboundObservation(tx:TenantTransaction,input:AbandonQrOutboundObservationRequest & {
  organizationId:string;id:string;actorId:string;
}):Promise<QrOutboundObservationView> {
  const key=(await tx.query<{channel_id:string;conversation_id:string}>('SELECT channel_id,conversation_id FROM qr_outbound_observations WHERE organization_id=$1 AND id=$2',[input.organizationId,input.id])).rows[0];
  if(!key)throw new AttendanceError('QR_OBSERVATION_NOT_FOUND',404);
  await lockAttendanceChannel(tx,input.organizationId,key.channel_id);
  const membership=await tx.query(`SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=$2
    AND status='ACTIVE' AND role IN ('OWNER','ADMIN') FOR SHARE`,[input.organizationId,input.actorId]);
  if(!membership.rowCount)throw new AttendanceError('FORBIDDEN',403);
  const observation=(await tx.query<{revision:number;disposition:string}>('SELECT revision,disposition FROM qr_outbound_observations WHERE organization_id=$1 AND id=$2 FOR UPDATE',[input.organizationId,input.id])).rows[0]!;
  if(observation.revision!==input.expectedRevision||observation.disposition!=='RECONCILE')throw new AttendanceError('QR_OBSERVATION_CHANGED',409);
  const uncertain=(await tx.query<{id:string;state:string}>(`SELECT id,state FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2
    AND state IN ('DISPATCHED','UNKNOWN') ORDER BY id FOR UPDATE`,[input.organizationId,key.conversation_id])).rows;
  if(uncertain.some(a=>a.state==='DISPATCHED'))throw new AttendanceError('QR_DISPATCH_STILL_ACTIVE',409);
  if(input.attemptIds.length!==uncertain.length||uncertain.some(a=>!input.attemptIds.includes(a.id)))throw new AttendanceError('QR_ATTEMPTS_CHANGED',409);
  await tx.query(`UPDATE qr_dispatch_attempts SET state='ABANDONED',revision=revision+1,abandoned_by=$3,abandonment_reason=$4,updated_at=now()
    WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND state='UNKNOWN'`,[input.organizationId,input.attemptIds,input.actorId,input.reason]);
  await tx.query(`UPDATE qr_outbound_observations SET disposition='ABANDONED',blocking=false,reason='QR_OBSERVATION_ABANDONED',
    abandoned_by=$3,abandonment_reason=$4,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,[input.organizationId,input.id,input.actorId,input.reason]);
  await integrationAudit(tx,input.organizationId,'QR_OUTBOUND_OBSERVATION_ABANDONED',input.id,input.reason,input.actorId);
  const result=await listQrOutboundObservations(tx,input.organizationId,key.conversation_id,input.id);
  return result.data.find(o=>o.id===input.id)!;
}

export async function listQrDispatchAttempts(tx:TenantTransaction,org:string,conversationId:string,id?:string):Promise<{data:QrDispatchAttemptView[]}> {
  if(!(await tx.query('SELECT id FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[org,conversationId])).rowCount)
    throw new AttendanceError('CONVERSATION_NOT_FOUND',404);
  return {data:(await tx.query<QrDispatchAttemptView>(`SELECT id,message_id AS "messageId",revision,state FROM qr_dispatch_attempts
    WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN','ABANDONED') AND ($3::uuid IS NULL OR id=$3)
    ORDER BY (state='ABANDONED'),created_at DESC,id LIMIT 100`,[org,conversationId,id??null])).rows};
}

/** No echo is required to acknowledge an uncertain attempt; no observation or provider ID is fabricated. */
export async function abandonQrDispatchAttempt(tx:TenantTransaction,input:AbandonQrDispatchAttemptRequest & {
  organizationId:string;id:string;actorId:string;
}):Promise<QrDispatchAttemptView> {
  const key=(await tx.query<{channel_id:string;conversation_id:string;message_id:string}>('SELECT channel_id,conversation_id,message_id FROM qr_dispatch_attempts WHERE organization_id=$1 AND id=$2',[input.organizationId,input.id])).rows[0];
  if(!key)throw new AttendanceError('QR_ATTEMPT_NOT_FOUND',404);
  await lockAttendanceChannel(tx,input.organizationId,key.channel_id);
  if(!(await tx.query(`SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE' AND role IN ('OWNER','ADMIN') FOR SHARE`,[input.organizationId,input.actorId])).rowCount)
    throw new AttendanceError('FORBIDDEN',403);
  const attempt=(await tx.query<{state:string;revision:number}>('SELECT state,revision FROM qr_dispatch_attempts WHERE organization_id=$1 AND id=$2 FOR UPDATE',[input.organizationId,input.id])).rows[0]!;
  if(attempt.state!=='UNKNOWN'||attempt.revision!==input.expectedRevision)throw new AttendanceError('QR_ATTEMPT_CHANGED',409);
  const message=(await tx.query<{state:string;upstream_message_id:string|null}>('SELECT state,upstream_message_id FROM messaging_messages WHERE organization_id=$1 AND id=$2 FOR UPDATE',[input.organizationId,key.message_id])).rows[0];
  if(message?.state!=='UNKNOWN'||message.upstream_message_id!==null||(await tx.query('SELECT 1 FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2',[input.organizationId,key.message_id])).rowCount)
    throw new AttendanceError('QR_ATTEMPT_CHANGED',409);
  await tx.query(`UPDATE qr_dispatch_attempts SET state='ABANDONED',revision=revision+1,abandoned_by=$3,abandonment_reason=$4,updated_at=now()
    WHERE organization_id=$1 AND id=$2`,[input.organizationId,input.id,input.actorId,input.reason]);
  await integrationAudit(tx,input.organizationId,'QR_DISPATCH_ATTEMPT_ABANDONED',input.id,input.reason,input.actorId);
  const observations=(await tx.query<{id:string}>(`SELECT id FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2 AND disposition='RECONCILE' ORDER BY id`,[input.organizationId,key.conversation_id])).rows;
  for(const observation of observations)await settleQrOutboundObservation(tx,input.organizationId,observation.id);
  return (await listQrDispatchAttempts(tx,input.organizationId,key.conversation_id,input.id)).data[0]!;
}
