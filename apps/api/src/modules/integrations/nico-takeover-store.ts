import type { NicoTakeoverSnapshot } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import { readChatwootAccount } from './chatwoot-context.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { IntegrationError } from './integration-error.js';

export type TakeoverSnapshot = NicoTakeoverSnapshot & {
  origin: string; executor: string; remoteBinding: string | null; transport: string;
  bindingId: string | null; bindingRevision: number | null; controlState: string | null;
};
export type TakeoverRow = {
  id: string; organization_id: string; integration_id: string; channel_id: string; conversation_id: string;
  remote_conversation_id: string; request_id: string; external_actor_id: string; api_key_id: string;
  fingerprint: string; request_body: unknown; snapshot: TakeoverSnapshot;
  state: 'OPEN' | 'COMPLETED' | 'CANCELED'; message_id: string | null;
};
export async function assertTakeoverExecutorSettled(tx: TenantTransaction, org: string, channel: string) {
  const pending = await tx.query(`SELECT 1 FROM flow_executor_cutovers WHERE organization_id=$1 AND channel_id=$2
      AND (phase NOT IN ('ACTIVATED','ROLLED_BACK') OR lease_token IS NOT NULL)
    UNION ALL SELECT 1 FROM central_cutover_operations WHERE organization_id=$1 AND channel_id=$2 AND status NOT IN ('COMPLETE','ROLLED_BACK','CANCELED')
    UNION ALL SELECT 1 FROM flow_chatwoot_bindings b JOIN chatwoot_connections c ON c.organization_id=b.organization_id AND c.inbox_id=b.inbox_id
      WHERE b.organization_id=$1 AND c.channel_id=$2 AND (b.status<>'DISABLED' OR b.operation_state<>'IDLE') LIMIT 1`, [org,channel]);
  if (pending.rowCount) throw new IntegrationError('NICO_TAKEOVER_EXECUTOR_UNSETTLED',409);
}
export async function captureTakeover(tx: TenantTransaction, p: ChatwootControlPrincipal, integration: string, remote: number) {
  const org = p.organizationId;
  const mapping = (await tx.query<{ channel_id: string }>(`SELECT channel_id FROM chatwoot_connections
    WHERE organization_id=$1 AND id=$2`, [org, integration])).rows[0];
  if (!mapping) throw new IntegrationError('NICO_TAKEOVER_CONVERSATION_NOT_FOUND', 404);
  await lockAttendanceChannel(tx, org, mapping.channel_id);
  const row = (await tx.query<{
    channel_id: string; conversation_id: string; contact_id: string; inbox_id: string; account_id: string; revision: number;
    attendance_revision: number; control_revision: number | null; control_state: string | null; mode: 'BOT' | 'HUMAN';
    credential_version: number; owner_revision: number; executor: string; remote_binding_id: string | null; transport: string;
    binding_id: string | null; binding_revision: number | null; control_scope: boolean;
  }>(`SELECT c.channel_id,map.conversation_id,map.contact_id,c.inbox_id,a.account_id,d.revision,a.credential_version,
    m.mode,m.attendance_revision,cc.revision AS control_revision,cc.state AS control_state,
    coalesce(o.revision,0) AS owner_revision,coalesce(o.executor,'NONE') AS executor,o.remote_binding_id,ch.transport,
    b.id AS binding_id,b.revision AS binding_revision,
    (cc.conversation_id IS NULL OR (cc.integration_id=c.id AND cc.account_id=a.account_id AND cc.inbox_id=c.inbox_id
      AND cc.destination_revision=d.revision AND cc.remote_conversation_id=map.remote_conversation_id)) AS control_scope
    FROM chatwoot_connections c JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    JOIN chatwoot_conversations map ON map.organization_id=c.organization_id AND map.integration_id=c.id
    JOIN messaging_conversations m ON m.organization_id=map.organization_id AND m.id=map.conversation_id AND m.channel_id=c.channel_id
    JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
    LEFT JOIN attendance_owners o ON o.organization_id=c.organization_id AND o.channel_id=c.channel_id
    LEFT JOIN automation_bindings b ON b.organization_id=c.organization_id AND b.channel_id=c.channel_id AND b.status IN ('ACTIVE','PAUSED')
    LEFT JOIN chatwoot_attendance_controls cc ON cc.organization_id=m.organization_id AND cc.conversation_id=m.id
    WHERE c.organization_id=$1 AND c.id=$2 AND map.remote_conversation_id=$3
      AND c.status='READY' AND a.status='READY' AND d.approval_status='APPROVED' AND ch.deleting_at IS NULL
    FOR SHARE OF c,a,d,map`, [org, integration, remote])).rows[0];
  if (!row) throw new IntegrationError('NICO_TAKEOVER_CONVERSATION_NOT_FOUND', 404);
  if (Number(row.account_id) !== p.accountId || row.revision !== p.destinationRevision || !row.control_scope)
    throw new IntegrationError('NICO_TAKEOVER_CONTEXT_CHANGED', 409);
  const account = await readChatwootAccount(tx, org);
  if (!account || account.base_url !== p.chatwootOrigin) throw new IntegrationError('NICO_TAKEOVER_CONTEXT_CHANGED', 409);
  const snapshot: TakeoverSnapshot = {
    organizationId: org, integrationId: integration, channelId: row.channel_id, conversationId: row.conversation_id,
    accountId: Number(row.account_id), inboxId: Number(row.inbox_id), remoteConversationId: remote, remoteContactId: Number(row.contact_id),
    ownerRevision: row.owner_revision, attendanceRevision: row.attendance_revision, controlRevision: row.control_revision ?? row.attendance_revision,
    destinationRevision: row.revision, credentialRevision: row.credential_version, mode: row.mode,
    origin: account.base_url, executor: row.executor, remoteBinding: row.remote_binding_id, transport: row.transport,
    bindingId: row.binding_id, bindingRevision: row.binding_revision, controlState: row.control_state,
  };
  return { snapshot, account };
}

