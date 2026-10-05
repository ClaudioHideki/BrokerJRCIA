import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { ChatwootAttendanceEvent } from '../integrations/chatwoot-attendance-events.js';
import type { ChatwootObservationScope } from '../integrations/chatwoot-attendance-store.js';

type Control={conversation_id:string;remote_conversation_id:string|null;cycle:number;revision:number};
/**
 * Expected state, not proof of who opened the conversation. Stock Chatwoot has
 * no write correlation token/CAS. A delayed opening callback can be expected
 * until assignment completes, only under the original control revision and
 * current lease. Never suppress a human message or assignment.
 */
export async function isExpectedHandoffOpening(tx:TenantTransaction,s:ChatwootObservationScope,event:ChatwootAttendanceEvent,control:Control):Promise<boolean>{
  if(event.kind!=='CONVERSATION_CONTROL'||event.status!=='open'||event.assignee.kind!=='NONE'||event.teamId!==null||
    control.remote_conversation_id===null||Number(control.remote_conversation_id)!==event.remoteConversationId)return false;
  const result=await tx.query(`SELECT h.id FROM attendance_handoff_operations h
    JOIN automation_outbox o ON o.organization_id=h.organization_id AND o.id=h.outbox_id
    JOIN automation_executions e ON e.organization_id=h.organization_id AND e.id=h.execution_id
    JOIN automation_bindings b ON b.organization_id=e.organization_id AND b.id=e.binding_id
    JOIN attendance_owners owner ON owner.organization_id=h.organization_id AND owner.channel_id=h.channel_id
    JOIN chatwoot_connections c ON c.organization_id=h.organization_id AND c.id=h.integration_id
    JOIN chatwoot_accounts a ON a.organization_id=h.organization_id
    JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
    WHERE h.organization_id=$1 AND h.channel_id=$2 AND h.conversation_id=$3
      AND h.phase IN ('OPEN_DISPATCHED','OPENED','ASSIGNMENT_DISPATCHED') AND h.state IN ('PENDING','UNKNOWN')
      AND o.status='UNKNOWN' AND o.lease_token=h.lease_token AND o.lease_expires_at>now()
      AND e.status='HANDOFF' AND b.status IN ('ACTIVE','PAUSED')
      AND b.id::text=h.snapshot->>'bindingId' AND b.revision=(h.snapshot->>'bindingRevision')::int
      AND owner.executor='BROKER' AND owner.remote_binding_id IS NULL
      AND owner.revision=(h.snapshot->>'ownerRevision')::int
      AND owner.automation_id=e.automation_id AND owner.version=e.version
      AND c.status='READY' AND a.status='READY' AND d.approval_status='APPROVED'
      AND c.channel_id=h.channel_id AND c.id=$4 AND d.revision=$5 AND a.account_id=$6 AND c.inbox_id=$7
      AND a.credential_version=$8 AND a.base_url=h.snapshot->>'origin'
      AND h.snapshot->'scope'->>'organizationId'=$1::text
      AND h.snapshot->'scope'->>'channelId'=$2::text
      AND h.snapshot->'scope'->>'integrationId'=$4::text
      AND (h.snapshot->'scope'->>'destinationRevision')::int=$5
      AND (h.snapshot->'scope'->>'accountId')::bigint=$6
      AND (h.snapshot->'scope'->>'inboxId')::bigint=$7
      AND (h.snapshot->>'credentialRevision')::int=$8
      AND (h.snapshot->>'remoteConversationId')::bigint=$9
      AND (h.snapshot->>'cycle')::int=$10 AND (h.snapshot->>'controlRevision')::int=$11
      AND NOT EXISTS(SELECT 1 FROM attendance_sessions session WHERE session.organization_id=h.organization_id
        AND session.conversation_id=h.conversation_id AND session.cycle=(h.snapshot->>'cycle')::int AND session.state IN ('HUMAN_ACTIVE','ADMIN_PAUSED','RESOLVED'))
    LIMIT 1`,[s.organizationId,s.channelId,control.conversation_id,s.integrationId,s.destinationRevision,s.accountId,s.inboxId,s.credentialRevision,event.remoteConversationId,control.cycle,control.revision]);
  return Boolean(result.rowCount);
}
