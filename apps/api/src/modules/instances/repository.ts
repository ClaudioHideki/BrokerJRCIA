import type { QueryResultRow } from 'pg';

import type { InstanceStatus, ProviderKind } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import {
  claimIdempotency,
  completeIdempotencyRecord,
  linkIdempotencyOperation,
  type ClaimIdempotencyInput,
  type IdempotencyClaim,
  type IdempotencyRecordStatus,
} from './idempotency.js';

export interface ProviderAccountRow {
  id: string;
  organizationId: string;
  provider: ProviderKind;
}

export interface InstanceRow {
  id: string;
  organizationId: string;
  providerAccountId: string;
  name: string;
  provider: ProviderKind;
  upstreamInstanceKey: string;
  externalReference: string | null;
  status: InstanceStatus;
  capabilities: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderOperationRow {
  id: string;
  organizationId: string;
  instanceId: string;
  operationType: 'PROVISION' | 'CONNECT' | 'DISCONNECT';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  attemptCount: number;
  canonicalErrorCode: string | null;
  reconciliationRequired: boolean;
  updatedAt: Date;
}

export interface InstanceCursor {
  organizationId: string;
  createdAt: string;
  id: string;
}

export interface InstanceRepository {
  findProviderAccount(
    transaction: TenantTransaction,
    organizationId: string,
    providerAccountId: string,
  ): Promise<ProviderAccountRow | null>;
  insertProvisioning(transaction: TenantTransaction, input: {
    id: string;
    organizationId: string;
    providerAccountId: string;
    provider: ProviderKind;
    name: string;
    upstreamInstanceKey: string;
  }): Promise<{ instance: InstanceRow; operation: ProviderOperationRow }>;
  findById(
    transaction: TenantTransaction,
    organizationId: string,
    instanceId: string,
  ): Promise<InstanceRow | null>;
  findByIdForUpdate(
    transaction: TenantTransaction,
    organizationId: string,
    instanceId: string,
  ): Promise<InstanceRow | null>;
  findByOperation(
    transaction: TenantTransaction,
    organizationId: string,
    operationId: string,
  ): Promise<InstanceRow | null>;
  list(
    transaction: TenantTransaction,
    organizationId: string,
    limit: number,
    cursor: InstanceCursor | null,
  ): Promise<InstanceRow[]>;
  createOperation(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    operationType: ProviderOperationRow['operationType'];
    updatedAt?: Date;
  }): Promise<ProviderOperationRow>;
  findPendingConnectOperationForUpdate(
    transaction: TenantTransaction,
    organizationId: string,
    instanceId: string,
  ): Promise<ProviderOperationRow | null>;
  findPendingDisconnectOperationForUpdate(
    transaction: TenantTransaction,
    organizationId: string,
    instanceId: string,
  ): Promise<ProviderOperationRow | null>;
  updatePendingConnectOperation(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    operationId: string;
    status: ProviderOperationRow['status'];
    canonicalErrorCode: string | null;
    updatedAt: Date;
    incrementAttempt?: boolean;
  }): Promise<boolean>;
  updatePendingDisconnectOperation(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    operationId: string;
    status: ProviderOperationRow['status'];
    canonicalErrorCode: string | null;
    updatedAt: Date;
    incrementAttempt?: boolean;
  }): Promise<boolean>;
  updateInstanceState(transaction: TenantTransaction, input: {
    organizationId: string;
    instanceId: string;
    status: InstanceStatus;
    externalReference?: string | null;
    capabilities?: string[];
  }): Promise<InstanceRow | null>;
  completeOperation(transaction: TenantTransaction, input: {
    organizationId: string;
    operationId: string;
    status: ProviderOperationRow['status'];
    canonicalErrorCode: string | null;
    reconciliationRequired: boolean;
    incrementAttempt?: boolean;
  }): Promise<void>;
  claimProvisioningOperation(
    transaction: TenantTransaction,
    organizationId: string,
    operationId: string,
    acquiredAt: Date,
    leaseMs: number,
  ): Promise<{ instance: InstanceRow; operation: ProviderOperationRow } | null>;
  claimIdempotency(transaction: TenantTransaction, input: ClaimIdempotencyInput): Promise<IdempotencyClaim>;
  linkIdempotency(transaction: TenantTransaction, input: {
    organizationId: string;
    recordId: string;
    operationId: string;
    responseMetadata: Record<string, unknown>;
  }): Promise<void>;
  completeIdempotency(transaction: TenantTransaction, input: {
    organizationId: string;
    recordId: string;
    status: IdempotencyRecordStatus;
    responseMetadata: Record<string, unknown>;
  }): Promise<void>;
}

