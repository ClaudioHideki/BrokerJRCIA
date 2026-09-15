import type { QueryResultRow } from 'pg';

import type { ProviderKind } from '@jrc/contracts';

import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { AdminTransaction } from '../organizations/repository.js';

export interface ProviderAccount {
  id: string;
  organizationId: string;
  provider: 'BAILEYS' | 'META';
  name: string;
  externalReference: string | null;
  credentialReference: string | null;
}

export interface ProviderAccountListRow {
  id: string;
  organizationId: string;
  provider: ProviderKind;
  name: string;
  createdAt: Date;
}

export interface ProviderAccountCursor {
  organizationId: string;
  provider: ProviderKind | null;
  createdAt: string;
  id: string;
}

export interface ProviderAccountRepository {
  list(
    transaction: TenantTransaction,
    organizationId: string,
    provider: ProviderKind | null,
    limit: number,
    cursor: ProviderAccountCursor | null,
  ): Promise<ProviderAccountListRow[]>;
}

export function createPostgresProviderAccountRepository(): ProviderAccountRepository {
  return {
    async list(transaction, organizationId, provider, limit, cursor) {
      const result = await transaction.query<ProviderAccountListRow & QueryResultRow>(
        `SELECT id, organization_id AS "organizationId", provider, name,
                created_at AS "createdAt"
           FROM provider_accounts
          WHERE organization_id = $1
            AND ($2::provider_kind IS NULL OR provider = $2::provider_kind)
            AND (
              $3::timestamptz IS NULL
              OR (created_at, id) < ($3::timestamptz, $4::uuid)
            )
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [organizationId, provider, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );
      return result.rows;
    },
  };
}

export async function ensureLogicalBaileysAccount(
  transaction: AdminTransaction,
  organizationId: string,
): Promise<ProviderAccount> {
  const result = await transaction.query<ProviderAccount & QueryResultRow>(
    `INSERT INTO provider_accounts (organization_id, provider, name)
     VALUES ($1, 'BAILEYS', 'baileys')
     ON CONFLICT (organization_id, provider)
     DO UPDATE SET name = provider_accounts.name
     RETURNING id, organization_id AS "organizationId", provider, name,
               external_reference AS "externalReference",
               credential_reference AS "credentialReference"`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error(`Expected one BAILEYS provider account, received ${result.rows.length}`);
  }
  return row;
}
