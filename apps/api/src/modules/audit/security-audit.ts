import {
  toSecurityAuditRecord,
  type AuditQueryExecutor,
  type SecurityAuditEvent,
} from './events.js';

export type { AuditDigest, AuditQueryExecutor, SecurityAuditEvent } from './events.js';
export { createAuditDigest } from './events.js';

const INSERT_SECURITY_AUDIT = `
  INSERT INTO security_audit_logs
    (event_type, request_id, identity_digest, ip_digest, outcome, metadata)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

export function createSecurityAuditWriter(executor: AuditQueryExecutor) {
  return async function writeSecurityAudit(event: SecurityAuditEvent): Promise<void> {
    const record = toSecurityAuditRecord(event);
    await executor.query(INSERT_SECURITY_AUDIT, [
      record.eventType,
      record.requestId,
      record.identityDigest,
      record.ipDigest,
      record.outcome,
      record.metadata,
    ]);
  };
}
