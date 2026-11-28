import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { lockChatwootDestination } from './chatwoot-destination.js';

import type { Pool } from 'pg';
import { proofSchema } from './direct-receipt-contract.js';
import { verifyDirectStores } from './direct-receipt-stores.js';
function requireProof(value:unknown):asserts value {
  if(!value)throw new Error('DIRECT_RECEIPT_NOT_PROVEN');
}

export async function reconcileDirectReplyFromStores(tx:TenantTransaction,raw:Buffer,custody:Buffer,custodyHash:string,rails:Pool,evolution:Pool,scope:{organizationId:string;jobId:string}){
  await verifyDirectStores(raw,custody,custodyHash,rails,evolution);
  return applyDirectReply(tx,raw,scope);
}

async function applyDirectReply(tx:TenantTransaction,raw:Buffer,scope:{organizationId:string;jobId:string}){
  const p=proofSchema.parse(JSON.parse(raw.toString('utf8')));
  const r=p.rails,e=p.evolution,a=p.ack;
  requireProof(p.organizationId===scope.organizationId && p.jobId===scope.jobId && new URL(p.origin).origin===p.origin);
  requireProof(e.accountId===r.accountId && e.inboxId===r.inboxId && e.conversationId===r.conversationId && e.messageId===r.messageId);
  requireProof(p.historicalBinding.instanceId===e.instanceId && e.instanceId===a.instanceId && a.messageRowId===e.rowId &&
    a.key===e.key && a.peer===e.peer && r.sourceId==='WAID:'+e.key && r.bodySha256===e.bodySha256);
  const evidenceSha256=createHash('sha256').update(raw).digest('hex');
  const proofIdentity=createHash('sha256').update(JSON.stringify([p.protocol,p.organizationId,p.integrationId,p.channelId,p.jobId,p.origin,p.destinationRevision,p.credentialRevision,r,p.historicalBinding,e])).digest('hex');
  const receipt={protocol:p.protocol,organizationId:p.organizationId,integrationId:p.integrationId,channelId:p.channelId,jobId:p.jobId,
    origin:p.origin,accountId:r.accountId,inboxId:r.inboxId,conversationId:r.conversationId,messageId:r.messageId,destinationRevision:p.destinationRevision,
    credentialRevision:p.credentialRevision,obligationId:r.obligationId,intentId:r.intentId,instanceId:e.instanceId,generation:p.historicalBinding.generation,
    peer:e.peer,sourceId:r.sourceId,providerMessageId:e.key,state:a.status==='READ'?'READ':'DELIVERED',evidenceSha256};

  await lockChatwootDestination(tx,p.organizationId);
  await lockAttendanceChannel(tx,p.organizationId,p.channelId);
  const binding=await tx.query(`SELECT c.id FROM chatwoot_connections c
    JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    WHERE c.organization_id=$1 AND c.id=$2 AND c.channel_id=$3 AND c.inbox_id=$4 AND a.account_id=$5
      AND a.base_url=$6 AND d.revision=$7 AND a.credential_version=$8 AND d.approval_status='APPROVED'
    FOR UPDATE OF c FOR SHARE OF a,d`,[p.organizationId,p.integrationId,p.channelId,r.inboxId,r.accountId,p.origin,p.destinationRevision,p.credentialRevision]);
  requireProof(binding.rowCount===1);
  const siblings=await tx.query(`SELECT id,status,lease_token,lease_expires_at,message_id,payload,dedupe_key,last_error
    FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2 AND kind='CHATWOOT_REPLY'
      AND payload->>'messageId'=$3 ORDER BY id FOR UPDATE`,[p.organizationId,p.integrationId,String(r.messageId)]);
  requireProof(siblings.rowCount===1);
  const job=siblings.rows[0];
  requireProof(job.id===p.jobId && job.message_id===null && job.lease_token===null && job.lease_expires_at===null);
  if(job.status==='SUCCEEDED'){
    const prior=job.payload.directEvolutionReceipt;
    requireProof(job.payload.directEvolutionProofIdentity===proofIdentity && ['DELIVERED','READ'].includes(prior?.state));
    if(prior.state==='READ' || receipt.state==='DELIVERED')return {result:'UNCHANGED',receipt:prior} as const;
    await tx.query("UPDATE integration_jobs SET payload=jsonb_set(payload,'{directEvolutionReceipt}',$3::jsonb),updated_at=now() WHERE organization_id=$1 AND id=$2",
      [p.organizationId,p.jobId,JSON.stringify(receipt)]);
    return {result:'APPLIED',receipt} as const;
  }
  requireProof((job.status==='PENDING' && job.last_error===null) || (job.status==='FAILED' && job.last_error==='CHATWOOT_DIRECT_SOURCE_REVIEW'));
  const data=job.payload;
  requireProof(job.dedupe_key===['reply',p.destinationRevision,r.accountId,r.inboxId,r.messageId].join(':') &&
    data.destinationRevision===p.destinationRevision && data.messageId===r.messageId && data.conversationId===r.conversationId &&
    (data.outboundIntentId??null)===r.intentId && (!data.attendanceKind||data.attendanceKind==='HUMAN_PUBLIC') && !data.campaignIntentId &&
    !data.attachments && !data.directEvolutionReceipt && data.content?.type==='TEXT' && typeof data.content.text==='string' &&
    createHash('sha256').update(data.content.text).digest('hex')===r.bodySha256);
  const mapped=await tx.query(`SELECT c.id FROM chatwoot_conversations m
    JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
    JOIN messaging_contacts t ON t.organization_id=c.organization_id AND t.id=c.contact_id
    WHERE m.organization_id=$1 AND m.integration_id=$2 AND m.remote_conversation_id=$3 AND c.channel_id=$4
      AND c.recipient_kind='INDIVIDUAL' AND regexp_replace(t.external_id,'^[+]','')=$5 FOR SHARE OF m,c,t`,
    [p.organizationId,p.integrationId,r.conversationId,p.channelId,e.peer.split('@')[0]]);
  requireProof(mapped.rowCount===1);
  if(data.attendanceObservationId || r.intentId){
    requireProof(z.uuid().safeParse(data.attendanceObservationId).success);
    const observation=await tx.query(`SELECT 1 FROM chatwoot_attendance_observations
      WHERE organization_id=$1 AND integration_id=$2 AND id=$3 AND channel_id=$4 AND account_id=$5 AND inbox_id=$6
        AND destination_revision=$7 AND credential_revision=$8 AND remote_conversation_id=$9 AND event_key=$10
        AND disposition='APPLIED' AND conversation_id=$11 AND event->>'kind'='HUMAN_PUBLIC'
        AND event->>'mayForwardReply'='true' AND event->>'senderId' ~ '^[1-9][0-9]*$'
        AND event->>'remoteMessageId'=$12 AND event->>'remoteConversationId'=$13
        AND (event->>'outboundIntentId') IS NOT DISTINCT FROM $14::text FOR SHARE`,
      [p.organizationId,p.integrationId,data.attendanceObservationId,p.channelId,r.accountId,r.inboxId,p.destinationRevision,
       p.credentialRevision,r.conversationId,'message:'+r.messageId,mapped.rows[0].id,String(r.messageId),String(r.conversationId),r.intentId]);
    requireProof(observation.rowCount===1);
  }
  const conflicts=await tx.query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND remote_message_id=$3)
    OR EXISTS(SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND channel_id=$4 AND
      (upstream_message_id=$5 OR idempotency_key ~ $6))
    OR EXISTS(SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND channel_id=$4 AND
      (provider_message_id=$5 OR (conversation_id=$7 AND state IN ('DISPATCHED','UNKNOWN'))))`,
    [p.organizationId,p.integrationId,r.messageId,p.channelId,e.key,
      '^(chatwoot:'+r.messageId+'|chatwoot(-group)?:'+p.integrationId+':[0-9]+:'+r.messageId+')(:[0-9]+)?$',mapped.rows[0].id]);
  requireProof(!conflicts.rowCount);
  const changed=await tx.query(`UPDATE integration_jobs SET status='SUCCEEDED',last_error=NULL,
    payload=payload||jsonb_build_object('directEvolutionReceipt',$3::jsonb,'directEvolutionProofIdentity',$4::text,'directEvolutionFirstEvidenceSha256',$5::text),updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND status IN ('PENDING','FAILED') AND lease_token IS NULL RETURNING id`,
    [p.organizationId,p.jobId,JSON.stringify(receipt),proofIdentity,evidenceSha256]);
  requireProof(changed.rowCount===1);
  return {result:'APPLIED',receipt} as const;
}
