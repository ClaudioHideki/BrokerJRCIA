import type { AutomationPackageRequirement } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
export interface PackageFlowReference { key: string; id: string; name: string }
export interface PackagePublication { version: number; checksum: string; draftRevision: number }
export interface PackageRecord {
  id: string; organizationId: string; revision: number; rootKey: string; rootId: string;
  flows: PackageFlowReference[]; publicationOrder: string[]; requirements: AutomationPackageRequirement[];
  publications: Record<string, PackagePublication>; state: 'DRAFT' | 'PUBLISHING' | 'UNKNOWN' | 'PUBLISHED';
  publishKey: string | null; publishRevision: number | null; leaseToken: string | null; leaseExpiresAt: number | null;
}
export interface PackageStore {
  get(tx: TenantTransaction, org: string, id: string, lock?: boolean): Promise<PackageRecord | null>;
  insert(tx: TenantTransaction, record: PackageRecord): Promise<PackageRecord>;
  put(tx: TenantTransaction, record: PackageRecord): Promise<PackageRecord>;
}
export function createPackageStore(): PackageStore {
  return {
    async get(tx, org, id, lock = false) {
      return (await tx.query<{ data: PackageRecord }>(`SELECT data FROM automation_packages WHERE organization_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [org, id])).rows[0]?.data ?? null;
    },
    async insert(tx, record) {
      await tx.query('INSERT INTO automation_packages(organization_id,id,data) VALUES($1,$2,$3)', [record.organizationId, record.id, JSON.stringify(record)]);
      return record;
    },
    async put(tx, record) {
      const result = await tx.query('UPDATE automation_packages SET data=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id',
        [record.organizationId, record.id, JSON.stringify(record)]);
      if (!result.rowCount) throw new Error('AUTOMATION_PACKAGE_NOT_FOUND');
      return record;
    },
  };
}
