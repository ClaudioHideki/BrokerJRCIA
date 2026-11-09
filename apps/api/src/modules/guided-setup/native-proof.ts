import { z } from 'zod';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { ChannelFacade } from '../channels/facade.js';
import { resolveAttendanceScope } from '../attendance/repository.js';
import type { SetupRecord } from './repository.js';
import type { SetupPrincipal } from './service.js';
import { setupFail } from './service.js';

const evidenceRow = z.strictObject({ executionId: z.uuid(), scopeMatches: z.boolean(), entryReceived: z.boolean(),
  selectionsReceived: z.boolean(), botDelivered: z.boolean(), mirrorConfirmed: z.boolean(),
  handoffConfirmed: z.boolean(), humanPaused: z.boolean(), unresolvedEffects: z.boolean() });
interface NativeProofOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  channels: Pick<ChannelFacade, 'get'>;
}
export function createNativeSetupProofReader(options: NativeProofOptions) {
  return async (principal: SetupPrincipal, record: SetupRecord, executionId?: string) => {
    const org = principal.organizationId, test = record.testContext;
    if (record.organizationId !== org) return setupFail('SCOPE_MISMATCH');
    if (!test?.automationId || !test.version || !record.selection.channelId || !record.selection.integrationId || test.ownerRevision === null)
      return setupFail('TEST_REQUIRED');
    const channel = await options.channels.get(org, record.selection.channelId);
    if (channel.organizationId !== org || !channel.messagingChannelId) return setupFail('CHANNEL_SCOPE_MISMATCH');
    return options.transact(org, async tx => {
      const scope = await resolveAttendanceScope(tx, org, channel.messagingChannelId!);
      if (!scope || scope.integrationId !== record.selection.integrationId) return setupFail('DESTINATION_SCOPE_MISMATCH');
      const result = await tx.query<z.infer<typeof evidenceRow>>(`WITH selected AS (
        SELECT e.* FROM automation_executions e JOIN automation_events entry
          ON entry.organization_id=e.organization_id AND entry.execution_id=e.id AND entry.event_key=e.trigger_event_key
        WHERE e.organization_id=$1 AND e.channel_id=$2 AND e.automation_id=$3 AND e.version=$4
          AND e.started_at>=$5::timestamptz AND ($6::uuid IS NULL OR e.id=$6)
          AND entry.type='MESSAGE' AND entry.status='CONSUMED'
          AND lower(btrim(entry.payload->>'text'))=lower(btrim($7::text))
          AND coalesce(entry.payload->>'historical','false')<>'true'
        ORDER BY e.started_at DESC,e.id DESC LIMIT 1
      ) SELECT e.id AS "executionId",
        EXISTS(SELECT 1 FROM attendance_sessions s WHERE s.organization_id=e.organization_id AND s.execution_id=e.id
          AND s.channel_id=e.channel_id AND s.conversation_id=e.conversation_id AND s.automation_id=e.automation_id AND s.version=e.version
          AND s.integration_id=$8 AND s.destination_revision=$9 AND s.account_id=$10 AND s.inbox_id=$11 AND s.owner_revision=$12) AS "scopeMatches",
        EXISTS(SELECT 1 FROM messaging_messages m WHERE m.organization_id=e.organization_id AND m.channel_id=e.channel_id
          AND m.conversation_id=e.conversation_id AND m.direction='INCOMING' AND m.source='CONTACT'
          AND m.upstream_message_id IS NOT NULL AND m.created_at>=$5::timestamptz
          AND lower(btrim(m.content->>'text'))=lower(btrim($7::text))) AS "entryReceived",
        (SELECT count(*)>=2 FROM automation_events ev WHERE ev.organization_id=e.organization_id AND ev.execution_id=e.id
          AND ev.type='MESSAGE' AND ev.status='CONSUMED' AND coalesce(ev.payload->>'historical','false')<>'true') AS "selectionsReceived",
        EXISTS(SELECT 1 FROM automation_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id::text=o.remote_reference
          WHERE o.organization_id=e.organization_id AND o.execution_id=e.id AND o.kind='SEND_TEXT' AND o.status='SENT'
          AND m.channel_id=e.channel_id AND m.conversation_id=e.conversation_id AND m.direction='OUTGOING' AND m.source='AUTOMATION'
          AND m.state IN ('DELIVERED','READ') AND m.upstream_message_id IS NOT NULL) AS "botDelivered",
        (EXISTS(SELECT 1 FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id
          WHERE cm.organization_id=e.organization_id AND cm.integration_id=$8 AND m.conversation_id=e.conversation_id
          AND m.channel_id=e.channel_id AND m.direction='INCOMING' AND m.created_at>=$5::timestamptz)
        AND EXISTS(SELECT 1 FROM chatwoot_messages cm JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id
          JOIN automation_outbox o ON o.organization_id=m.organization_id AND o.remote_reference=m.id::text AND o.execution_id=e.id
          WHERE cm.organization_id=e.organization_id AND cm.integration_id=$8 AND m.channel_id=e.channel_id
          AND m.conversation_id=e.conversation_id AND o.kind='SEND_TEXT' AND o.status='SENT')) AS "mirrorConfirmed",
        EXISTS(SELECT 1 FROM attendance_handoff_operations h WHERE h.organization_id=e.organization_id AND h.execution_id=e.id
          AND h.channel_id=e.channel_id AND h.conversation_id=e.conversation_id AND h.integration_id=$8
          AND h.state='APPLIED' AND h.phase='CONFIRMED' AND h.confirmed_by IS NOT NULL
          AND h.snapshot#>>'{scope,accountId}'=$10::text AND h.snapshot#>>'{scope,inboxId}'=$11::text
          AND h.snapshot#>>'{scope,destinationRevision}'=$9::text) AS "handoffConfirmed",
        EXISTS(SELECT 1 FROM attendance_sessions s JOIN messaging_conversations c ON c.organization_id=s.organization_id AND c.id=s.conversation_id
          WHERE s.organization_id=e.organization_id AND s.execution_id=e.id AND s.channel_id=e.channel_id AND s.owner_revision=$12
          AND s.state='HUMAN_ACTIVE' AND c.mode='HUMAN' AND s.integration_id=$8 AND s.account_id=$10 AND s.inbox_id=$11) AS "humanPaused",
        (e.status IN ('QUEUED','RUNNING','WAITING','UNKNOWN','FAILED') OR EXISTS(SELECT 1 FROM automation_outbox o
          WHERE o.organization_id=e.organization_id AND o.execution_id=e.id AND o.status IN ('PENDING','SENDING','UNKNOWN'))) AS "unresolvedEffects"
        FROM selected e`, [org, channel.messagingChannelId, test.automationId, test.version, test.startedAt,
        executionId ?? null, test.keyword, scope.integrationId, scope.destinationRevision, scope.accountId, scope.inboxId, test.ownerRevision]);
      if (!result.rows[0]) return setupFail('TEST_INPUT_NOT_RECEIVED', 409);
      const { executionId: selectedExecution, ...evidence } = evidenceRow.parse(result.rows[0]);
      return { executionId: selectedExecution, evidence };
    });
  };
}
