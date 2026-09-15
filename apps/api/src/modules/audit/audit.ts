import {
  toTenantAuditRecord,
  type TenantAuditEvent,
} from './events.js';
import type { TenantTransaction } from '../../db/tenant-transaction.js';

export type { TenantAuditEvent } from './events.js';

const INSERT_TENANT_AUDIT = `
  INSERT INTO audit_logs
    (organization_id, actor_id, event_type, resource_type, resource_id, request_id, outcome, metadata)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

export async function writeTenantAudit(
  transaction: TenantTransaction,
  event: TenantAuditEvent,
): Promise<void> {
  const record = toTenantAuditRecord(event);
  await transaction.query(INSERT_TENANT_AUDIT, [
    record.organizationId,
    record.actorId,
    record.eventType,
    record.resourceType,
    record.resourceId,
    record.requestId,
    record.outcome,
    record.metadata,
  ]);
}
