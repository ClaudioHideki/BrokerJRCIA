import type { QueryResultRow } from 'pg';

import { ApiKeyScopeSchema } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type {
  ApiKeyCursor,
  ApiKeyInsert,
  ApiKeyRepository,
  ApiKeyRow,
} from './service.js';

interface ApiKeyDatabaseRow extends QueryResultRow {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  keyHmac: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = `
  id, organization_id AS "organizationId", name, prefix, key_hmac AS "keyHmac",
  scopes, expires_at AS "expiresAt", revoked_at AS "revokedAt",
  last_used_at AS "lastUsedAt", created_at AS "createdAt"
`;

function firstRow(result: { rows: ApiKeyDatabaseRow[] }): ApiKeyRow | null {
  const row = result.rows[0];
  return row ? toApiKeyRow(row) : null;
}

function toApiKeyRow(row: ApiKeyDatabaseRow): ApiKeyRow {
  return {
    ...row,
    scopes: row.scopes.map((scope) => ApiKeyScopeSchema.parse(scope)),
  };
}

export function createPostgresApiKeyRepository(): ApiKeyRepository {
  return {
    async insert(transaction: TenantTransaction, input: ApiKeyInsert) {
      const result = await transaction.query<ApiKeyDatabaseRow>(
        `INSERT INTO api_keys
           (organization_id, name, prefix, key_hmac, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          input.organizationId,
          input.name,
          input.prefix,
          input.keyHmac,
          input.scopes,
          input.expiresAt,
        ],
      );
      const created = firstRow(result);
      if (!created) throw new Error('API key insert returned no row');
      return created;
    },

    async list(
      transaction: TenantTransaction,
      organizationId: string,
      limit: number,
      cursor: ApiKeyCursor | null,
    ) {
      const result = await transaction.query<ApiKeyDatabaseRow>(
        `SELECT ${COLUMNS}
           FROM api_keys
          WHERE organization_id = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [organizationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );
      return result.rows.map(toApiKeyRow);
    },

    async revoke(
      transaction: TenantTransaction,
      organizationId: string,
      id: string,
      revokedAt: Date,
    ) {
      const result = await transaction.query<ApiKeyDatabaseRow>(
        `UPDATE api_keys
            SET revoked_at = COALESCE(revoked_at, $3)
          WHERE organization_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        [organizationId, id, revokedAt],
      );
      return firstRow(result);
    },

    async findActiveByPrefix(
      transaction: TenantTransaction,
      organizationId: string,
      prefix: string,
    ) {
      const result = await transaction.query<ApiKeyDatabaseRow>(
        `SELECT ${COLUMNS}
           FROM api_keys
          WHERE organization_id = $1 AND prefix = $2
            AND EXISTS (SELECT 1 FROM organizations organization
              WHERE organization.id = api_keys.organization_id AND organization.status <> 'DISABLED')
          LIMIT 1`,
        [organizationId, prefix],
      );
      return firstRow(result);
    },

    async markUsed(
      transaction: TenantTransaction,
      id: string,
      usedAt: Date,
      organizationId: string,
    ) {
      await transaction.query(
        `UPDATE api_keys
            SET last_used_at = $3
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, usedAt],
      );
    },
  };
}