interface InstanceDatabaseRow extends QueryResultRow {
  id: string;
  organizationId: string;
  providerAccountId: string;
  name: string;
  provider: ProviderKind;
  upstreamInstanceKey: string;
  externalReference: string | null;
  status: InstanceStatus;
  capabilities: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface OperationDatabaseRow extends QueryResultRow, ProviderOperationRow {}
interface ProviderAccountDatabaseRow extends QueryResultRow, ProviderAccountRow {}

const INSTANCE_COLUMNS = `
  i.id, i.organization_id AS "organizationId",
  i.provider_account_id AS "providerAccountId", i.name, pa.provider,
  i.upstream_instance_key AS "upstreamInstanceKey",
  i.external_reference AS "externalReference", i.status, i.capabilities,
  i.created_at AS "createdAt", i.updated_at AS "updatedAt"
`;

const OPERATION_COLUMNS = `
  id, organization_id AS "organizationId", instance_id AS "instanceId",
  operation_type AS "operationType", status, attempt_count AS "attemptCount",
  canonical_error_code AS "canonicalErrorCode",
  reconciliation_required AS "reconciliationRequired",
  updated_at AS "updatedAt"
`;

function first<T>(result: { rows: T[] }): T | null {
  return result.rows[0] ?? null;
}

export function createPostgresInstanceRepository(): InstanceRepository {
  return {
    async findProviderAccount(transaction, organizationId, providerAccountId) {
      const result = await transaction.query<ProviderAccountDatabaseRow>(
        `SELECT id, organization_id AS "organizationId", provider
           FROM provider_accounts
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, providerAccountId],
      );
      return first(result);
    },

    async insertProvisioning(transaction, input) {
      const instanceResult = await transaction.query<InstanceDatabaseRow>(
        `INSERT INTO instances
           (id, organization_id, provider_account_id, name, upstream_instance_key, status)
         VALUES ($1, $2, $3, $4, $5, 'PROVISIONING')
         RETURNING id, organization_id AS "organizationId",
           provider_account_id AS "providerAccountId", name,
           $6::provider_kind AS provider,
           upstream_instance_key AS "upstreamInstanceKey",
           external_reference AS "externalReference", status, capabilities,
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          input.id,
          input.organizationId,
          input.providerAccountId,
          input.name,
          input.upstreamInstanceKey,
          input.provider,
        ],
      );
      const instance = first(instanceResult);
      if (!instance) throw new Error('Instance insert returned no row');
      const operation = await this.createOperation(transaction, {
        organizationId: input.organizationId,
        instanceId: input.id,
        operationType: 'PROVISION',
      });
      return { instance, operation };
    },

    async findById(transaction, organizationId, instanceId) {
      const result = await transaction.query<InstanceDatabaseRow>(
        `SELECT ${INSTANCE_COLUMNS}
           FROM instances i
           JOIN provider_accounts pa
             ON pa.organization_id = i.organization_id AND pa.id = i.provider_account_id
          WHERE i.organization_id = $1 AND i.id = $2`,
        [organizationId, instanceId],
      );
      return first(result);
    },

    async findByIdForUpdate(transaction, organizationId, instanceId) {
      const result = await transaction.query<InstanceDatabaseRow>(
        `SELECT ${INSTANCE_COLUMNS}
           FROM instances i
           JOIN provider_accounts pa
             ON pa.organization_id = i.organization_id AND pa.id = i.provider_account_id
          WHERE i.organization_id = $1 AND i.id = $2
          FOR UPDATE OF i`,
        [organizationId, instanceId],
      );
      return first(result);
    },

    async findByOperation(transaction, organizationId, operationId) {
      const result = await transaction.query<InstanceDatabaseRow>(
        `SELECT ${INSTANCE_COLUMNS}
           FROM provider_operations po
           JOIN instances i
             ON i.organization_id = po.organization_id AND i.id = po.instance_id
           JOIN provider_accounts pa
             ON pa.organization_id = i.organization_id AND pa.id = i.provider_account_id
          WHERE po.organization_id = $1 AND po.id = $2`,
        [organizationId, operationId],
      );
      return first(result);
    },

    async list(transaction, organizationId, limit, cursor) {
      const result = await transaction.query<InstanceDatabaseRow>(
        `SELECT ${INSTANCE_COLUMNS}
           FROM instances i
           JOIN provider_accounts pa
             ON pa.organization_id = i.organization_id AND pa.id = i.provider_account_id
          WHERE i.organization_id = $1
            AND ($2::timestamptz IS NULL OR (i.created_at, i.id) < ($2::timestamptz, $3::uuid))
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT $4`,
        [organizationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );
      return result.rows;
    },

    async createOperation(transaction, input) {
      const result = await transaction.query<OperationDatabaseRow>(
        `INSERT INTO provider_operations
           (organization_id, instance_id, operation_type, reconciliation_required, updated_at)
         VALUES ($1, $2, $3, $3::text = 'PROVISION', COALESCE($4::timestamptz, now()))
         RETURNING ${OPERATION_COLUMNS}`,
        [input.organizationId, input.instanceId, input.operationType, input.updatedAt ?? null],
      );
      const row = first(result);
      if (!row) throw new Error('Provider operation insert returned no row');
      return row;
    },

    async findPendingConnectOperationForUpdate(transaction, organizationId, instanceId) {
      const result = await transaction.query<OperationDatabaseRow>(
        `SELECT ${OPERATION_COLUMNS}
           FROM provider_operations
          WHERE organization_id = $1 AND instance_id = $2
            AND operation_type = 'CONNECT' AND status = 'PENDING'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [organizationId, instanceId],
      );
      return first(result);
    },

    async findPendingDisconnectOperationForUpdate(transaction, organizationId, instanceId) {
      const result = await transaction.query<OperationDatabaseRow>(
        `SELECT ${OPERATION_COLUMNS}
           FROM provider_operations
          WHERE organization_id = $1 AND instance_id = $2
            AND operation_type = 'DISCONNECT' AND status = 'PENDING'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [organizationId, instanceId],
      );
      return first(result);
    },

    async updatePendingConnectOperation(transaction, input) {
      const result = await transaction.query<{ id: string } & QueryResultRow>(
        `UPDATE provider_operations
            SET status = $4, canonical_error_code = $5,
                reconciliation_required = false,
                attempt_count = attempt_count + CASE WHEN $7 THEN 1 ELSE 0 END,
                updated_at = $6
          WHERE organization_id = $1 AND instance_id = $2 AND id = $3
            AND operation_type = 'CONNECT' AND status = 'PENDING'
        RETURNING id`,
        [
          input.organizationId,
          input.instanceId,
          input.operationId,
          input.status,
          input.canonicalErrorCode,
          input.updatedAt,
          input.incrementAttempt ?? false,
        ],
      );
      return result.rows.length === 1;
    },

    async updatePendingDisconnectOperation(transaction, input) {
      const result = await transaction.query<{ id: string } & QueryResultRow>(
        `UPDATE provider_operations
            SET status = $4, canonical_error_code = $5,
                reconciliation_required = false,
                attempt_count = attempt_count + CASE WHEN $7 THEN 1 ELSE 0 END,
                updated_at = $6
          WHERE organization_id = $1 AND instance_id = $2 AND id = $3
            AND operation_type = 'DISCONNECT' AND status = 'PENDING'
        RETURNING id`,
        [
          input.organizationId,
          input.instanceId,
          input.operationId,
          input.status,
          input.canonicalErrorCode,
          input.updatedAt,
          input.incrementAttempt ?? false,
        ],
      );
      return result.rows.length === 1;
    },

    async updateInstanceState(transaction, input) {
      const result = await transaction.query<InstanceDatabaseRow>(
        `WITH i AS (
           UPDATE instances AS target
              SET status = $3,
                  external_reference = CASE WHEN $4::boolean THEN $5 ELSE target.external_reference END,
                  capabilities = CASE WHEN $6::boolean THEN $7::jsonb ELSE target.capabilities END,
                  updated_at = now()
            WHERE target.organization_id = $1 AND target.id = $2
           RETURNING target.*
         )
         SELECT ${INSTANCE_COLUMNS}
           FROM i
           JOIN provider_accounts pa
             ON pa.organization_id = i.organization_id AND pa.id = i.provider_account_id`,
        [
          input.organizationId,
          input.instanceId,
          input.status,
          Object.hasOwn(input, 'externalReference'),
          input.externalReference ?? null,
          Object.hasOwn(input, 'capabilities'),
          JSON.stringify(input.capabilities ?? []),
        ],
      );
      return first(result);
    },

    async completeOperation(transaction, input) {
      await transaction.query(
        `UPDATE provider_operations
            SET status = $3, canonical_error_code = $4,
                reconciliation_required = $5,
                attempt_count = attempt_count + CASE WHEN $6 THEN 1 ELSE 0 END,
                updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [
          input.organizationId,
          input.operationId,
          input.status,
          input.canonicalErrorCode,
          input.reconciliationRequired,
          input.incrementAttempt ?? true,
        ],
      );
    },

    async claimProvisioningOperation(
      transaction,
      organizationId,
      operationId,
      acquiredAt,
      leaseMs,
    ) {
      const operationResult = await transaction.query<OperationDatabaseRow>(
        `UPDATE provider_operations
            SET status = 'PENDING', attempt_count = attempt_count + 1,
                updated_at = $3::timestamptz
          WHERE organization_id = $1 AND id = $2
            AND operation_type = 'PROVISION' AND reconciliation_required = true
            AND (
              status = 'UNKNOWN'
              OR (
                status = 'PENDING'
                AND updated_at <= $3::timestamptz - ($4::bigint * interval '1 millisecond')
              )
            )
         RETURNING ${OPERATION_COLUMNS}`,
        [organizationId, operationId, acquiredAt, leaseMs],
      );
      const operation = first(operationResult);
      if (!operation) return null;
      const instance = await this.findById(transaction, organizationId, operation.instanceId);
      return instance ? { instance, operation } : null;
    },

    claimIdempotency,
    linkIdempotency: linkIdempotencyOperation,
    completeIdempotency: completeIdempotencyRecord,
  };
}