/** Only markers persisted before remote I/O prove that cancellation is safe. */
export async function cancelUndispatchedTakeoverWork(tx: TenantTransaction, org: string, conversation: string) {
  const args = [org, conversation];
  await tx.query(`UPDATE attendance_resume_operations SET state='CANCELED',lease_token=null,lease_expires_at=null,
    last_error='NICO_TAKEOVER',updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND state='PENDING' AND phase='PREPARED'`, args);
  await tx.query(`WITH stopped AS (UPDATE attendance_handoff_operations SET state='ACTION_REQUIRED',last_error='NICO_TAKEOVER',updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND phase='PREPARED' AND state IN ('PENDING','UNKNOWN') RETURNING outbox_id)
    UPDATE automation_outbox SET status='CANCELED',last_error='NICO_TAKEOVER',updated_at=now()
    WHERE organization_id=$1 AND id IN (SELECT outbox_id FROM stopped) AND status IN ('PENDING','SENDING','UNKNOWN')`, args);
  await tx.query(`UPDATE chatwoot_mirror_attempts SET state='REJECTED',error_code='NICO_TAKEOVER',updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND state='RESERVED'`, args);
  await tx.query(`WITH stopped AS (UPDATE automation_conversation_effects SET state='REJECTED',updated_at=now()
    WHERE organization_id=$1 AND conversation_id=$2 AND state='PREPARED' RETURNING outbox_id)
    UPDATE automation_outbox SET status='CANCELED',last_error='NICO_TAKEOVER',updated_at=now()
    WHERE organization_id=$1 AND id IN (SELECT outbox_id FROM stopped) AND status IN ('PENDING','SENDING')`, args);
}

/** In-flight/uncertain effects are never converted into successful cancellation. */
export async function takeoverHasUnsettledWork(tx: TenantTransaction, org: string, conversation: string) {
  const result = await tx.query(`SELECT 1 FROM automation_outbox x JOIN automation_executions e ON e.organization_id=x.organization_id AND e.id=x.execution_id
      WHERE e.organization_id=$1 AND e.conversation_id=$2 AND x.status IN ('SENDING','UNKNOWN')
    UNION ALL SELECT 1 FROM messaging_messages WHERE organization_id=$1 AND conversation_id=$2 AND source='AUTOMATION' AND state IN ('SENDING','UNKNOWN')
    UNION ALL SELECT 1 FROM messaging_bot_jobs WHERE organization_id=$1 AND conversation_id=$2 AND status IN ('RUNNING','UNKNOWN')
    UNION ALL SELECT 1 FROM chatwoot_mirror_attempts a JOIN messaging_messages m ON m.organization_id=a.organization_id AND m.id=a.message_id
      WHERE a.organization_id=$1 AND a.conversation_id=$2 AND a.state IN ('DISPATCHED','UNKNOWN') AND m.source='AUTOMATION'
    UNION ALL SELECT 1 FROM chatwoot_attendance_observations WHERE organization_id=$1 AND conversation_id=$2 AND disposition IN ('ECHO_PENDING','RECONCILE')
    UNION ALL SELECT 1 FROM attendance_handoff_operations WHERE organization_id=$1 AND conversation_id=$2 AND phase<>'PREPARED' AND state IN ('PENDING','UNKNOWN','ACTION_REQUIRED')
    UNION ALL SELECT 1 FROM attendance_resume_operations WHERE organization_id=$1 AND conversation_id=$2 AND phase<>'PREPARED' AND state IN ('PENDING','UNKNOWN','ACTION_REQUIRED')
    UNION ALL SELECT 1 FROM qr_dispatch_attempts a JOIN messaging_messages m ON m.organization_id=a.organization_id AND m.id=a.message_id
      WHERE a.organization_id=$1 AND a.conversation_id=$2 AND a.state IN ('DISPATCHED','UNKNOWN') AND m.source='AUTOMATION'
    UNION ALL SELECT 1 FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2 AND blocking
    UNION ALL SELECT 1 FROM automation_conversation_effects WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN')
    LIMIT 1`, [org, conversation]);
  return Boolean(result.rowCount);
}
