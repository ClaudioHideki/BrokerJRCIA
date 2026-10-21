import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { IntegrationError } from './integration-error.js';

type Scope = { organizationId: string; accountId: number; destinationRevision: number };
type TransportRow = { inbox_id: string; instance_id: string; transport: string; executor: string | null; status: string; instance_status: string;
  identity_ready: boolean; callback_ready: boolean; identity_revision: number; observed_last4: string | null };
const protocol = 'chatwoot-campaigns/v1' as const;

// Read-only evidence: never selects an executor, grants access, refreshes a provider or sends a message.
// The control facade must revalidate its principal and binding in this same tenant transaction.
export async function readCampaignTransport(t: TenantTransaction, p: Scope, id: string) {
  const row = (await t.query<TransportRow>(`SELECT c.inbox_id,ch.instance_id,ch.transport,o.executor,c.status,i.status AS instance_status,
    coalesce(h.identity_enforced AND h.observed_connected AND h.approved_fingerprint=h.observed_fingerprint
      AND h.approved_fingerprint IS NOT NULL AND h.identity_error IS NULL AND h.access_error IS NULL
      AND h.observed_at>now()-interval '90 seconds',false) AS identity_ready,
    coalesce(h.callback_verified_at IS NOT NULL AND h.callback_destination_revision=$4 AND h.callback_credential_version=a.credential_version,false) AS callback_ready,
    coalesce(h.identity_revision,0) AS identity_revision,h.observed_last4
    FROM chatwoot_connections c JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
    JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id AND i.archived_at IS NULL
    JOIN chatwoot_accounts a ON a.organization_id=c.organization_id AND a.account_id=$3 AND a.status='READY'
    LEFT JOIN attendance_owners o ON o.organization_id=c.organization_id AND o.channel_id=c.channel_id AND o.integration_id=c.id
    LEFT JOIN chatwoot_connection_health h ON h.organization_id=c.organization_id AND h.integration_id=c.id
    WHERE c.organization_id=$1 AND c.id=$2 AND ch.deleting_at IS NULL AND ch.provider='BAILEYS'`,
  [p.organizationId,id,p.accountId,p.destinationRevision])).rows[0];
  if (!row) throw new IntegrationError('CAMPAIGN_BINDING_NOT_FOUND',404);
  const reason = row.transport!=='BROKER_TRANSPORT' ? 'CAMPAIGN_BROKER_TRANSPORT_REQUIRED'
    : row.executor!=='EXTERNAL' ? 'CAMPAIGN_EXECUTOR_EXTERNAL_REQUIRED'
    : row.status!=='READY' || !row.callback_ready ? 'CAMPAIGN_CALLBACK_NOT_READY'
    : row.instance_status!=='CONNECTED' || !row.identity_ready ? 'CAMPAIGN_IDENTITY_NOT_READY' : null;
  return { protocol,integrationId:id,inboxId:Number(row.inbox_id),instanceId:row.instance_id,destinationRevision:p.destinationRevision,
    identityRevision:row.identity_revision,numberSuffix:row.observed_last4,ready:reason===null,reason };
}

export async function readCampaignReceipt(t: TenantTransaction,p: Scope,id: string,conversationId: number,messageId: number) {
  const rows = (await t.query<{state:string|null;disposition?:string;job_status?:string|null}>(`SELECT m.state,o.disposition,j.status AS job_status
    FROM chatwoot_attendance_observations o
    LEFT JOIN chatwoot_messages cm ON cm.organization_id=o.organization_id AND cm.integration_id=o.integration_id AND cm.remote_message_id=$6
    LEFT JOIN messaging_messages m ON m.organization_id=cm.organization_id AND m.id=cm.message_id AND m.channel_id=o.channel_id AND m.direction='OUTGOING'
    LEFT JOIN chatwoot_conversations cc ON cc.organization_id=o.organization_id AND cc.integration_id=o.integration_id
      AND cc.conversation_id=m.conversation_id AND cc.remote_conversation_id=$5
    LEFT JOIN integration_jobs j ON j.organization_id=o.organization_id AND j.integration_id=o.integration_id AND j.kind='CHATWOOT_REPLY'
      AND j.payload->>'attendanceObservationId'=o.id::text
    WHERE o.organization_id=$1 AND o.integration_id=$2 AND o.account_id=$3 AND o.destination_revision=$4
      AND o.remote_conversation_id=$5 AND o.event->>'remoteMessageId'=$6::text AND o.event->>'kind'='AUTOMATED_REPLY'
      AND (m.id IS NULL OR cc.conversation_id IS NOT NULL)`,
  [p.organizationId,id,p.accountId,p.destinationRevision,conversationId,messageId])).rows;
  const states=rows.map(row=>row.state);
  const status = states.includes('FAILED') || rows.some(r=>r.job_status==='FAILED') ? 'failed'
    : states.includes('UNKNOWN') || rows.some(r=>r.job_status==='UNKNOWN' || r.disposition==='RECONCILE') ? 'unknown'
    : rows.some(r=>r.disposition==='IGNORED') ? 'blocked'
    : !rows.length || states.some(s=>!s || !['SENT','DELIVERED','READ'].includes(s)) ? 'queued'
    : states.every(s=>s==='READ') ? 'read' : states.every(s=>s==='DELIVERED'||s==='READ') ? 'delivered' : 'sent';
  return {protocol,integrationId:id,conversationId,messageId,status};
}
