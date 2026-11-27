import { createHash, randomUUID } from "node:crypto";
import {createChatwootGroupWorker} from './chatwoot-group-worker.js';
import { z } from "zod";
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import { createPostgresMessagingRepository } from "../messaging/repository.js";
import { isOrganizationActive } from "../tenancy/operational-limits.js";
import { ChatwootError } from "./chatwoot-client.js";
import {createJobFailureDiagnostic} from './job-failure-diagnostics.js';
import {reviewedMessageHashSql,verifyReviewedContact} from './review-pending-mirror.js';
import { requireApprovedDestination } from './chatwoot-context.js';
import {
  chatwootEnvironment,
  IntegrationError,
  readChatwootAccount,
  readChatwootConnection,
  createChatwootService,
  type ChatwootOptions,
} from "./chatwoot-service.js";
import { MediaError, type BinaryMedia } from "@jrc/providers";
import { registerPendingMedia } from "../messaging/media-store.js";
import type { MessageContent } from "../messaging/types.js";
import { MessagingRepositoryError } from "../messaging/repository.js";
import { lockAttendanceChannel } from '../attendance/repository.js';
import { beginChatwootMirrorAttempt,confirmChatwootMirrorAttempt,failChatwootMirrorAttempt,initializeChatwootAttendanceMap,mayForwardChatwootAttendanceReply,
  type ChatwootObservationScope } from './chatwoot-attendance-store.js';
import type { ChatwootAttendanceEvent } from './chatwoot-attendance-events.js';
import {mayStartIndependentHumanCycle,preparePhysicalConversationCycle} from './chatwoot-conversation-cycle.js';
import {canonicalCampaignRecipient,requireCampaignIntent,verifyCanonicalCampaignMessage} from './chatwoot-campaign-authority.js';
import {requireCanonicalHumanIntent} from './chatwoot-human-intent.js';
import {lockChatwootDestination} from './chatwoot-destination.js';
import {assertChatwootMirrorContext} from './chatwoot-mirror-context.js';
import {LIVE_INGRESS_PROTOCOL,liveIngressLookup,liveIngressProofSchema,type LiveIngressProof} from './chatwoot-live-ingress.js';
import {selectLiveMirrorProtocol,dispatchNativeLiveMirror,assertRejectedNativeRetry} from './chatwoot-live-dispatch.js';

