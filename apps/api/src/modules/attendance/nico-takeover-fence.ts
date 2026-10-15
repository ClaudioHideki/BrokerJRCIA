import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { AttendanceError } from './types.js';

export async function hasNicoTakeoverFence(tx: TenantTransaction, org: string, conversation: string) {
  return Boolean((await tx.query("SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1 AND conversation_id=$2 AND state='OPEN'", [org, conversation])).rowCount);
}
export async function assertNoNicoTakeoverFence(tx: TenantTransaction, org: string, conversation: string) {
  if (await hasNicoTakeoverFence(tx, org, conversation)) throw new AttendanceError('NICO_TAKEOVER_OPEN', 409);
}
