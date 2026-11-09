import type { GuidedSetup } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';

export interface SetupRecord extends GuidedSetup {
  activeOwnerRevision?: number | null;
  operation: { key: string; actorId: string; kind: 'TEST' | 'ACTIVATE' | 'DEACTIVATE'; requestHash: string;
    input: Record<string, unknown>; leaseToken: string | null; leaseExpiresAt: number | null } | null;
  lastAction?: { key: string; actorId: string; kind: 'TEST' | 'ACTIVATE' | 'DEACTIVATE'; requestHash: string } | null;
  testContext: { keyword: string; startedAt: string; fingerprint: string;
    automationId: string | null; version: number | null; expectedOwnerRevision: number; ownerRevision: number | null } | null;
  previousBinding: Record<string, unknown> | null;
}
export interface SetupStore {
  get(tx: TenantTransaction, org: string, id: string, lock?: boolean): Promise<SetupRecord | null>;
  list(tx: TenantTransaction, org: string): Promise<SetupRecord[]>;
  insert(tx: TenantTransaction, record: SetupRecord): Promise<SetupRecord>;
  put(tx: TenantTransaction, record: SetupRecord): Promise<SetupRecord>;
}
export function createSetupStore(): SetupStore {
  return {
    async get(tx, org, id, lock = false) {
      return (await tx.query<{ data: SetupRecord }>(`SELECT data FROM guided_setup_operations WHERE organization_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [org, id])).rows[0]?.data ?? null;
    },
    async list(tx, org) {
      return (await tx.query<{ data: SetupRecord }>('SELECT data FROM guided_setup_operations WHERE organization_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 50', [org])).rows.map(row => row.data);
    },
    async insert(tx, record) {
      await tx.query('INSERT INTO guided_setup_operations(organization_id,id,data) VALUES($1,$2,$3)', [record.organizationId, record.id, JSON.stringify(record)]);
      return record;
    },
    async put(tx, record) {
      const result = await tx.query('UPDATE guided_setup_operations SET data=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id',
        [record.organizationId, record.id, JSON.stringify(record)]);
      if (!result.rowCount) throw new Error('GUIDED_SETUP_NOT_FOUND');
      return record;
    },
  };
}
