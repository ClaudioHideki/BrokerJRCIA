import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { SetupPrincipal } from './service.js';

type SetupAuditEvent = 'CREATED' | 'UPDATED' | 'CANCELLED' | 'TESTED' | 'ACTIVATED' | 'DEACTIVATED' | 'ACTION_UNKNOWN';
export async function writeSetupAudit(tx: TenantTransaction, principal: SetupPrincipal, id: string, event: SetupAuditEvent,
  metadata: Record<string, string | number | boolean | null>) {
  await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
    VALUES($1,$2,$3,'guided_setup',$4,$5,$6,$7)`, [principal.organizationId, principal.actorId, `GUIDED_SETUP_${event}`,
    id, randomUUID(), event === 'ACTION_UNKNOWN' ? 'UNKNOWN' : 'SUCCESS', JSON.stringify(metadata)]);
}
