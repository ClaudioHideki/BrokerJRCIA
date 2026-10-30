import type { TenantTransaction } from '../../db/tenant-transaction.js';

type StoredClock = { observedAt: Date | null; fingerprint: string | null };
type ConnectionFact = { observedAt?: Date | undefined; fingerprint: string };

/** Call only after authenticating the engine binding. Missing time never supersedes a known clock. */
export function shouldAcceptConnectionFact(previous: StoredClock, next: ConnectionFact): boolean {
  if (previous.fingerprint !== next.fingerprint) return true;
  if (previous.observedAt === null) return true;
  return next.observedAt !== undefined && next.observedAt.getTime() > previous.observedAt.getTime();
}

/** Lock instance BEFORE channel: upgrading an instance SHARE after locking the channel can deadlock ingress. */
export async function persistConnectionFact(tx: TenantTransaction, input: ConnectionFact & {
  organizationId: string; instanceId: string; state: 'CONNECTED' | 'DISCONNECTED';
}): Promise<boolean> {
  const previous = (await tx.query<StoredClock>(`SELECT connection_observed_at AS "observedAt",
    connection_binding_fingerprint AS fingerprint FROM instances
    WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
      AND status NOT IN ('PROVISIONING','PROVISIONING_FAILED') FOR UPDATE`,
  [input.organizationId, input.instanceId])).rows[0];
  if (!previous || !shouldAcceptConnectionFact(previous, input)) return false;
  await tx.query(`UPDATE instances SET status=$3,connection_observed_at=$4,
    connection_binding_fingerprint=$5,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2`,
  [input.organizationId, input.instanceId, input.state, input.observedAt ?? null, input.fingerprint]);
  return true;
}
