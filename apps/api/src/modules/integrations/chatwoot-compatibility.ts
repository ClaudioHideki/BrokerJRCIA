import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { AccountRow } from './chatwoot-context.js';

const required = ['adminAccount', 'apiAccess', 'apiInbox', 'webhookSecret'] as const;
const observedKeys = [...required, 'signedCallback'] as const;
export type ChatwootCapabilities = Partial<Record<typeof observedKeys[number], boolean>>;

export function evaluateChatwootCapabilities(value: ChatwootCapabilities) {
  const unsupported = required.filter(key => value[key] === false);
  const missing = observedKeys.filter(key => value[key] !== true);
  return { state: unsupported.length ? 'UNSUPPORTED' as const : missing.length ? 'UNVERIFIED' as const : 'READY' as const,
    reasons: (unsupported.length ? unsupported : missing).map(key => `${key}:${value[key] === false && key !== 'signedCallback' ? 'unsupported' : 'unverified'}`) };
}

export function accountCompatibility(account: AccountRow) {
  const saved = account.capabilities;
  const observations: ChatwootCapabilities = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    const record = saved as Record<string, unknown>;
    if (record.credentialVersion === account.credential_version && record.destinationRevision === account.destination?.revision &&
      record.observations && typeof record.observations === 'object') {
      for (const key of observedKeys) {
        const value = (record.observations as Record<string, unknown>)[key];
        if (typeof value === 'boolean') observations[key] = value;
      }
    }
  }
  return { ...evaluateChatwootCapabilities(observations), observations };
}

/** Merge evidence only into the exact credential/destination that produced it. RLS applies. */
export async function observeChatwootCapabilities(tx: TenantTransaction, account: AccountRow, patch: ChatwootCapabilities) {
  if (!account.destination) return;
  const observations: ChatwootCapabilities = {};
  for (const key of observedKeys) if (typeof patch[key] === 'boolean') observations[key] = patch[key];
  await tx.query(`UPDATE chatwoot_accounts a SET capabilities=jsonb_build_object(
    'credentialVersion',$2::int,'destinationRevision',$3::int,'observedAt',now(),
    'observations',(CASE WHEN a.capabilities->>'credentialVersion'=$2::text AND a.capabilities->>'destinationRevision'=$3::text
      THEN COALESCE(a.capabilities->'observations','{}'::jsonb) ELSE '{}'::jsonb END)||$4::jsonb),
    capabilities_verified_at=now() FROM chatwoot_destinations d
    WHERE a.organization_id=$1 AND a.credential_version=$2 AND d.organization_id=a.organization_id
      AND d.revision=$3 AND d.base_url=a.base_url AND d.approval_status='APPROVED'`,
  [account.organization_id, account.credential_version, account.destination.revision, JSON.stringify(observations)]);
}

export function publicChatwootCapabilities(account: AccountRow) {
  const { observations: v } = accountCompatibility(account);
  const status = (value: boolean | undefined) => value === true ? 'SUPPORTED' as const : value === false ? 'UNSUPPORTED' as const : 'UNVERIFIED' as const;
  return { inboxes: status(v.apiInbox), signatures: v.webhookSecret === false ? 'UNSUPPORTED' as const : status(v.signedCallback || undefined), dashboardApps: 'UNVERIFIED' as const };
}