interface Job {
  id: string;
  organization_id: string;
  integration_id: string;
  kind: "CHATWOOT_REPLY" | "MIRROR_MESSAGE";
  message_id: string | null;
  attempts: number;
  lease_token: string;
  payload: Record<string, unknown>;
}
interface ConversationMap {
  contact_id: string;
  source_id: string;
  remote_conversation_id: string;
}
const replySchema = z
  .object({
    attendanceObservationId:z.string().uuid().optional(),
    campaignIntentId:z.uuid().optional(),
    outboundIntentId:z.uuid().optional(),
    newCycleAdmission:z.literal(1).optional(),
    attendanceKind:z.enum(['HUMAN_PUBLIC','EXTERNAL_BOT','AUTOMATED_REPLY','NATIVE_CSAT']).optional(),
    destinationRevision:z.number().int().positive().optional(),
    messageId: z.number().int().positive(),
    conversationId: z.number().int().positive(),
    content: z
      .object({ type: z.literal("TEXT"), text: z.string().min(1).max(4096) })
      .optional(),
    caption: z.string().max(4096).optional(),
    attachments: z
      .array(
        z.object({
          id: z.number().int().positive(),
          kind: z.enum(["image", "audio", "video", "document"]),
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .refine((x) => Boolean(x.content) !== Boolean(x.attachments));

export function createChatwootWorker(options: ChatwootOptions) {
  const env = chatwootEnvironment(options),
    repo = createPostgresMessagingRepository(),
    tx = options.transact;
  // An uncertain mirror must fence its contact, including later physical cycles,
  // without stopping inbound mirrors for unrelated contacts. Only a separately
  // authenticated campaign or canonical durable human intent with an exact
  // current map can pass a proven unrelated mirror. An incoming mirror in that
  // exact human-controlled conversation can remain uncertain while a separately
  // proven human intent is dispatched once; the mirror itself is never retried.
  // Legacy replies and ambiguous context stay stopped; the uncertain operation
  // itself is never replayed.
  // Both claim queries use the same predicate so a blocked connection cannot
  // starve another connection that has eligible work.
  const independentCampaignReply = `j.kind='CHATWOOT_REPLY' AND j.payload->>'attendanceKind'='AUTOMATED_REPLY' AND EXISTS(
    SELECT 1 FROM chatwoot_campaign_intents intent
    JOIN chatwoot_conversations campaign_map ON campaign_map.organization_id=intent.organization_id
      AND campaign_map.integration_id=intent.integration_id AND campaign_map.remote_conversation_id=intent.remote_conversation_id
      AND campaign_map.contact_id=intent.remote_contact_id AND campaign_map.source_id=intent.recipient_source_id
    JOIN messaging_conversations campaign_conversation ON campaign_conversation.organization_id=campaign_map.organization_id
      AND campaign_conversation.id=campaign_map.conversation_id AND campaign_conversation.channel_id=intent.channel_id
      AND campaign_conversation.remote_conversation_key IS NULL
    JOIN messaging_contacts recipient ON recipient.organization_id=campaign_conversation.organization_id
      AND recipient.id=campaign_conversation.contact_id AND recipient.external_id=substring(intent.recipient_phone from 2)
    JOIN chatwoot_attendance_observations observation ON observation.organization_id=intent.organization_id
      AND observation.integration_id=intent.integration_id AND observation.channel_id=intent.channel_id
      AND observation.account_id=intent.account_id AND observation.inbox_id=intent.inbox_id
      AND observation.destination_revision=intent.destination_revision AND observation.credential_revision=intent.credential_version
      AND observation.remote_conversation_id=intent.remote_conversation_id AND observation.id::text=j.payload->>'attendanceObservationId'
      AND observation.disposition IN ('APPLIED','WAITING_MAP') AND observation.event->>'kind'='AUTOMATED_REPLY'
      AND observation.event->>'campaignIntentId'=intent.id::text AND observation.event->>'senderId'=intent.actor_id
      AND observation.event->>'remoteMessageId'=intent.remote_message_id::text
      AND observation.event->>'remoteConversationId'=intent.remote_conversation_id::text
    WHERE intent.organization_id=j.organization_id AND intent.integration_id=j.integration_id AND intent.channel_id=c.channel_id
      AND intent.inbox_id=c.inbox_id AND intent.id::text=j.payload->>'campaignIntentId'
      AND intent.remote_message_id::text=j.payload->>'messageId' AND intent.remote_conversation_id::text=j.payload->>'conversationId'
      AND intent.destination_revision::text=j.payload->>'destinationRevision'
      AND (intent.local_conversation_id IS NULL OR intent.local_conversation_id=campaign_conversation.id)
      AND campaign_intent_authorized(intent.organization_id,intent.id,false)
      AND NOT EXISTS(SELECT 1 FROM integration_jobs blocked
        LEFT JOIN messaging_messages blocked_message ON blocked_message.organization_id=blocked.organization_id
          AND blocked_message.id=blocked.message_id AND blocked_message.channel_id=c.channel_id
        LEFT JOIN messaging_conversations blocked_conversation ON blocked_conversation.organization_id=blocked_message.organization_id
          AND blocked_conversation.id=blocked_message.conversation_id AND blocked_conversation.channel_id=blocked_message.channel_id
        WHERE blocked.organization_id=j.organization_id AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN'
          AND (blocked.kind<>'MIRROR_MESSAGE' OR blocked.payload->>'operation' IS DISTINCT FROM 'SEND_MESSAGE'
            OR blocked_conversation.contact_id IS NULL OR blocked_conversation.contact_id=campaign_conversation.contact_id
            OR NOT EXISTS(SELECT 1 FROM chatwoot_conversations blocked_map
              WHERE blocked_map.organization_id=blocked.organization_id AND blocked_map.integration_id=blocked.integration_id
                AND blocked_map.conversation_id=blocked_conversation.id
                AND blocked_map.remote_conversation_id::text=blocked.payload->>'conversationId'))))`;
  // Only the new durable human-intent protocol can isolate an uncertain mirror.
  // Legacy replies have no such proof and retain the integration-wide fence.
  const independentHumanReply = `j.kind='CHATWOOT_REPLY' AND j.payload->>'attendanceKind'='HUMAN_PUBLIC' AND EXISTS(
    SELECT 1 FROM chatwoot_conversations human_map
    JOIN messaging_conversations human_conversation ON human_conversation.organization_id=human_map.organization_id
      AND human_conversation.id=human_map.conversation_id AND human_conversation.channel_id=c.channel_id
      AND human_conversation.remote_conversation_key IS NULL AND human_conversation.recipient_kind='INDIVIDUAL'
    JOIN chatwoot_accounts human_account ON human_account.organization_id=human_map.organization_id AND human_account.status='READY'
    JOIN chatwoot_destinations human_destination ON human_destination.organization_id=human_account.organization_id
      AND human_destination.base_url=human_account.base_url AND human_destination.approval_status='APPROVED'
    JOIN chatwoot_attendance_observations human_observation ON human_observation.organization_id=human_map.organization_id
      AND human_observation.integration_id=human_map.integration_id AND human_observation.channel_id=c.channel_id
      AND human_observation.conversation_id=human_conversation.id AND human_observation.remote_conversation_id=human_map.remote_conversation_id
      AND human_observation.account_id=human_account.account_id AND human_observation.inbox_id=c.inbox_id
      AND human_observation.destination_revision=human_destination.revision AND human_observation.credential_revision=human_account.credential_version
      AND human_observation.id::text=j.payload->>'attendanceObservationId' AND human_observation.disposition='APPLIED'
      AND human_observation.event->>'kind'='HUMAN_PUBLIC' AND human_observation.event->>'mayForwardReply'='true'
      AND human_observation.event->>'outboundIntentId'=j.payload->>'outboundIntentId'
      AND human_observation.event->>'remoteMessageId'=j.payload->>'messageId'
      AND human_observation.event->>'remoteConversationId'=j.payload->>'conversationId'
    WHERE human_map.organization_id=j.organization_id AND human_map.integration_id=j.integration_id
      AND human_map.remote_conversation_id::text=j.payload->>'conversationId'
      AND human_destination.revision::text=j.payload->>'destinationRevision'
      AND j.payload->>'outboundIntentId' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM integration_jobs blocked
        LEFT JOIN messaging_messages blocked_message ON blocked_message.organization_id=blocked.organization_id
          AND blocked_message.id=blocked.message_id AND blocked_message.channel_id=c.channel_id
        LEFT JOIN messaging_conversations blocked_conversation ON blocked_conversation.organization_id=blocked_message.organization_id
          AND blocked_conversation.id=blocked_message.conversation_id AND blocked_conversation.channel_id=blocked_message.channel_id
        WHERE blocked.organization_id=j.organization_id AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN'
          AND (blocked.kind<>'MIRROR_MESSAGE' OR blocked.payload->>'operation' IS DISTINCT FROM 'SEND_MESSAGE'
            OR blocked_conversation.contact_id IS NULL
            OR (blocked_conversation.contact_id=human_conversation.contact_id AND NOT EXISTS(
              SELECT 1 FROM chatwoot_mirror_attempts incoming_attempt
              JOIN chatwoot_attendance_controls human_control ON human_control.organization_id=incoming_attempt.organization_id
                AND human_control.channel_id=incoming_attempt.channel_id AND human_control.integration_id=incoming_attempt.integration_id
                AND human_control.destination_revision=incoming_attempt.destination_revision
                AND human_control.account_id=incoming_attempt.account_id AND human_control.inbox_id=incoming_attempt.inbox_id
                AND human_control.conversation_id=incoming_attempt.conversation_id
                AND human_control.remote_conversation_id=incoming_attempt.remote_conversation_id
                AND human_control.cycle=incoming_attempt.cycle AND human_control.state='HUMAN'
              WHERE incoming_attempt.organization_id=blocked.organization_id AND incoming_attempt.job_id=blocked.id
                AND incoming_attempt.integration_id=j.integration_id AND incoming_attempt.channel_id=c.channel_id
                AND incoming_attempt.destination_revision=human_destination.revision
                AND incoming_attempt.account_id=human_account.account_id AND incoming_attempt.inbox_id=c.inbox_id
                AND incoming_attempt.message_id=blocked.message_id AND incoming_attempt.state='UNKNOWN'
                AND incoming_attempt.remote_message_id IS NULL AND incoming_attempt.cycle=human_observation.cycle
                AND incoming_attempt.conversation_id=human_conversation.id
                AND incoming_attempt.remote_conversation_id=human_map.remote_conversation_id
                AND incoming_attempt.remote_conversation_id::text=blocked.payload->>'conversationId'
                AND blocked_conversation.id=human_conversation.id
                AND blocked_message.direction='INCOMING' AND blocked_message.source='CONTACT'))
            OR NOT EXISTS(SELECT 1 FROM chatwoot_conversations blocked_map
              WHERE blocked_map.organization_id=blocked.organization_id AND blocked_map.integration_id=blocked.integration_id
                AND blocked_map.conversation_id=blocked_conversation.id
                AND blocked_map.remote_conversation_id::text=blocked.payload->>'conversationId'))))`;
  // Returning a provider receipt to the exact central message is an idempotent
  // PATCH, not another message POST. Require the successful durable human reply
  // and its current map so an uncertain inbound copy cannot hide delivery state.
  const provenHumanStatus = `j.kind='MIRROR_MESSAGE' AND
    (j.payload->>'operation' IS NULL OR j.payload->>'operation'='UPDATE_STATUS') AND EXISTS(
      SELECT 1 FROM messaging_messages status_message
      JOIN chatwoot_messages status_map ON status_map.organization_id=status_message.organization_id
        AND status_map.message_id=status_message.id AND status_map.integration_id=j.integration_id
      JOIN chatwoot_conversations status_conversation ON status_conversation.organization_id=status_message.organization_id
        AND status_conversation.conversation_id=status_message.conversation_id AND status_conversation.integration_id=j.integration_id
      JOIN integration_jobs human_reply ON human_reply.organization_id=j.organization_id AND human_reply.integration_id=j.integration_id
        AND human_reply.kind='CHATWOOT_REPLY' AND human_reply.status='SUCCEEDED'
        AND human_reply.payload->>'attendanceKind'='HUMAN_PUBLIC' AND human_reply.payload->>'outboundIntentId' IS NOT NULL
        AND human_reply.payload->>'messageId'=status_map.remote_message_id::text
        AND human_reply.payload->>'conversationId'=status_conversation.remote_conversation_id::text
      JOIN chatwoot_messages first_status_map ON first_status_map.organization_id=human_reply.organization_id
        AND first_status_map.integration_id=human_reply.integration_id AND first_status_map.message_id=human_reply.message_id
        AND first_status_map.remote_message_id=status_map.remote_message_id
      JOIN messaging_messages first_status_message ON first_status_message.organization_id=human_reply.organization_id
        AND first_status_message.id=human_reply.message_id AND first_status_message.channel_id=c.channel_id
        AND first_status_message.conversation_id=status_message.conversation_id
        AND first_status_message.direction='OUTGOING' AND first_status_message.source='OPERATOR' AND first_status_message.is_historical=false
      JOIN chatwoot_accounts status_account ON status_account.organization_id=j.organization_id AND status_account.status='READY'
      JOIN chatwoot_destinations status_destination ON status_destination.organization_id=status_account.organization_id
        AND status_destination.base_url=status_account.base_url AND status_destination.approval_status='APPROVED'
        AND status_destination.revision::text=human_reply.payload->>'destinationRevision'
      WHERE status_message.organization_id=j.organization_id AND status_message.id=j.message_id
        AND status_message.channel_id=c.channel_id AND status_message.direction='OUTGOING' AND status_message.source='OPERATOR'
        AND status_message.is_historical=false AND (status_message.state='FAILED'
          OR status_message.state IN ('SENT','DELIVERED','READ') AND status_message.upstream_message_id IS NOT NULL))`;
  // This permits canonical reads for a newly admitted human intent. No
  // physical enqueue is possible without proving the contact under lock.
  const waitingHumanCycle = `j.kind='CHATWOOT_REPLY' AND j.payload->>'newCycleAdmission'='1'
    AND j.payload->>'attendanceKind'='HUMAN_PUBLIC' AND EXISTS(
      SELECT 1 FROM chatwoot_attendance_observations o
      JOIN chatwoot_accounts a ON a.organization_id=o.organization_id AND a.status='READY' AND a.account_id=o.account_id
        AND a.credential_version=o.credential_revision
      JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
        AND d.approval_status='APPROVED' AND d.revision=o.destination_revision
      WHERE o.organization_id=j.organization_id AND o.integration_id=j.integration_id AND o.channel_id=c.channel_id
        AND o.inbox_id=c.inbox_id AND o.event_key='message:'||(j.payload->>'messageId')
        AND o.id::text=j.payload->>'attendanceObservationId' AND o.remote_conversation_id::text=j.payload->>'conversationId'
        AND o.destination_revision::text=j.payload->>'destinationRevision' AND o.event->>'newCycleAdmission'='1'
        AND o.event->>'kind'='HUMAN_PUBLIC' AND o.event->>'mayForwardReply'='true'
        AND o.event->>'outboundIntentId'=j.payload->>'outboundIntentId'
        AND o.disposition='WAITING_MAP' AND o.conversation_id IS NULL AND o.cycle IS NULL)`;
  const inboxTarget = "COALESCE(j.payload->'admittedInboxTarget',j.payload->'reviewedInboxTarget')";
  const dueJob = `j.status IN ('PENDING','HISTORY_PENDING') AND j.available_at<=now()
    AND j.payload->>'historySyncVersion' IS DISTINCT FROM '2'
    AND (NOT (j.payload ? 'reviewedStatusLeader') OR EXISTS (
      SELECT 1 FROM integration_jobs leader
      JOIN chatwoot_mirror_attempts receipt ON receipt.organization_id=leader.organization_id
        AND receipt.integration_id=leader.integration_id AND receipt.job_id=leader.id AND receipt.message_id=leader.message_id
      JOIN chatwoot_messages mapped ON mapped.organization_id=receipt.organization_id AND mapped.integration_id=receipt.integration_id
        AND mapped.message_id=receipt.message_id AND mapped.remote_message_id=receipt.remote_message_id
      WHERE leader.organization_id=j.organization_id AND leader.integration_id=j.integration_id AND leader.message_id=j.message_id
        AND leader.dedupe_key IN ('message:'||j.message_id::text||':SENT','message:'||j.message_id::text||':DELIVERED','message:'||j.message_id::text||':READ')
        AND leader.id::text=j.payload->>'reviewedStatusLeader' AND leader.status='SUCCEEDED'
        AND (leader.payload->'reviewedInboxTarget'=j.payload->'reviewedInboxTarget'
          OR (leader.payload->'admittedInboxTarget'=j.payload->'admittedInboxTarget'
            AND leader.payload->'qrObservationId'=j.payload->'qrObservationId'))
        AND leader.payload->>'mirrorProtocol'='jrc-live-ingress/1' AND leader.payload->'liveIngressProof'->>'attempt_id'=receipt.id::text
        AND receipt.state='CONFIRMED' AND receipt.channel_id=c.channel_id))`;
  const noUnknown = `NOT EXISTS(SELECT 1 FROM integration_jobs blocked WHERE blocked.organization_id=j.organization_id
      AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN')`;
  const firstQrObservation = `EXISTS(SELECT 1 FROM qr_outbound_observations observation
    JOIN messaging_messages fact ON fact.organization_id=observation.organization_id AND fact.id=observation.message_id
      AND fact.channel_id=observation.channel_id AND fact.conversation_id=observation.conversation_id
    JOIN messaging_conversations cv ON cv.organization_id=fact.organization_id AND cv.id=fact.conversation_id
    JOIN messaging_contacts ct ON ct.organization_id=cv.organization_id AND ct.id=cv.contact_id
    WHERE observation.organization_id=j.organization_id AND observation.id=CASE
      WHEN j.payload->>'qrObservationId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (j.payload->>'qrObservationId')::uuid END
      AND fact.id=j.message_id AND fact.channel_id=c.channel_id AND fact.provider_scope='' AND observation.provider_scope=''
      AND fact.upstream_message_id=observation.provider_message_id AND fact.direction='OUTGOING' AND fact.source='EXTERNAL_OBSERVED'
      AND fact.state IN ('SENT','DELIVERED','READ') AND NOT fact.is_historical AND cv.recipient_kind='INDIVIDUAL'
      AND observation.disposition='EXTERNAL_OBSERVED' AND NOT observation.blocking AND observation.content=fact.content
      AND chatwoot_channel_identity_ready(j.organization_id,c.channel_id)
      AND encode(sha256(convert_to(observation.provider_message_id,'UTF8')),'hex')=j.payload->'admittedInboxTarget'->>'providerHash'
      AND encode(sha256(convert_to(ct.external_id,'UTF8')),'hex')=j.payload->'admittedInboxTarget'->>'phoneHash')`;
  const independentMirror = `j.kind='MIRROR_MESSAGE' AND EXISTS(
      SELECT 1 FROM messaging_messages candidate_message
      JOIN messaging_conversations candidate_conversation ON candidate_conversation.organization_id=candidate_message.organization_id
        AND candidate_conversation.channel_id=candidate_message.channel_id AND candidate_conversation.id=candidate_message.conversation_id
      WHERE candidate_message.organization_id=j.organization_id AND candidate_message.id=j.message_id AND candidate_message.channel_id=c.channel_id
        AND NOT EXISTS(SELECT 1 FROM integration_jobs blocked
          LEFT JOIN messaging_messages blocked_message ON blocked_message.organization_id=blocked.organization_id
            AND blocked_message.id=blocked.message_id AND blocked_message.channel_id=c.channel_id
          LEFT JOIN messaging_conversations blocked_conversation ON blocked_conversation.organization_id=blocked_message.organization_id
            AND blocked_conversation.channel_id=blocked_message.channel_id AND blocked_conversation.id=blocked_message.conversation_id
          WHERE blocked.organization_id=j.organization_id AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN'
             AND (blocked_conversation.contact_id IS NULL OR blocked_conversation.contact_id=candidate_conversation.contact_id)
             AND NOT EXISTS (
               SELECT 1 FROM chatwoot_mirror_attempts attempt
               JOIN chatwoot_conversations map ON map.organization_id=attempt.organization_id AND map.integration_id=attempt.integration_id
                 AND map.conversation_id=attempt.conversation_id AND map.remote_conversation_id=attempt.remote_conversation_id
               WHERE ${inboxTarget} IS NOT NULL AND candidate_conversation.recipient_kind='INDIVIDUAL'
                 AND ((candidate_message.direction='INCOMING' AND candidate_message.source='CONTACT')
                   OR (candidate_message.direction='OUTGOING' AND candidate_message.source='EXTERNAL_OBSERVED'
                     AND (j.payload ? 'reviewedInboxTarget' OR (j.payload ? 'qrObservationId' AND ${firstQrObservation}
                       AND blocked_message.upstream_message_id<>'' AND blocked_message.upstream_message_id !~ '[[:space:][:cntrl:]]'
                       AND blocked_message.upstream_message_id<>candidate_message.upstream_message_id)))) AND NOT candidate_message.is_historical
                 AND candidate_message.upstream_message_id IS NOT NULL AND blocked.message_id<>j.message_id
                 AND blocked.kind='MIRROR_MESSAGE' AND blocked.payload->>'operation'='SEND_MESSAGE'
                 AND NOT blocked_message.is_historical AND (
                   (blocked_message.direction='INCOMING' AND blocked_message.source='CONTACT')
                   OR (blocked_message.direction='OUTGOING' AND blocked_message.source='EXTERNAL_OBSERVED'
                     AND blocked_message.state IN ('SENT','DELIVERED','READ')
                     AND attempt.state='UNKNOWN' AND attempt.transport='BROKER_TRANSPORT'
                     AND attempt.remote_conversation_id::text=blocked.payload->>'conversationId'
                     AND length(blocked_message.upstream_message_id)>0 AND blocked_message.upstream_message_id !~ '[[:space:][:cntrl:]]'
                     AND length(candidate_message.upstream_message_id)>0 AND candidate_message.upstream_message_id !~ '[[:space:][:cntrl:]]'
                     AND blocked_message.upstream_message_id<>candidate_message.upstream_message_id
                     AND NOT EXISTS(SELECT 1 FROM chatwoot_mirror_attempts conflicting WHERE conflicting.organization_id=attempt.organization_id
                       AND conflicting.integration_id=attempt.integration_id AND conflicting.job_id=attempt.job_id
                       AND conflicting.id<>attempt.id AND conflicting.state IN ('UNKNOWN','DISPATCHED','CONFIRMED'))))
                 AND blocked_conversation.id=candidate_conversation.id
                 AND attempt.organization_id=j.organization_id AND attempt.integration_id=j.integration_id
                 AND attempt.job_id=blocked.id AND attempt.message_id=blocked.message_id AND attempt.channel_id=c.channel_id
                 AND attempt.conversation_id=candidate_conversation.id AND attempt.state IN ('DISPATCHED','UNKNOWN')
                 AND attempt.remote_message_id IS NULL
                 AND attempt.remote_conversation_id::text=${inboxTarget}->>'conversation'
                 AND attempt.account_id::text=${inboxTarget}->>'account'
                 AND attempt.inbox_id::text=${inboxTarget}->>'inbox'
                 AND attempt.destination_revision::text=${inboxTarget}->>'revision')))`;
  const eligibleJob = `${dueJob} AND (${noUnknown} OR (${independentMirror})
    OR (${independentCampaignReply}) OR (${independentHumanReply}) OR (${waitingHumanCycle}) OR (${provenHumanStatus}))`;
  async function claim(org: string): Promise<Job | undefined> {
    return tx(org, async (t) => {
      // An expired POST might have succeeded remotely. Replies are local, idempotent transactions.
      await t.query(
        `UPDATE integration_jobs SET status=CASE WHEN payload->>'historical'='true' AND payload->>'operation'='IMPORT_HISTORY' THEN 'HISTORY_PENDING' WHEN kind='CHATWOOT_REPLY' THEN 'PENDING' ELSE 'UNKNOWN' END,
        lease_token=NULL,lease_expires_at=NULL,last_error='WORKER_LEASE_EXPIRED',updated_at=now()
        WHERE organization_id=$1 AND status='RUNNING' AND lease_expires_at<now()`,
        [org],
      );
      if (!(await isOrganizationActive(t, org))) return;
      const connection = (
        await t.query<{ id: string }>(
          `SELECT c.id FROM chatwoot_connections c
        JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
        WHERE c.organization_id=$1 AND c.status='READY' AND a.status='READY'
          AND d.approval_status='APPROVED'
          AND chatwoot_channel_identity_ready(c.organization_id,c.channel_id)
          AND EXISTS(SELECT 1 FROM integration_jobs j WHERE j.organization_id=c.organization_id AND j.integration_id=c.id AND ${eligibleJob})
          AND NOT EXISTS(SELECT 1 FROM integration_jobs j WHERE j.organization_id=c.organization_id AND j.integration_id=c.id AND j.status='RUNNING')
        ORDER BY c.updated_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
          [org],
        )
      ).rows[0];
      if (!connection) return;
      const job = (
        await t.query<{ id: string; held_history: boolean; receipt_only: boolean; reviewed: boolean }>(
          `SELECT j.id, j.payload ? 'reviewedInboxTarget' AS reviewed, j.kind='MIRROR_MESSAGE' AND EXISTS (
            SELECT 1 FROM integration_jobs held
            WHERE held.organization_id=j.organization_id AND held.integration_id=j.integration_id
              AND held.message_id=j.message_id AND held.kind='MIRROR_MESSAGE'
              AND held.status='HISTORY_PENDING' AND held.available_at='infinity'
              AND held.last_error='PRE_ACTIVATION_HISTORY_HELD'
          ) AS held_history, ${inboxTarget} IS NOT NULL AND EXISTS (
            SELECT 1 FROM integration_jobs blocked JOIN messaging_messages previous ON previous.organization_id=blocked.organization_id AND previous.id=blocked.message_id
            JOIN messaging_messages candidate ON candidate.organization_id=j.organization_id AND candidate.id=j.message_id AND candidate.conversation_id=previous.conversation_id
            WHERE blocked.organization_id=j.organization_id AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN'
          ) AS receipt_only FROM integration_jobs j JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
        WHERE j.organization_id=$1 AND j.integration_id=$2 AND ${eligibleJob}
          AND NOT EXISTS(SELECT 1 FROM integration_jobs busy WHERE busy.organization_id=j.organization_id
            AND busy.integration_id=j.integration_id AND busy.status='RUNNING')
        ORDER BY CASE WHEN j.payload->>'historical'='true' THEN 2
          WHEN (j.payload ? 'reviewedInboxTarget')=(c.live_claims_since_review>=3) THEN 0 ELSE 1 END,
          j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [org, connection.id],
        )
      ).rows[0];
      if (!job) return;
      if (job.held_history) {
        // A later read or delivery receipt can create a fresh job for a message
        // that predates activation. Keep that message in its original lane.
        await t.query(
          `UPDATE integration_jobs SET status='HISTORY_PENDING',available_at='infinity',
            last_error='PRE_ACTIVATION_HISTORY_HELD',updated_at=now()
            WHERE organization_id=$1 AND id=$2`,
          [org, job.id],
        );
        return;
      }
      await t.query(
        `UPDATE chatwoot_connections SET updated_at=now(),
          live_claims_since_review=CASE WHEN $3 THEN 0 ELSE LEAST(3,live_claims_since_review+1) END
          WHERE organization_id=$1 AND id=$2`,
        [org, connection.id,job.reviewed],
      );
      return (
        await t.query<Job>(
          `UPDATE integration_jobs SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_expires_at=now()+interval '3 minutes',updated_at=now(),
             payload=CASE WHEN $4 THEN payload||'{"requiresNativeReceipt":true}'::jsonb ELSE payload END
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
          [org, job.id, randomUUID(), job.receipt_only],
        )
      ).rows[0];
    });
  }
  async function progress(
    job: Job,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await tx(job.organization_id, async (t) => {
      const result = await t.query(
        `UPDATE integration_jobs SET payload=payload || $4::jsonb,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>now() RETURNING id`,
        [job.organization_id, job.id, job.lease_token, JSON.stringify(patch)],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
      Object.assign(job.payload, patch);
    });
  }
  async function beforeExternal(job: Job, operation: string) {
    const connection = await tx(job.organization_id, t => readChatwootConnection(t, job.organization_id, job.integration_id));
    if (connection) await options.assertIdentity?.(job.organization_id, connection.channel_id);
    await tx(job.organization_id, async (t) => {
      if (!(await isOrganizationActive(t, job.organization_id)))
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const result = await t.query(
        `UPDATE integration_jobs j SET payload=payload||jsonb_build_object('operation',$4::text),updated_at=now()
       WHERE j.organization_id=$1 AND j.id=$2 AND j.lease_token=$3 AND j.status='RUNNING' AND j.lease_expires_at>now()+interval '20 seconds'
       AND EXISTS(SELECT 1 FROM chatwoot_connections c JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
        WHERE c.organization_id=j.organization_id AND c.id=j.integration_id AND c.status='READY' AND a.status='READY'
          AND d.approval_status='APPROVED' AND chatwoot_channel_identity_ready(c.organization_id,c.channel_id)) RETURNING j.id`,
        [job.organization_id, job.id, job.lease_token, operation],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      job.payload.operation = operation;
    });
  }
  async function finish(job: Job): Promise<void> {
    await tx(job.organization_id, async (t) => {
      const result = await t.query(
        `UPDATE integration_jobs SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' RETURNING id`,
        [job.organization_id, job.id, job.lease_token],
      );
      if (!result.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
    });
  }
  async function receiveReply(job: Job): Promise<void> {
    if(await groups.receiveReply(job))return;
    const data = replySchema.parse(job.payload);
    const nativeCsat=data.attendanceKind==='NATIVE_CSAT';
    if(nativeCsat&&(!data.attendanceObservationId||!data.destinationRevision||data.campaignIntentId||!data.content||data.attachments))
      throw new IntegrationError('CHATWOOT_CSAT_PROOF_REQUIRED',409);
    const binding = await tx(job.organization_id, async (t) => ({
      account: await readChatwootAccount(t, job.organization_id),
      connection: await readChatwootConnection(
        t,
        job.organization_id,
        job.integration_id,
      ),
      mapped: (
        await t.query(
          "SELECT 1 FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3",
          [job.organization_id, job.integration_id, data.conversationId],
        )
      ).rowCount,
    }));
    if(nativeCsat&&!binding.mapped)throw new IntegrationError('CHATWOOT_CONVERSATION_NOT_BOUND',409);
    let campaignCanonical:unknown;
    if(data.campaignIntentId){
      if(!binding.account||!binding.connection?.inbox_id)throw new IntegrationError('INTEGRATION_PAUSED',409);
      await tx(job.organization_id,t=>requireCampaignIntent(t,job.organization_id,data.campaignIntentId!,job.integration_id,data.conversationId,data.messageId));
      campaignCanonical=await env.client(binding.account).canonicalMessage(Number(binding.account.account_id),Number(binding.connection.inbox_id),data.conversationId,data.messageId);
    }
    let humanCanonical:unknown;
    if(data.outboundIntentId){
      if(data.attendanceKind!=='HUMAN_PUBLIC'||!data.attendanceObservationId||!binding.account||!binding.connection?.inbox_id)
        throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);
      humanCanonical=await env.client(binding.account).canonicalMessage(Number(binding.account.account_id),Number(binding.connection.inbox_id),data.conversationId,data.messageId);
    }
    function verifyHumanIntent(accountId:number,inboxId:number,senderId:number,admittedAt?:Date){
      if(!data.outboundIntentId)throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);
      requireCanonicalHumanIntent(humanCanonical,{intentId:data.outboundIntentId,integrationId:job.integration_id,accountId,inboxId,
        conversationId:data.conversationId,messageId:data.messageId,senderId,...(admittedAt?{admittedAt}:{}),
        ...(data.content?{content:data.content}:{}),...(data.caption!==undefined?{caption:data.caption}:{}),
        ...(data.attachments?{attachments:data.attachments}:{})});
    }
    let remote:
      | Awaited<ReturnType<ReturnType<typeof env.client>["conversation"]>>
      | undefined;
    let remoteSource: string | undefined;
    let canonical:Awaited<ReturnType<ReturnType<typeof env.client>['attendanceConversation']>>|undefined;
    if (!binding.mapped||data.campaignIntentId) {
      if (
        !binding.account ||
        !binding.connection?.inbox_id ||
        binding.connection.status !== "READY"
      )
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const client = env.client(binding.account);
      remote = await client.conversation(
        Number(binding.account.account_id),
        data.conversationId,
      );
      if (
        remote.account_id !== Number(binding.account.account_id) ||
        remote.inbox_id !== Number(binding.connection.inbox_id) ||
        !/^\+[1-9]\d{7,14}$/u.test(remote.meta.sender.phone_number ?? "")
      )
        throw new IntegrationError("CHATWOOT_BINDING_MISMATCH");
      const contact = await client.contact(
        Number(binding.account.account_id),
        remote.meta.sender.id,
      );
      if (
        contact.id !== remote.meta.sender.id ||
        contact.phone_number !== remote.meta.sender.phone_number
      )
        throw new IntegrationError("CHATWOOT_BINDING_MISMATCH");
      remoteSource = data.campaignIntentId||data.newCycleAdmission
        ? canonicalCampaignRecipient(remote,contact,{accountId:Number(binding.account.account_id),inboxId:Number(binding.connection.inbox_id),conversationId:data.conversationId},data.campaignIntentId?'CAMPAIGN_RECIPIENT_CHANGED':'CHATWOOT_BINDING_MISMATCH').sourceId
        : contact.contact_inboxes.find((i) => i.inbox.id === remote!.inbox_id)?.source_id;
      if (!remoteSource)
        throw new IntegrationError("CHATWOOT_CONVERSATION_NOT_BOUND");
      if(data.attendanceObservationId&&!data.campaignIntentId)canonical=await client.attendanceConversation(Number(binding.account.account_id),data.conversationId);
    }
    await tx(job.organization_id, async (t) => {
      if(!binding.connection)throw new IntegrationError('INTEGRATION_PAUSED',409);
      // Serialize with destination/credential rotation before taking the channel
      // lock, then retain the current scope through the outbox COMMIT.
      if(data.outboundIntentId)await lockChatwootDestination(t,job.organization_id);
      await lockAttendanceChannel(t,job.organization_id,binding.connection.channel_id);
      if(data.outboundIntentId)await t.query(`SELECT c.id FROM chatwoot_connections c
        JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
        WHERE c.organization_id=$1 AND c.id=$2 FOR SHARE OF c,a,d`,[job.organization_id,job.integration_id]);
      const lease = await t.query(
        "SELECT id FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>now() FOR UPDATE",
        [job.organization_id, job.id, job.lease_token],
      );
      if (!lease.rowCount)
        throw new IntegrationError("INTEGRATION_LEASE_LOST", 409);
      const currentAccount = await readChatwootAccount(t, job.organization_id);
      requireApprovedDestination(currentAccount?.destination, job.organization_id, env.origin);
      const connection = await readChatwootConnection(
        t,
        job.organization_id,
        job.integration_id,
      );
      if (
        !connection ||
        connection.status !== "READY" ||
        !(await isOrganizationActive(t, job.organization_id))
      )
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      if((remote||data.outboundIntentId)&&(!binding.account||!binding.connection||currentAccount?.base_url!==binding.account.base_url||
        currentAccount.account_id!==binding.account.account_id||currentAccount.credential_version!==binding.account.credential_version||
        currentAccount.destination?.revision!==binding.account.destination?.revision||connection.inbox_id!==binding.connection.inbox_id||connection.channel_id!==binding.connection.channel_id))
        throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
      if (!(await t.query<{ ready: boolean }>('SELECT chatwoot_channel_identity_ready($1,$2) AS ready', [job.organization_id, connection.channel_id])).rows[0]?.ready)
        throw new IntegrationError('INTEGRATION_PAUSED', 409);
      let map = (
        await t.query<{ conversation_id: string }>(
          "SELECT conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND remote_conversation_id=$3",
          [job.organization_id, job.integration_id, data.conversationId],
        )
      ).rows[0];
      if (!map && remote && remoteSource) {
        if(data.newCycleAdmission){
          const observed=await t.query<{sender_id:string;created_at:Date}>(`SELECT o.event->>'senderId' AS sender_id,o.created_at FROM integration_jobs j
            JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
            JOIN chatwoot_attendance_observations o ON o.organization_id=j.organization_id AND o.id=$3 AND o.integration_id=c.id
            WHERE j.organization_id=$1 AND j.id=$2 AND (${waitingHumanCycle})`,[job.organization_id,job.id,data.attendanceObservationId]);
          if(!observed.rows[0]?.sender_id||!currentAccount)throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);
          verifyHumanIntent(Number(currentAccount.account_id),Number(connection.inbox_id),Number(observed.rows[0].sender_id),observed.rows[0].created_at);
          if(!await mayStartIndependentHumanCycle(t,{organizationId:job.organization_id,integrationId:job.integration_id,
            channelId:connection.channel_id,remoteContactId:remote.meta.sender.id,sourceId:remoteSource,phone:remote.meta.sender.phone_number!})){
            await t.query(`UPDATE integration_jobs SET status='PENDING',attempts=greatest(0,attempts-1),
              last_error='CHATWOOT_CYCLE_WAITING_PREVIOUS_MIRROR',available_at=now()+interval '5 minutes',
              lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3`,
              [job.organization_id,job.id,job.lease_token]);
            return;
          }
        }
        await repo.findChannel(t, job.organization_id, connection.channel_id, { lock: true });
        const contact = await repo.upsertContact(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          externalId: remote.meta.sender.phone_number!.slice(1),
          displayName: remote.meta.sender.name ?? null,
          consentStatus: "UNKNOWN",
          consentUpdatedAt: null,
        });
        let conversation = await repo.getOrCreateConversation(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          channelId: connection.channel_id,
          contactId: contact.id,
        });
        const cycle=await preparePhysicalConversationCycle(t,{organizationId:job.organization_id,channelId:connection.channel_id,integrationId:job.integration_id,
          conversationId:conversation.id,remoteConversationId:data.conversationId,remoteContactId:remote.meta.sender.id,sourceId:remoteSource,humanPublicReply:data.attendanceKind==='HUMAN_PUBLIC'});
        if(cycle.waiting){
          await t.query(`UPDATE integration_jobs SET status='PENDING',attempts=greatest(0,attempts-1),last_error=$4,
            available_at=now()+interval '30 seconds',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE organization_id=$1 AND id=$2 AND lease_token=$3`,[job.organization_id,job.id,job.lease_token,cycle.waiting]);
          return;
        }
        if(cycle.conversationId!==conversation.id)conversation=(await repo.findConversation(t,job.organization_id,cycle.conversationId))!;
        const inserted = await t.query(
          `INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING conversation_id`,
          [
            job.organization_id,
            job.integration_id,
            conversation.id,
            remote.meta.sender.id,
            remoteSource,
            data.conversationId,
          ],
        );
        if (!inserted.rowCount)
          throw new IntegrationError("CHATWOOT_CONVERSATION_ALREADY_BOUND");
        map = { conversation_id: conversation.id };
      }
      if (!map)
        throw new IntegrationError("CHATWOOT_CONVERSATION_NOT_BOUND", 409);
      if(data.campaignIntentId){
        const intent=await requireCampaignIntent(t,job.organization_id,data.campaignIntentId,job.integration_id,data.conversationId,data.messageId);
        if(!remote||Number(intent.remote_contact_id)!==remote.meta.sender.id||intent.recipient_phone!==remote.meta.sender.phone_number||intent.recipient_source_id!==remoteSource)
          throw new IntegrationError('CAMPAIGN_RECIPIENT_CHANGED',409);
        const physical=await t.query(`SELECT 1 FROM messaging_conversations cv JOIN messaging_contacts contact ON contact.organization_id=cv.organization_id AND contact.id=cv.contact_id
          JOIN chatwoot_conversations cm ON cm.organization_id=cv.organization_id AND cm.conversation_id=cv.id AND cm.integration_id=$3
          WHERE cv.organization_id=$1 AND cv.id=$2 AND cm.remote_conversation_id=$4 AND cm.contact_id=$5 AND cm.source_id=$6 AND contact.external_id=$7`,
          [job.organization_id,map.conversation_id,job.integration_id,data.conversationId,intent.remote_contact_id,intent.recipient_source_id,intent.recipient_phone.slice(1)]);
        if(!physical.rowCount)throw new IntegrationError('CAMPAIGN_RECIPIENT_CHANGED',409);
        const proof=verifyCanonicalCampaignMessage(intent,campaignCanonical,{conversationId:data.conversationId,messageId:data.messageId,inboxId:Number(connection.inbox_id)});
        if(intent.text!==(data.content?.text??data.caption??'')||
          (intent.kind==='text'?Boolean(data.attachments):!data.attachments||data.attachments.length!==1||data.attachments[0]!.kind!==intent.kind||data.attachments[0]!.id!==proof.attachmentIds[0]))
          throw new IntegrationError('CAMPAIGN_MESSAGE_NOT_PROVEN',409);
        const bound=await t.query(`UPDATE chatwoot_campaign_intents SET local_conversation_id=$3 WHERE organization_id=$1 AND id=$2
          AND (local_conversation_id IS NULL OR local_conversation_id=$3) RETURNING id`,[job.organization_id,data.campaignIntentId,map.conversation_id]);
        if(!bound.rowCount)throw new IntegrationError('CAMPAIGN_CONTEXT_CHANGED',409);
      } else if(data.attendanceObservationId){
        if(!currentAccount?.destination||data.destinationRevision!==currentAccount.destination.revision)throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
        const scope:ChatwootObservationScope={organizationId:job.organization_id,channelId:connection.channel_id,integrationId:job.integration_id,
          destinationRevision:currentAccount.destination.revision,credentialRevision:currentAccount.credential_version,accountId:Number(currentAccount.account_id),inboxId:Number(connection.inbox_id)};
        if(canonical)await initializeChatwootAttendanceMap(t,scope,{conversationId:map.conversation_id,remoteConversationId:data.conversationId,canonical});
        const observation=(await t.query<{disposition:string;event:ChatwootAttendanceEvent;credential_revision:number;channel_id:string;created_at:Date}>(`SELECT disposition,event,credential_revision,channel_id,created_at FROM chatwoot_attendance_observations
          WHERE organization_id=$1 AND id=$2 AND integration_id=$3 AND destination_revision=$4 AND remote_conversation_id=$5 AND conversation_id=$6
            AND account_id=$7 AND inbox_id=$8`,
          [job.organization_id,data.attendanceObservationId,job.integration_id,scope.destinationRevision,data.conversationId,map.conversation_id,scope.accountId,scope.inboxId])).rows[0];
        if(!observation||observation.disposition!=='APPLIED'||observation.event.kind!==data.attendanceKind||!await mayForwardChatwootAttendanceReply(t,scope,observation.event))
          throw new IntegrationError('ATTENDANCE_CONTROL_RECONCILIATION_REQUIRED',409);
        if(data.outboundIntentId){
          const event=observation.event;
          if(event.kind!=='HUMAN_PUBLIC'||event.outboundIntentId!==data.outboundIntentId||event.senderId===undefined||
            event.remoteMessageId!==data.messageId||event.remoteConversationId!==data.conversationId||
            observation.credential_revision!==scope.credentialRevision||observation.channel_id!==scope.channelId)
            throw new IntegrationError('CHATWOOT_HUMAN_INTENT_NOT_PROVEN',409);
          verifyHumanIntent(scope.accountId,scope.inboxId,event.senderId,data.newCycleAdmission?observation.created_at:undefined);
          // A canonical GET happens outside this transaction. Re-check the
          // uncertain-mirror proof under the channel lock before any enqueue.
          const isolated=await t.query(`SELECT 1 FROM integration_jobs j
            JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
            WHERE j.organization_id=$1 AND j.id=$2 AND
              (NOT EXISTS(SELECT 1 FROM integration_jobs blocked WHERE blocked.organization_id=j.organization_id
                AND blocked.integration_id=j.integration_id AND blocked.status='UNKNOWN') OR (${independentHumanReply}))`,
            [job.organization_id,job.id]);
          if(!isolated.rowCount)throw new IntegrationError('ATTENDANCE_CONTROL_RECONCILIATION_REQUIRED',409);
        }
        if(nativeCsat&&(observation.credential_revision!==scope.credentialRevision||observation.channel_id!==scope.channelId||
          !('remoteMessageId' in observation.event)||observation.event.remoteMessageId!==data.messageId||observation.event.remoteConversationId!==data.conversationId))
          throw new IntegrationError('CHATWOOT_CSAT_PROOF_REQUIRED',409);
      } else {
        // Backward-compatible jobs admitted before attendance observations existed.
        await repo.setConversationMode(t,{organizationId:job.organization_id,conversationId:map.conversation_id,mode:'HUMAN'});
      }
      const contents: MessageContent[] = [];
      if (data.content) contents.push(data.content);
      if (data.attachments) {
        if (data.caption && data.caption.length > 1024)
          contents.push({ type: "TEXT", text: data.caption });
        for (const [index, attachment] of data.attachments.entries()) {
          const mediaId = await registerPendingMedia(
            t,
            job.organization_id,
            connection.channel_id,
            {
              source: "CHATWOOT",
              sourceKey: `${job.integration_id}:${data.messageId}:${attachment.id}`,
              kind: attachment.kind,
              fileName: attachment.kind,
              descriptor: {
                integrationId: job.integration_id,
                conversationId: data.conversationId,
                messageId: data.messageId,
                attachmentId: attachment.id,
              },
            },
          );
          contents.push({
            type: "MEDIA",
            mediaId,
            kind: attachment.kind,
            fileName: attachment.kind,
            ...(index === 0 && data.caption && data.caption.length <= 1024
              ? { caption: data.caption }
              : {}),
          });
        }
      }
      let firstId: string | undefined;
      const replyKey=data.attendanceObservationId?`chatwoot:${job.integration_id}:${data.destinationRevision}:${data.messageId}`:`chatwoot:${data.messageId}`;
      for (const [index, content] of contents.entries()) {
        const result = await repo.enqueueOutgoing(t, {
          id: randomUUID(),
          organizationId: job.organization_id,
          channelId: connection.channel_id,
          conversationId: map.conversation_id,
          source: "OPERATOR",
          chatwootReplyProof:{jobId:job.id,leaseToken:job.lease_token},
          ...(data.campaignIntentId?{campaignIntentId:data.campaignIntentId}:{}),
          content,
          idempotencyKey: data.content ? replyKey : `${replyKey}:${index}`,
          bodyHash: createHash("sha256")
            .update(JSON.stringify({ data, index }))
            .digest("hex"),
          policy: { requireOptIn: false },
        });
        firstId ??= result.message.id;
        await t.query(
          `INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,
          [
            job.organization_id,
            job.integration_id,
            result.message.id,
            data.messageId,
          ],
        );
      }
      await t.query(
        "UPDATE integration_jobs SET status='SUCCEEDED',message_id=$4,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3",
        [job.organization_id, job.id, job.lease_token, firstId],
      );
    });
  }
  async function mirror(job: Job): Promise<void> {
    if(await groups.mirror(job))return;
    const org = job.organization_id,originalMirrorOperation=job.payload.operation;
    const context = await tx(org, async (t) => {
      const a = await readChatwootAccount(t, org),
        c = await readChatwootConnection(t, org, job.integration_id);
      if (!a || !c?.inbox_id || c.status !== "READY")
        throw new IntegrationError("INTEGRATION_PAUSED", 409);
      const message = (
        await t.query<{
          id: string;
          conversation_id: string;
          direction: string;
          source: string;
          content: MessageContent;
          state: string;
          canonical_error_code: string | null;
          is_historical:boolean;
          created_at:Date;
          instance_id:string|null;
          has_mirror_attempt:boolean;
          reviewed_hash:string|null;
        }>(
          `SELECT id,conversation_id,direction,source,content,state,canonical_error_code,is_historical,created_at,
            (SELECT instance_id FROM messaging_channels WHERE organization_id=$1 AND id=$3) AS instance_id,
            EXISTS(SELECT 1 FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND job_id=$4) AS has_mirror_attempt,
            CASE WHEN $5::boolean THEN ${reviewedMessageHashSql} END AS reviewed_hash
            FROM messaging_messages m WHERE organization_id=$1 AND id=$2 AND channel_id=$3`,
          [org, job.message_id, c.channel_id,job.id,job.payload.reviewedInboxTarget!==undefined],
        )
      ).rows[0];
      if (!message)
        throw new IntegrationError("INTEGRATION_MESSAGE_NOT_FOUND", 404);
      const contact = (
        await t.query<{
          id: string;
          external_id: string;
          display_name: string | null;
        }>(
          `SELECT contact.id,contact.external_id,contact.display_name FROM messaging_contacts contact
        JOIN messaging_conversations conversation ON conversation.organization_id=contact.organization_id AND conversation.contact_id=contact.id WHERE conversation.organization_id=$1 AND conversation.id=$2`,
          [org, message.conversation_id],
        )
      ).rows[0];
      if (!contact)
        throw new IntegrationError("INTEGRATION_CONTACT_NOT_FOUND", 404);
      const map = (
        await t.query<ConversationMap>(
          "SELECT contact_id,source_id,remote_conversation_id FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3",
          [org, c.id, message.conversation_id],
        )
      ).rows[0];
      const mappedMessage = (
        await t.query<{ remote_message_id: string }>(
          "SELECT remote_message_id FROM chatwoot_messages WHERE organization_id=$1 AND integration_id=$2 AND message_id=$3",
          [org, c.id, message.id],
        )
      ).rows[0];
      const owner=(await t.query<{executor:string;automation_id:string|null;remote_binding_id:string|null;revision:number}>(
        'SELECT executor,automation_id,remote_binding_id,revision FROM attendance_owners WHERE organization_id=$1 AND channel_id=$2',[org,c.channel_id])).rows[0];
      return { a, c, message, contact, map, mappedMessage,owner };
    });
    const { a, c, message, contact } = context;
    const externalObserved=message.source==='EXTERNAL_OBSERVED';
    const originLabel='[Saída observada no WhatsApp]';
    if (
      message.direction === "OUTGOING" &&
      ["ACCEPTED", "SENDING", "UNKNOWN"].includes(message.state)
    ) {
      await finish(job);
      return;
    }
    const client = env.client(a),
      accountId = Number(a.account_id),
      inboxId = Number(c.inbox_id);
    if(!a.destination)throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED',409);
    if (job.payload.requiresNativeReceipt === true) {
      const reviewed=job.payload.reviewedInboxTarget!==undefined;
      const newObserved=job.payload.qrObservationId!==undefined&&z.uuid().safeParse(job.payload.qrObservationId).success;
      const target = z.object({ revision:z.number().int(), account:z.string(), inbox:z.string(),credentialRevision:z.number().int().optional(),phoneHash:z.string().optional(),messageHash:z.string().optional(),
        instance:z.uuid(), conversation:z.string(), contact:z.string(), sourceHash:z.string() }).safeParse(job.payload.admittedInboxTarget??job.payload.reviewedInboxTarget);
      const individualMirror=(message.direction==='INCOMING'&&message.source==='CONTACT')||
        ((reviewed||newObserved)&&message.direction==='OUTGOING'&&message.source==='EXTERNAL_OBSERVED');
      if (!target.success || !individualMirror || message.is_historical || ((reviewed||newObserved)&&(target.data.credentialRevision!==a.credential_version
        ||target.data.phoneHash!==createHash('sha256').update(contact.external_id).digest('hex')))
        || (reviewed&&target.data.messageHash!==message.reviewed_hash)
        || !context.map || String(context.map.remote_conversation_id)!==target.data.conversation
        || String(context.map.contact_id)!==target.data.contact || createHash('sha256').update(context.map.source_id).digest('hex')!==target.data.sourceHash
        || String(a.account_id)!==target.data.account || String(c.inbox_id)!==target.data.inbox
        || a.destination.revision!==target.data.revision || message.instance_id!==target.data.instance)
        throw new IntegrationError('CHATWOOT_LIVE_CONTEXT_CHANGED',409);
      if(reviewed||newObserved)await verifyReviewedContact(client,accountId,inboxId,Number(context.map.remote_conversation_id),{
        contact_id:String(context.map.contact_id),source_id:context.map.source_id,phone:contact.external_id});
    }
    // A sibling may only acknowledge or patch the already confirmed remote message.
    // Recheck after claim, even if another process removed or replaced the mapping.
    if (job.payload.reviewedStatusLeader !== undefined) {
      const mappedMessage=context.mappedMessage,conversation=context.map,revision=a.destination.revision;
      if(!mappedMessage || !conversation || !z.uuid().safeParse(job.payload.reviewedStatusLeader).success)
        throw new IntegrationError('CHATWOOT_REVIEW_RECEIPT_CHANGED',409);
      const receipt=await tx(org,t=>t.query(`SELECT 1 FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND integration_id=$2
        AND job_id=$3 AND message_id=$4 AND channel_id=$5 AND account_id=$6 AND inbox_id=$7 AND conversation_id=$8
        AND remote_conversation_id=$9 AND remote_message_id=$10 AND state='CONFIRMED' AND destination_revision=$11`,
        [org,c.id,job.payload.reviewedStatusLeader,message.id,c.channel_id,accountId,inboxId,message.conversation_id,
          conversation.remote_conversation_id,mappedMessage.remote_message_id,revision]));
      if(!receipt.rowCount)throw new IntegrationError('CHATWOOT_REVIEW_RECEIPT_CHANGED',409);
    }
    const attendanceScope:ChatwootObservationScope={organizationId:org,channelId:c.channel_id,integrationId:c.id,
      destinationRevision:a.destination.revision,credentialRevision:a.credential_version,accountId,inboxId};
    const priorNative=job.payload.liveIngressProof===undefined?undefined:liveIngressProofSchema.safeParse(job.payload.liveIngressProof);
    if(!context.mappedMessage&&typeof job.payload.remoteMessageId!=='number'&&priorNative!==undefined){
      if(job.payload.mirrorProtocol!==LIVE_INGRESS_PROTOCOL||!priorNative.success||!context.map
        ||priorNative.data.organization_id!==org||priorNative.data.integration_id!==c.id
        ||priorNative.data.instance_id!==message.instance_id||priorNative.data.destination_revision!==attendanceScope.destinationRevision
        ||priorNative.data.credential_revision!==a.credential_version||priorNative.data.base_url!==a.base_url
        ||priorNative.data.account_id!==accountId||priorNative.data.inbox_id!==inboxId
        ||priorNative.data.broker_message_id!==message.id||priorNative.data.conversation_id!==Number(context.map.remote_conversation_id))
        throw new IntegrationError('CHATWOOT_LIVE_REQUEST_CONFLICT',409);
    }
    const historical=message.is_historical;
    if(historical){
      const capability=await client.historyImportCapability(accountId,{organizationId:org,integrationId:c.id,inboxId});
      if(!context.map&&capability.supports_silent_bootstrap!==true)throw new IntegrationError('CHATWOOT_HISTORY_UNSUPPORTED');
    }
    const brokerOwnsConversation=!historical&&context.owner?.executor==='BROKER'&&context.owner.remote_binding_id===null;
    let media: BinaryMedia | undefined;
    if (
      !context.mappedMessage &&
      typeof job.payload.remoteMessageId !== "number" &&
      message.content.type === "MEDIA"
    ) {
      if (!options.media) throw new MediaError("MEDIA_NOT_CONFIGURED");
      media = {
        ...(await options.media.read(org, message.content.mediaId)),
        ...(message.content.caption
          ? { caption: message.content.caption }
          : {}),
      };
    }
    let map = context.map;
    if(!map&&historical){
      await beforeExternal(job,'IMPORT_HISTORY');
      const receipt=await client.bootstrapHistoryConversation(accountId,{organizationId:org,integrationId:c.id,inboxId,
        brokerContactId:contact.id,brokerConversationId:message.conversation_id,phone:contact.external_id,
        name:(contact.display_name??'+'+contact.external_id).slice(0,160),occurredAt:Math.floor(message.created_at.getTime()/1000)});
      map=await tx(org,async t=>{
        await lockAttendanceChannel(t,org,c.channel_id);
        await t.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,integration_id,conversation_id) DO NOTHING`,
          [org,c.id,message.conversation_id,receipt.contact_id,receipt.source_id,receipt.conversation_id]);
        const canonical=(await t.query<ConversationMap>(`SELECT contact_id,source_id,remote_conversation_id FROM chatwoot_conversations
          WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3`,[org,c.id,message.conversation_id])).rows[0];
        if(!canonical||String(canonical.contact_id)!==String(receipt.contact_id)||canonical.source_id!==receipt.source_id)
          throw new IntegrationError('CHATWOOT_HISTORY_RECEIPT_CONFLICT');
        return canonical;
      });
    }
    if (!map) {
      let contactId =
        typeof job.payload.contactId === "number"
          ? job.payload.contactId
          : await client.findContact(accountId, contact.external_id);
      if (!contactId) {
        await beforeExternal(job, "CREATE_CONTACT");
        contactId = await client.createContact(accountId, {
          inboxId,
          phone: contact.external_id,
          name: contact.display_name ?? "+" + contact.external_id,
          identifier: `jrc-${org}-${contact.id}`,
        });
      }
      await progress(job, { contactId });
      if (typeof job.payload.sourceId !== "string")
        await beforeExternal(job, "LINK_CONTACT");
      const sourceId =
        typeof job.payload.sourceId === "string"
          ? job.payload.sourceId
          : await client.linkContactInbox(
              accountId,
              contactId,
              inboxId,
              `jrc-${contact.id}`,
            );
      await progress(job, { sourceId });
      if (typeof job.payload.conversationId !== "number")
        await beforeExternal(job, "CREATE_CONVERSATION");
      const flowOwnsInbox = await tx(org, async t => Boolean((await t.query(`select 1 from flow_chatwoot_bindings b
        join flow_features f on f.organization_id=b.organization_id and f.enabled and f.revision=b.feature_revision
        join chatwoot_accounts a on a.organization_id=b.organization_id and a.status='READY' and a.account_id=b.account_id and a.credential_version=b.credential_version
        join chatwoot_destinations d on d.organization_id=b.organization_id and d.approval_status='APPROVED' and d.revision=b.destination_revision
        where b.organization_id=$1 and b.inbox_id=$2 and b.status='READY'`, [org, inboxId])).rowCount));
      if(brokerOwnsConversation){
        const policy=await client.attendanceInbox(accountId,inboxId);
        if(policy.id!==inboxId||policy.channel_type!=='Channel::Api')throw new IntegrationError('CHATWOOT_BINDING_MISMATCH',409);
        if(policy.greeting_enabled!==false||policy.enable_auto_assignment!==false)throw new IntegrationError('CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION',409);
        if(await client.inboxFlowBot(accountId,inboxId))throw new IntegrationError('ATTENDANCE_REMOTE_EXECUTOR_CONFLICT',409);
      }
      const conversationId =
        typeof job.payload.conversationId === "number"
          ? job.payload.conversationId
          : await client.createConversation(accountId, {
              inboxId,
              contactId,
              sourceId,
              ...(historical||flowOwnsInbox||brokerOwnsConversation ? { status: 'pending' as const } : {}),
            });
      await progress(job, { conversationId });
      const canonical=brokerOwnsConversation?await client.attendanceConversation(accountId,conversationId):undefined;
      await tx(org, async t => {
        await lockAttendanceChannel(t,org,c.channel_id);
        await t.query(
            `INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,integration_id,conversation_id) DO NOTHING`,
            [
              org,
              c.id,
              message.conversation_id,
              contactId,
              sourceId,
              conversationId,
            ],
          );
        if(canonical)await initializeChatwootAttendanceMap(t,attendanceScope,{conversationId:message.conversation_id,remoteConversationId:conversationId,canonical});
      });
      map = {
        contact_id: String(contactId),
        source_id: sourceId,
        remote_conversation_id: String(conversationId),
      };
    } else if(brokerOwnsConversation){
      const initialized=await tx(org,async t=>Boolean((await t.query(`SELECT 1 FROM chatwoot_attendance_controls
        WHERE organization_id=$1 AND conversation_id=$2 AND integration_id=$3 AND destination_revision=$4`,[org,message.conversation_id,c.id,attendanceScope.destinationRevision])).rowCount));
      if(!initialized){
        const canonical=await client.attendanceConversation(accountId,Number(map.remote_conversation_id));
        await tx(org,t=>initializeChatwootAttendanceMap(t,attendanceScope,{conversationId:message.conversation_id,remoteConversationId:Number(map!.remote_conversation_id),canonical}));
      }
    }
    let remoteMessageId = context.mappedMessage
      ? Number(context.mappedMessage.remote_message_id)
      : typeof job.payload.remoteMessageId === "number"
        ? job.payload.remoteMessageId
        : undefined;
    if(historical){
      if(message.content.type!=='TEXT'||!['SENT','DELIVERED','READ','FAILED'].includes(message.state))throw new IntegrationError('CHATWOOT_CONTENT_UNSUPPORTED');
      await beforeExternal(job,'IMPORT_HISTORY');
      const importedId=await client.importHistoryMessage(accountId,Number(map.remote_conversation_id),{
        organizationId:org,integrationId:c.id,inboxId,brokerMessageId:message.id,text:message.content.text,incoming:message.direction==='INCOMING',
        occurredAt:Math.floor(message.created_at.getTime()/1000),status:message.state.toLowerCase() as 'sent'|'delivered'|'read'|'failed'});
      if(remoteMessageId&&remoteMessageId!==importedId)throw new IntegrationError('CHATWOOT_HISTORY_RECEIPT_CONFLICT');
      remoteMessageId=importedId;
      await progress(job,{remoteMessageId});
    }
    if (!remoteMessageId) {
      const text =
        message.content.type === "TEXT"
          ? externalObserved?`${originLabel}\n${message.content.text}`:message.content.text
          : message.content.type === "TEMPLATE"
            ? message.content.name
            : undefined;
      if (!text && !media)
        throw new IntegrationError("CHATWOOT_CONTENT_UNSUPPORTED");
      await progress(job, {
        conversationId: Number(map.remote_conversation_id),
      });
      const nativeScope=message.instance_id?{organization_id:org,integration_id:c.id,instance_id:message.instance_id,
        destination_revision:attendanceScope.destinationRevision}:undefined;
      const protocol=await selectLiveMirrorProtocol({client,scope:nativeScope,accountId,inboxId,
        recorded:job.payload.mirrorProtocol,hasPriorAttempt:message.has_mirror_attempt,operation:originalMirrorOperation})
        .catch((error:unknown)=>{
          // A failed capability probe has not sent the message. Keep its job retryable.
          if (job.payload.requiresNativeReceipt === true && !message.has_mirror_attempt && error instanceof ChatwootError)
            throw new IntegrationError('CHATWOOT_NATIVE_RECEIPT_REQUIRED',409);
          throw error;
        });
      if (job.payload.requiresNativeReceipt === true && protocol !== LIVE_INGRESS_PROTOCOL)
        throw new IntegrationError('CHATWOOT_NATIVE_RECEIPT_REQUIRED',409);
      const previousNativeProof=job.payload.liveIngressProof;
      const presentationText=media?(externalObserved?`${originLabel}${message.content.type==='MEDIA'&&message.content.caption?'\n'+message.content.caption:''}`:media.caption??''):text!;
      const nativeBody=protocol===LIVE_INGRESS_PROTOCOL?client.liveIngress().prepare(nativeScope!,{
        broker_message_id:message.id,conversation_id:Number(map.remote_conversation_id),
        message_type:message.direction==='INCOMING'?'incoming':'outgoing',message_origin:externalObserved?'EXTERNAL_OBSERVED':'LIVE',content:presentationText,
        ...(priorNative?.success?(priorNative.data.occurred_at===undefined?{}:{occurred_at:priorNative.data.occurred_at})
          :{occurred_at:Math.floor(message.created_at.getTime()/1000)})},media):undefined;
      await beforeExternal(job, "SEND_MESSAGE");
      let proof:LiveIngressProof|undefined;
      const assertInboxTarget = async (t:TenantTransaction) => {
        if (job.payload.requiresNativeReceipt !== true) return;
        const target = await t.query(`SELECT 1 FROM chatwoot_conversations WHERE organization_id=$1 AND integration_id=$2
          AND conversation_id=$3 AND remote_conversation_id=$4 AND contact_id=$5 AND source_id=$6 FOR SHARE`,
          [org,c.id,message.conversation_id,map!.remote_conversation_id,map!.contact_id,map!.source_id]);
        if (!target.rowCount) throw new IntegrationError('CHATWOOT_LIVE_CONTEXT_CHANGED',409);
        // Capability and media reads occur after claim. Recheck the positive
        // isolation proof before recording a dispatch and before the native POST.
        const isolated = await t.query(`SELECT 1 FROM integration_jobs j
          JOIN chatwoot_connections c ON c.organization_id=j.organization_id AND c.id=j.integration_id
          WHERE j.organization_id=$1 AND j.id=$2 AND j.integration_id=$3 AND j.message_id=$4
            AND (NOT(j.payload ? 'qrObservationId') OR ${firstQrObservation})
            AND (${noUnknown} OR (${independentMirror}))`,[org,job.id,c.id,message.id]);
        if (!isolated.rowCount) throw new IntegrationError('CHATWOOT_MIRROR_ISOLATION_CHANGED',409);
      };
      const started=await tx(org,async t=>{
        await assertChatwootMirrorContext(t,a,c,message.instance_id);
        await assertInboxTarget(t);
        if(previousNativeProof!==undefined){
          const prior=liveIngressProofSchema.safeParse(previousNativeProof);
          if(!prior.success||!nativeBody)throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);
          const rejected=(await t.query<{state:string}>(`SELECT state FROM chatwoot_mirror_attempts a
            WHERE a.organization_id=$1 AND a.id=$2 AND a.job_id=$3 AND a.integration_id=$4 AND a.message_id=$5
              AND a.channel_id=$6 AND a.destination_revision=$7 AND a.account_id=$8 AND a.inbox_id=$9
              AND a.remote_conversation_id=$10 AND a.conversation_id=$11
              AND NOT EXISTS(SELECT 1 FROM chatwoot_mirror_attempts other WHERE other.organization_id=a.organization_id
                AND other.integration_id=a.integration_id AND other.message_id=a.message_id AND other.id<>a.id
                AND other.state IN('DISPATCHED','UNKNOWN')) FOR UPDATE OF a`,
            [org,prior.data.attempt_id,job.id,c.id,message.id,c.channel_id,attendanceScope.destinationRevision,accountId,inboxId,
              Number(map!.remote_conversation_id),message.conversation_id])).rows[0];
          assertRejectedNativeRetry(prior.data,nativeBody,{account_id:accountId,inbox_id:inboxId,
            credential_revision:a.credential_version,base_url:a.base_url},rejected?.state);
        }
        const value=await beginChatwootMirrorAttempt(t,attendanceScope,{jobId:job.id,leaseToken:job.lease_token,messageId:message.id,
          conversationId:message.conversation_id,remoteConversationId:Number(map!.remote_conversation_id)});
        if(nativeBody)proof=liveIngressProofSchema.parse({...liveIngressLookup(nativeBody),attempt_id:value.id,
          account_id:accountId,inbox_id:inboxId,credential_revision:a.credential_version,base_url:a.base_url,
          ...(nativeBody.occurred_at===undefined?{}:{occurred_at:nativeBody.occurred_at})});
        const patch={mirrorProtocol:protocol,...(proof?{liveIngressProof:proof}:{})};
        const saved=await t.query(`UPDATE integration_jobs SET payload=payload||$4::jsonb
          WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>clock_timestamp() RETURNING id`,
          [org,job.id,job.lease_token,JSON.stringify(patch)]);
        if(!saved.rowCount)throw new IntegrationError('INTEGRATION_LEASE_LOST',409);
        return {attempt:value,patch};
      });
      const attempt=started.attempt;Object.assign(job.payload,started.patch);
      const assertCurrent=async(t:TenantTransaction)=>{
        await assertChatwootMirrorContext(t,a,c,message.instance_id);
        await assertInboxTarget(t);
        const lease=await t.query(`SELECT id FROM integration_jobs WHERE organization_id=$1 AND id=$2 AND lease_token=$3
          AND status='RUNNING' AND lease_expires_at>clock_timestamp() FOR UPDATE`,[org,job.id,job.lease_token]);
        if(!lease.rowCount)throw new IntegrationError('INTEGRATION_LEASE_LOST',409);
      };
      const guard=async<T>(_operation:'PERSIST'|'RECEIPT',mutation:boolean,work:()=>Promise<T>)=>{
        await tx(org,assertCurrent);
        const result=await work();
        try{await tx(org,assertCurrent);}
        catch(error){if(mutation)throw new ChatwootError('CHATWOOT_LIVE_CONTEXT_CHANGED',false,true);throw error;}
        return result;
      };
      try { remoteMessageId = nativeBody&&proof
        ?await dispatchNativeLiveMirror({client,body:nativeBody,proof,...(media?{file:media}:{}),guard,
          pin:async value=>{proof=value;await progress(job,{liveIngressProof:value});}})
        :await guard('PERSIST',true,async()=>media
        ? await client.sendMedia(
            accountId,
            Number(map.remote_conversation_id),
            media,
            {
              incoming: message.direction === "INCOMING",
              brokerMessageId: message.id,
              ...(externalObserved?{messageOrigin:'EXTERNAL_OBSERVED' as const}:{}),
              ...(externalObserved?{presentationText}:{}),
            },
          )
        : await client.sendMessage(
            accountId,
            Number(map.remote_conversation_id),
            {
              text: text!,
              incoming: message.direction === "INCOMING",
              brokerMessageId: message.id,
              ...(externalObserved?{messageOrigin:'EXTERNAL_OBSERVED' as const}:{}),
            },
          ));
      } catch(error) {
        try {await tx(org,t=>failChatwootMirrorAttempt(t,attendanceScope,{attemptId:attempt.id,uncertain:!(error instanceof ChatwootError)||error.uncertain}));}
        catch { /* The persisted DISPATCHED attempt stays a barrier. Preserve the original POST outcome. */ }
        throw error;
      }
      try {await tx(org,async t=>{
        await assertCurrent(t);
        await confirmChatwootMirrorAttempt(t,attendanceScope,{attemptId:attempt.id,remoteMessageId:remoteMessageId!});
      });}
      catch {throw new ChatwootError('CHATWOOT_MIRROR_CONFIRMATION_PENDING',false,true);}
      await progress(job, { remoteMessageId });
    }
    await tx(org, (t) =>
      t
        .query(
          `INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id,integration_id,message_id) DO NOTHING`,
          [org, c.id, message.id, remoteMessageId],
        )
        .then(() => undefined),
    );
    if(historical){await finish(job);return;}
    if (
      message.direction === "OUTGOING" &&
      ["SENT", "DELIVERED", "READ", "FAILED"].includes(message.state)
    ) {
      const siblings = await tx(org, (t) =>
        t.query<{ state: string; canonical_error_code: string | null; canonical_message_id:string;provider_message_id:string|null }>(
          `SELECT m.state,m.canonical_error_code,m.id AS canonical_message_id,m.upstream_message_id AS provider_message_id
            FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id
            WHERE cm.organization_id=$1 AND cm.integration_id=$2 AND cm.remote_message_id=$3 ORDER BY m.created_at,m.id`,
          [org, c.id, remoteMessageId],
        ),
      );
      const states = siblings.rows.map((m) => m.state);
      const state = states.includes("FAILED")
        ? "failed"
        : states.some((s) => ["ACCEPTED", "SENDING", "UNKNOWN"].includes(s))
          ? undefined
          : states.every((s) => s === "READ")
            ? "read"
            : states.every((s) => ["READ", "DELIVERED"].includes(s))
              ? "delivered"
              : "sent";
      if (!state) {
        await finish(job);
        return;
      }
      // One central message can represent several attachments. Pin the same
      // canonical representative across their later delivery/read callbacks.
      const representative=siblings.rows[0];
      const proof=representative&&(state==='failed'||representative.provider_message_id)
        ?{version:1 as const,canonical_message_id:representative.canonical_message_id,provider_message_id:representative.provider_message_id,
          state:state.toUpperCase() as 'SENT'|'DELIVERED'|'READ'|'FAILED'}:undefined;
      await beforeExternal(job, "UPDATE_STATUS");
      await client.updateMessageStatus(
        accountId,
        Number(map.remote_conversation_id),
        remoteMessageId,
        state,
        siblings.rows.find((m) => m.canonical_error_code)
          ?.canonical_error_code ?? undefined,
        proof,
      );
    }
    await finish(job);
  }
  const groups=createChatwootGroupWorker(options,{before:beforeExternal,progress,finish});
  const receiptRecovery=createChatwootService(options);
  async function inspectNativeReceipt(org:string){
    const candidate=await tx(org,async t=>{
      if(!(await isOrganizationActive(t,org)))return undefined;
      return(await t.query<{id:string}>(`UPDATE integration_jobs SET available_at=now()+interval '15 seconds'
        WHERE organization_id=$1 AND id=(SELECT id FROM integration_jobs WHERE organization_id=$1 AND status='UNKNOWN'
          AND kind='MIRROR_MESSAGE' AND payload->>'mirrorProtocol'=$2 AND payload ? 'liveIngressProof'
          AND available_at<=now() ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        AND status='UNKNOWN' RETURNING id`,[org,LIVE_INGRESS_PROTOCOL])).rows[0];
    });
    if(!candidate)return;
    try{await receiptRecovery.reconcileJob(org,candidate.id,'NATIVE_PERSISTENCE_RECEIPT_RECOVERED',undefined,undefined,3000);}
    catch{ /* The indexed due time advances; UNKNOWN and original evidence stay intact. No replay. */ }
  }
  async function processJob(org: string, job: Job): Promise<void> {
    try {
      if (job.kind === "CHATWOOT_REPLY") await receiveReply(job);
      else await mirror(job);
    } catch (error) {
      const idempotentHistory=job.payload.historical===true&&job.payload.operation==='IMPORT_HISTORY';
      const uncertain = !idempotentHistory&&
        job.kind === "MIRROR_MESSAGE" &&
        (!(error instanceof IntegrationError) ||
          error.code === "INTEGRATION_LEASE_LOST") &&
        !(error instanceof MediaError) &&
        (!(error instanceof ChatwootError) || error.uncertain);
      const retry =
        (error instanceof IntegrationError &&
            ['INTEGRATION_PAUSED', 'IDENTITY_UNVERIFIED', 'IDENTITY_CONFIRMATION_REQUIRED', 'CHATWOOT_NATIVE_RECEIPT_REQUIRED'].includes(error.code)) ||
        ((error instanceof ChatwootError || error instanceof MediaError) &&
          error.retrySafe &&
          job.attempts < 6);
      const code =
        error instanceof IntegrationError ||
        error instanceof ChatwootError ||
        error instanceof MediaError ||
        error instanceof MessagingRepositoryError
          ? error.code
          : "INTEGRATION_PROCESSING_FAILED";
      const failureDiagnostic=createJobFailureDiagnostic(error,job.attempts,uncertain?'UNKNOWN':retry?'RETRY_SCHEDULED':'FAILED');
      await tx(org, (t) =>
        t
          .query(
            `UPDATE integration_jobs SET status=$4,last_error=$5,failure_diagnostic=$7::jsonb,lease_token=NULL,lease_expires_at=NULL,
        available_at=now()+($6*interval '1 second'),updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3`,
            [
              org,
              job.id,
              job.lease_token,
              uncertain ? "UNKNOWN" : retry ? job.payload.historical===true ? 'HISTORY_PENDING' : "PENDING" : "FAILED",
              code,
              Math.min(300, 5 * 2 ** Math.min(job.attempts, 6)),
              JSON.stringify(failureDiagnostic),
            ],
          )
          .then(() => undefined),
      );
    }
  }
  return {
    async runOnce(org: string, continuous = false): Promise<void> {
      await inspectNativeReceipt(org);
      // Amortize the other provider polls, but yield to other tenants after
      // a slow request. Every claim retains its original order and lease.
      const deadline = performance.now() + 5000;
      const limit = continuous ? 4 : 1;
      for (let count = 0; count < limit; count++) {
        const job = await claim(org);
        if (!job) break;
        await processJob(org, job);
        if (performance.now() >= deadline) break;
      }
    },
  };
}
