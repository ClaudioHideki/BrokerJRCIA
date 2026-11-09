import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { resolveAttendanceScope } from '../attendance/repository.js';
import type { SetupSnapshot } from './readiness.js';
import { setupFail } from './service.js';

/** Called after the canonical channel lock and before changing its executor. */
export async function assertSetupBindingScope(tx: TenantTransaction, org: string, snapshot: SetupSnapshot) {
  const expected = snapshot.destination;
  if (snapshot.organizationId !== org || !snapshot.channelId || !expected || !snapshot.flow || !snapshot.identity)
    return setupFail('CONFIGURATION_CHANGED');
  const scope = await resolveAttendanceScope(tx, org, snapshot.channelId);
  if (!scope || scope.integrationId !== expected.integrationId || scope.destinationRevision !== expected.destinationRevision ||
    scope.accountId !== expected.accountId || scope.inboxId !== expected.inboxId) return setupFail('CONFIGURATION_CHANGED');
  const account = (await tx.query<{ baseUrl: string; credentialRevision: number }>(
    'SELECT base_url AS "baseUrl",credential_version AS "credentialRevision" FROM chatwoot_accounts WHERE organization_id=$1 FOR SHARE', [org])).rows[0];
  if (account?.baseUrl !== expected.origin || account.credentialRevision !== expected.credentialRevision) return setupFail('CONFIGURATION_CHANGED');
  if (snapshot.provider === 'QR') {
    const identity = (await tx.query<{ approved_fingerprint: string; observed_fingerprint: string; identity_revision: number;
      observed_connected: boolean; identity_error: string | null }>(`SELECT approved_fingerprint,observed_fingerprint,identity_revision,observed_connected,identity_error
      FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2 AND channel_id=$3 FOR SHARE`, [org, expected.integrationId, snapshot.channelId])).rows[0];
    if (!identity || identity.approved_fingerprint !== snapshot.identity.fingerprint || identity.observed_fingerprint !== snapshot.identity.fingerprint ||
      identity.identity_revision !== snapshot.identity.revision || !identity.observed_connected || identity.identity_error) return setupFail('CONFIGURATION_CHANGED');
  } else {
    const meta = (await tx.query<{ fingerprint: string; graphVersion: string }>(`SELECT
      encode(sha256(convert_to(phone_number_id||':'||waba_id||':'||coalesce(encrypted_token,''),'UTF8')),'hex') AS fingerprint,graph_version AS "graphVersion"
      FROM meta_connections WHERE organization_id=$1 AND channel_id=$2 AND status='READY'
      AND (token_expires_at IS NULL OR token_expires_at>clock_timestamp()) FOR SHARE`, [org, snapshot.channelId])).rows[0];
    if (meta?.fingerprint !== snapshot.identity.fingerprint || meta.graphVersion !== snapshot.identity.revision) return setupFail('CONFIGURATION_CHANGED');
  }
  const root = (await tx.query<{ checksum: string }>(`SELECT v.checksum FROM automation_versions v JOIN automation_definitions d
    ON d.organization_id=v.organization_id AND d.id=v.automation_id WHERE v.organization_id=$1 AND v.automation_id=$2 AND v.version=$3
    AND d.lifecycle_status<>'ARCHIVED' FOR SHARE OF d`, [org, snapshot.flow.id, snapshot.flow.version])).rows[0];
  if (root?.checksum !== snapshot.flow.checksum) return setupFail('CONFIGURATION_CHANGED');
}
