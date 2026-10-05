import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { ChatwootAttendanceEvent } from '../integrations/chatwoot-attendance-events.js';
import type { ChatwootObservationScope } from '../integrations/chatwoot-attendance-store.js';

/** Expected non-human transitions remain blocked. This hook never forgives human messages/assignments or authorizes BOT. */
export async function isExpectedResumeControl(tx:TenantTransaction,s:ChatwootObservationScope,event:ChatwootAttendanceEvent,control:{conversation_id:string;revision:number}) {
  if(event.kind!=='CONVERSATION_CONTROL'||event.assignee.kind!=='NONE'||event.remoteUpdatedAt===null)return false;
  const row=(await tx.query<{phase:string;snapshot:Record<string,unknown>}>(`SELECT r.phase,r.snapshot FROM attendance_resume_operations r
    JOIN messaging_conversations m ON m.organization_id=r.organization_id AND m.id=r.conversation_id
    JOIN attendance_owners own ON own.organization_id=r.organization_id AND own.channel_id=r.channel_id
    JOIN automation_bindings b ON b.organization_id=r.organization_id AND b.id=(r.snapshot->>'bindingId')::uuid
    JOIN chatwoot_accounts a ON a.organization_id=r.organization_id
    JOIN chatwoot_connections c ON c.organization_id=r.organization_id AND c.id=$3 AND c.channel_id=r.channel_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    WHERE r.organization_id=$1 AND r.conversation_id=$2 AND r.state='PENDING' AND r.phase IN ('CLEAR_AGENT','CLEAR_TEAM','PENDING_STATUS','READBACK')
      AND r.lease_expires_at>now() AND m.mode='HUMAN' AND m.attendance_revision=(r.snapshot->>'localRevision')::int
      AND (r.snapshot->>'controlRevision')::int=$4 AND own.revision=(r.snapshot->>'ownerRevision')::int AND own.executor='BROKER'
      AND b.revision=(r.snapshot->>'bindingRevision')::int AND b.status='ACTIVE' AND a.credential_version=$5 AND a.status='READY'
      AND c.status='READY' AND d.approval_status='APPROVED' AND d.revision=$6 AND a.account_id=$7 AND c.inbox_id=$8
      AND a.base_url=r.snapshot->>'origin' AND (r.snapshot->>'remoteConversationId')::bigint=$9
      AND r.snapshot->'scope'->>'integrationId'=$3::text LIMIT 1`,
    [s.organizationId,control.conversation_id,s.integrationId,control.revision,s.credentialRevision,s.destinationRevision,s.accountId,s.inboxId,event.remoteConversationId])).rows[0];
  if(!row||typeof row.snapshot.originalRemoteUpdatedAt!=='number'||event.remoteUpdatedAt<=row.snapshot.originalRemoteUpdatedAt)return false;
  const expectedTeam=row.snapshot.originalTeamId;
  return (event.status===row.snapshot.originalStatus||event.status==='pending')&&
    (event.teamId===null||event.teamId===expectedTeam&&(row.phase==='CLEAR_AGENT'||row.phase==='CLEAR_TEAM'));
}
