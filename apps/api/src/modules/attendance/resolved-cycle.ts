import type {TenantTransaction} from '../../db/tenant-transaction.js';
import {lockAttendanceChannel} from './repository.js';
import {SUPERSEDED_PHYSICAL_CYCLE_PREFIX} from './conversation-cycle-fence.js';

// Closing a physical cycle never resumes it, sends text, changes a JRC assignee,
// or replays a queued message. The next live ingress creates its own conversation.
const eligible=`SELECT m.id,m.channel_id,co.integration_id,co.remote_conversation_id
 FROM messaging_conversations m
 JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id
 JOIN organizations tenant ON tenant.id=c.organization_id AND tenant.status='ACTIVE'
 JOIN flow_features feature ON feature.organization_id=c.organization_id AND feature.enabled
 JOIN attendance_owners own ON own.organization_id=c.organization_id AND own.channel_id=c.id AND own.executor='BROKER' AND own.remote_binding_id IS NULL
 JOIN automation_bindings b ON b.organization_id=c.organization_id AND b.channel_id=c.id AND b.status='ACTIVE'
  AND b.automation_id=own.automation_id AND b.version=own.version
 JOIN automation_definitions definition ON definition.organization_id=b.organization_id AND definition.id=b.automation_id AND definition.lifecycle_status='PUBLISHED'
 JOIN automation_versions v ON v.organization_id=b.organization_id AND v.automation_id=b.automation_id AND v.version=b.version
 JOIN chatwoot_attendance_controls co ON co.organization_id=m.organization_id AND co.conversation_id=m.id AND co.channel_id=c.id
 JOIN chatwoot_conversations cm ON cm.organization_id=co.organization_id AND cm.conversation_id=m.id
  AND cm.integration_id=co.integration_id AND cm.remote_conversation_id=co.remote_conversation_id
 JOIN chatwoot_connections connection ON connection.organization_id=co.organization_id AND connection.id=co.integration_id
  AND connection.channel_id=c.id AND connection.inbox_id=co.inbox_id AND connection.status='READY'
 JOIN chatwoot_accounts account ON account.organization_id=co.organization_id AND account.account_id=co.account_id AND account.status='READY'
 JOIN chatwoot_destinations destination ON destination.organization_id=account.organization_id AND destination.base_url=account.base_url
  AND destination.revision=co.destination_revision AND destination.approval_status='APPROVED'
 JOIN chatwoot_attendance_observations observation ON observation.organization_id=co.organization_id AND observation.id=co.last_observation_id
  AND observation.integration_id=co.integration_id AND observation.channel_id=c.id AND observation.conversation_id=m.id
  AND observation.account_id=co.account_id AND observation.inbox_id=co.inbox_id AND observation.destination_revision=co.destination_revision
  AND observation.credential_revision=account.credential_version AND observation.remote_conversation_id=co.remote_conversation_id
 WHERE m.organization_id=$1 AND ($2::uuid IS NULL OR m.id=$2) AND m.remote_conversation_key IS NULL
  AND c.transport='BROKER_TRANSPORT' AND c.deleting_at IS NULL AND m.recipient_kind='INDIVIDUAL' AND m.mode='HUMAN'
  AND c.bot_public_id=b.automation_id::text AND c.bot_origin_reference='jrc-automation-v2'
  AND observation.disposition='APPLIED' AND observation.event->>'kind'='CONVERSATION_CONTROL' AND observation.event->>'status'='resolved'
  AND observation.event->>'remoteUpdatedAt' IS NOT NULL
  AND (observation.event->>'remoteUpdatedAt')::double precision=co.observed_remote_updated_at
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.graph->'nodes') node WHERE node->>'type'='start'
   AND node->'data'->>'entryConfigVersion'='1' AND node->'data'->>'reentry'='ALWAYS' AND node->'data'->>'restartAfterResolution'='true')
  AND NOT EXISTS(SELECT 1 FROM messaging_messages pending WHERE pending.organization_id=m.organization_id AND pending.conversation_id=m.id
   AND pending.direction='OUTGOING' AND pending.state IN ('ACCEPTED','SENDING','UNKNOWN'))
  AND NOT EXISTS(SELECT 1 FROM messaging_bot_jobs job WHERE job.organization_id=m.organization_id AND job.conversation_id=m.id AND job.status IN ('RUNNING','UNKNOWN'))
  AND NOT EXISTS(SELECT 1 FROM integration_jobs job LEFT JOIN messaging_messages message ON message.organization_id=job.organization_id AND message.id=job.message_id
   WHERE job.organization_id=m.organization_id AND job.integration_id=co.integration_id AND job.status IN ('PENDING','RUNNING','UNKNOWN')
    AND (message.conversation_id=m.id OR job.payload->>'conversationId'=co.remote_conversation_id::text))
  AND NOT EXISTS(SELECT 1 FROM attendance_handoff_operations operation WHERE operation.organization_id=m.organization_id AND operation.conversation_id=m.id
   AND (operation.state IN ('PENDING','UNKNOWN') OR operation.state='ACTION_REQUIRED' AND operation.phase<>'PREPARED'))
  AND NOT EXISTS(SELECT 1 FROM attendance_resume_operations operation WHERE operation.organization_id=m.organization_id AND operation.conversation_id=m.id
   AND (operation.state IN ('PENDING','UNKNOWN') OR operation.state='ACTION_REQUIRED' AND operation.phase<>'PREPARED'))
  AND NOT EXISTS(SELECT 1 FROM nico_takeover_operations operation WHERE operation.organization_id=m.organization_id AND operation.conversation_id=m.id AND operation.state='OPEN')`;

type Cycle={id:string;channel_id:string;integration_id:string;remote_conversation_id:string};
export async function settleResolvedPhysicalCycles(tx:TenantTransaction,org:string,conversationId?:string):Promise<number>{
 const candidates=(await tx.query<Cycle>(`${eligible} ORDER BY m.channel_id,m.id LIMIT 25`,[org,conversationId??null])).rows;
 let closed=0;
 for(const candidate of candidates){
  await lockAttendanceChannel(tx,org,candidate.channel_id);
  const row=(await tx.query<Cycle>(`${eligible} FOR UPDATE OF m,co`,[org,candidate.id])).rows[0];
  if(!row)continue;
  await tx.query(`UPDATE messaging_conversations SET remote_conversation_key=$3,attendance_revision=attendance_revision+1,updated_at=now()
   WHERE organization_id=$1 AND id=$2 AND remote_conversation_key IS NULL`,[org,row.id,`${SUPERSEDED_PHYSICAL_CYCLE_PREFIX}${row.integration_id}:${row.remote_conversation_id}`]);
  await tx.query("UPDATE attendance_sessions SET state='RESOLVED',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND state<>'RESOLVED'",[org,row.id]);
  await tx.query("UPDATE automation_executions SET status='COMPLETED',completed_at=coalesce(completed_at,now()),updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND status='HANDOFF'",[org,row.id]);
  closed++;
 }
 return closed;
}
