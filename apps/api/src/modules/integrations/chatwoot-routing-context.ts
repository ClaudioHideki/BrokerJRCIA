import { z } from 'zod';
import { ControlRoutingContextSchema } from '@jrc/contracts';
import { channelRoutingState } from '../channels/automation-status.js';
import { IntegrationError } from './integration-error.js';
import type { ChatwootControlOptions } from './chatwoot-control-service.js';
import type { ChatwootControlPrincipal } from './chatwoot-control-auth.js';

interface RoutingRow {
  integration_id: string; channel_id: string; inbox_id: string | number; integration_status: string;
  bot_public_id: string | null; bot_origin_reference: string | null; owner_executor: string | null;
  owner_revision: number | null; automation_binding_status: string | null; binding_revision: number | null;
  live_routing: boolean; deleting_at: Date | null;
  complete_snapshot: boolean;
  remote_bot_present: boolean;
}

export function createChatwootRoutingContext(options: Pick<ChatwootControlOptions, 'auth' | 'transact'>) {
  return async (p: ChatwootControlPrincipal, input: string[]) => {
    const ids = z.array(z.uuid()).min(1).max(100).refine(values => new Set(values).size === values.length).parse(input);
    // This machine read uses the already installed account credential, never a portal user's broader JWT.
    if (p.authentication.kind !== 'API_KEY' || p.restriction) throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    return options.transact(p.organizationId, async tx => {
      await options.auth.revalidate(tx, p, 'chatwoot:read');
      const rows = (await tx.query<RoutingRow>(`SELECT c.id AS integration_id,c.channel_id,c.inbox_id,c.status AS integration_status,
        ch.bot_public_id,ch.bot_origin_reference,ch.deleting_at,ao.executor AS owner_executor,ao.revision AS owner_revision,
        ab.status AS automation_binding_status,ab.revision AS binding_revision,
        EXISTS(SELECT 1 FROM flow_chatwoot_bindings b WHERE b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND b.bot_id IS NOT NULL) AS remote_bot_present,
        (c.inbox_id IS NOT NULL AND (ao.integration_id IS NULL OR ao.integration_id=c.id) AND
         ((ch.transport='BROKER_TRANSPORT' AND
          ((ch.provider='BAILEYS' AND EXISTS(SELECT 1 FROM instances i JOIN provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id
            WHERE i.organization_id=ch.organization_id AND i.id=ch.instance_id AND i.provider_account_id=ch.provider_account_id AND i.archived_at IS NULL AND pa.provider='BAILEYS')) OR ch.provider='META')) OR
          (ch.transport='CENTRAL_TRANSPORT' AND EXISTS(SELECT 1 FROM central_transport_bindings b
            JOIN chatwoot_accounts a ON a.organization_id=b.organization_id JOIN chatwoot_destinations d ON d.organization_id=b.organization_id
            WHERE b.organization_id=c.organization_id AND b.channel_id=c.channel_id AND b.integration_id=c.id AND b.inbox_id=c.inbox_id
             AND b.account_id=a.account_id AND b.origin=a.base_url AND b.credential_version=a.credential_version AND b.destination_revision=d.revision AND b.status='READY')))) AS complete_snapshot,
        (EXISTS(SELECT 1 FROM automation_executions e WHERE e.organization_id=c.organization_id AND e.channel_id=c.channel_id AND e.status IN('QUEUED','RUNNING','WAITING','UNKNOWN')) OR
         EXISTS(SELECT 1 FROM attendance_sessions s WHERE s.organization_id=c.organization_id AND s.channel_id=c.channel_id AND s.state NOT IN('RESOLVED','HUMAN_ACTIVE','ADMIN_PAUSED')) OR
         EXISTS(SELECT 1 FROM automation_outbox o JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id WHERE e.organization_id=c.organization_id AND e.channel_id=c.channel_id AND o.status IN('PENDING','SENDING','UNKNOWN')) OR
         EXISTS(SELECT 1 FROM automation_waits w JOIN automation_executions e ON e.organization_id=w.organization_id AND e.id=w.execution_id WHERE e.organization_id=c.organization_id AND e.channel_id=c.channel_id AND w.status='WAITING') OR
         EXISTS(SELECT 1 FROM messaging_bot_jobs j JOIN messaging_conversations mc ON mc.organization_id=j.organization_id AND mc.id=j.conversation_id WHERE mc.organization_id=c.organization_id AND mc.channel_id=c.channel_id AND j.status IN('PENDING','RUNNING','UNKNOWN')) OR
         EXISTS(SELECT 1 FROM messaging_messages m WHERE m.organization_id=c.organization_id AND m.channel_id=c.channel_id AND m.direction='OUTGOING' AND m.source='AUTOMATION' AND m.state IN('ACCEPTED','SENDING','UNKNOWN')) OR
         EXISTS(SELECT 1 FROM flow_chatwoot_bindings b WHERE b.organization_id=c.organization_id AND b.inbox_id=c.inbox_id AND (b.status<>'DISABLED' OR b.operation_state<>'IDLE' OR b.bot_id IS NOT NULL))) AS live_routing
        FROM chatwoot_connections c JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
        LEFT JOIN attendance_owners ao ON ao.organization_id=c.organization_id AND ao.channel_id=c.channel_id
        LEFT JOIN automation_bindings ab ON ab.organization_id=c.organization_id AND ab.channel_id=c.channel_id AND ab.status IN('ACTIVE','PAUSED')
        WHERE c.organization_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`, [p.organizationId, ids])).rows;
      if (rows.length !== ids.length || new Set(rows.map(row => row.integration_id)).size !== ids.length ||
          rows.some(row => !ids.includes(row.integration_id))) throw new IntegrationError('INTEGRATION_NOT_FOUND', 404);
      await options.auth.revalidate(tx, p, 'chatwoot:read');
      return ControlRoutingContextSchema.parse({ schemaVersion: 1, organizationId: p.organizationId, accountId: p.accountId,
        destinationRevision: p.destinationRevision, checkedAt: new Date().toISOString(),
        data: rows.map(row => ({ integrationId: row.integration_id, channelId: row.channel_id, inboxId: Number(row.inbox_id),
          state: channelRoutingState(row), ownerRevision: row.owner_revision, bindingRevision: row.binding_revision })) });
    });
  };
}
