import { createHash } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import type { TenantTransaction } from '../../db/tenant-transaction.js';

export type IdempotencyRecordStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord {
  id: string;
  organizationId: string;
  route: string;
  idempotencyKey: string;
  requestHash: string;
  operationId: string | null;
  status: IdempotencyRecordStatus;
  responseMetadata: Record<string, unknown>;
  expiresAt: Date;
}

interface IdempotencyDatabaseRow extends QueryResultRow {
  id: string;
  organizationId: string;
  route: string;
  idempotencyKey: string;
  requestHash: string;
  operationId: string | null;
  status: IdempotencyRecordStatus;
  responseMetadata: Record<string, unknown>;
  expiresAt: Date;
}

export interface ClaimIdempotencyInput {
  organizationId: string;
  route: string;
  key: string;
  requestHash: string;
  expiresAt: Date;
}

export type IdempotencyClaim =
  | { kind: 'CLAIMED'; recordId: string }
  | { kind: 'REPLAY'; record: IdempotencyRecord };

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  readonly status = 409 as const;

  constructor() {
    super('Idempotency key was already used with another request');
    this.name = 'IdempotencyConflictError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(',')}}`;
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const COLUMNS = `
  id, organization_id AS "organizationId", route,
  idempotency_key AS "idempotencyKey", request_hash AS "requestHash",
  operation_id AS "operationId", status,
  response_metadata AS "responseMetadata", expires_at AS "expiresAt"
`;

export async function claimIdempotency(
  transaction: TenantTransaction,
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  await transaction.query(
    `DELETE FROM idempotency_records
      WHERE organization_id = $1 AND route = $2 AND idempotency_key = $3
        AND expires_at <= now()`,
    [input.organizationId, input.route, input.key],
  );
  const inserted = await transaction.query<IdempotencyDatabaseRow>(
    `INSERT INTO idempotency_records
       (organization_id, route, idempotency_key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, route, idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.organizationId, input.route, input.key, input.requestHash, input.expiresAt],
  );
  const created = inserted.rows[0];
  if (created) return { kind: 'CLAIMED', recordId: created.id };

  const existing = await transaction.query<IdempotencyDatabaseRow>(
    `SELECT ${COLUMNS}
       FROM idempotency_records
      WHERE organization_id = $1 AND route = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [input.organizationId, input.route, input.key],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error('Idempotency claim disappeared during transaction');
  }
  if (row.requestHash !== input.requestHash) {
    throw new IdempotencyConflictError();
  }
  return { kind: 'REPLAY', record: row };
}

export async function linkIdempotencyOperation(
  transaction: TenantTransaction,
  input: {
    organizationId: string;
    recordId: string;
    operationId: string;
    responseMetadata: Record<string, unknown>;
  },
): Promise<void> {
  await transaction.query(
    `UPDATE idempotency_records
        SET operation_id = $3, response_metadata = $4, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.recordId, input.operationId, input.responseMetadata],
  );
}

export async function completeIdempotencyRecord(
  transaction: TenantTransaction,
  input: {
    organizationId: string;
    recordId: string;
    status: IdempotencyRecordStatus;
    responseMetadata: Record<string, unknown>;
  },
): Promise<void> {
  await transaction.query(
    `UPDATE idempotency_records
        SET status = $3, response_metadata = $4, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.recordId, input.status, input.responseMetadata],
  );
}
