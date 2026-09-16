import { createHmac } from 'node:crypto';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { IntegrationError } from './integration-error.js';

export function deriveTransportStatus(v: { integrationReady: boolean; connected: boolean; callbackVerified: boolean; recentInbound: boolean; recentOutbound: boolean; activeFailure: boolean }) {
  if (v.activeFailure) return 'DEGRADED' as const;
  return v.integrationReady && v.connected && v.callbackVerified && v.recentInbound && v.recentOutbound ? 'OPERATIONAL' as const : 'UNVERIFIED' as const;
}
export interface HealthRow {
  organization_id: string; integration_id: string; channel_id: string; identity_enforced: boolean;
  approved_fingerprint: string | null; observed_fingerprint: string | null; observed_last4: string | null;
  identity_revision: number; observed_connected: boolean; observed_at: Date | null; identity_error: string | null; access_error: string | null;
  callback_verified_at: Date | null; callback_destination_revision: number | null; callback_credential_version: number | null;
}
export interface ChatwootHealthOptions {
  encryptionKey: string;
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  readIdentity(org: string, instanceId: string): Promise<{ connected: boolean; phone: string | null }>;
}
export async function readChatwootHealth(t: TenantTransaction, org: string, integration: string): Promise<HealthRow | undefined> {
  return (await t.query<HealthRow>('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2', [org, integration])).rows[0];
}
export function identityStatus(row: HealthRow | undefined): 'UNVERIFIED' | 'CONFIRMED' | 'CONFIRMATION_REQUIRED' {
  if (!row?.observed_fingerprint) return 'UNVERIFIED';
  return row.approved_fingerprint === row.observed_fingerprint && !row.identity_error ? 'CONFIRMED' : 'CONFIRMATION_REQUIRED';
}
export function createChatwootHealth(options: ChatwootHealthOptions) {
  const key = Buffer.from(options.encryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== options.encryptionKey) throw new Error('INVALID_INTEGRATION_ENCRYPTION_KEY');
  async function observe(t: TenantTransaction, org: string, channel: string, observed: { connected: boolean; phone: string | null }) {
    const phone = observed.phone && /^[1-9]\d{6,14}$/.test(observed.phone) ? observed.phone : null;
    const fingerprint = phone ? createHmac('sha256', key).update(`chatwoot-identity:v1:${org}:${channel}:${phone}`).digest('hex') : null;
    await t.query(`UPDATE chatwoot_connection_health SET
      identity_revision=identity_revision+CASE WHEN observed_fingerprint IS DISTINCT FROM $3 OR observed_connected<>$4 THEN 1 ELSE 0 END,
      observed_fingerprint=$3,observed_last4=$5,observed_connected=$4,observed_at=now(),updated_at=now(),
      identity_error=CASE WHEN $4 AND $3::text IS NULL THEN 'IDENTITY_UNVERIFIED' WHEN approved_fingerprint IS NOT NULL AND $3::text IS NOT NULL AND approved_fingerprint<>$3 THEN 'IDENTITY_CONFIRMATION_REQUIRED' ELSE NULL END
      WHERE organization_id=$1 AND channel_id=$2`, [org, channel, fingerprint, observed.connected, phone?.slice(-4) ?? null]);
  }
  async function refresh(org: string, channel: string) {
    const mapped = await options.transact(org, async t => (await t.query<{ instance_id: string; integration_id: string }>(`SELECT ch.instance_id,h.integration_id
      FROM chatwoot_connection_health h JOIN messaging_channels ch ON ch.organization_id=h.organization_id AND ch.id=h.channel_id
      WHERE h.organization_id=$1 AND h.channel_id=$2 AND ch.provider='BAILEYS'`, [org, channel])).rows[0]);
    if (!mapped) return;
    // Capture the revision before I/O; a more recent authenticated webhook observation wins.
    const snapshot = await options.transact(org, t => readChatwootHealth(t, org, mapped.integration_id));
    try {
      const current = await options.readIdentity(org, mapped.instance_id);
      await options.transact(org, async t => {
        const locked = (await t.query<HealthRow>('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE', [org, channel])).rows[0];
        if (locked?.identity_revision === snapshot?.identity_revision) await observe(t, org, channel, current);
      });
    } catch {
      await options.transact(org, t => t.query(`UPDATE chatwoot_connection_health SET observed_connected=false,identity_error='IDENTITY_UNVERIFIED',observed_at=now(),updated_at=now()
        WHERE organization_id=$1 AND channel_id=$2 AND identity_revision=$3`, [org, channel, snapshot?.identity_revision]));
      throw new IntegrationError('IDENTITY_UNVERIFIED', 503);
    }
  }
  return {
    observe,
    async enroll(t: TenantTransaction, org: string, integration: string) {
      await t.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,identity_enforced)
        SELECT organization_id,id,channel_id,true FROM chatwoot_connections WHERE organization_id=$1 AND id=$2
        ON CONFLICT(organization_id,integration_id) DO UPDATE SET identity_enforced=true`, [org, integration]);
    },
    refresh,
    async refreshForDispatch(org: string, channel: string) {
      const enforced = await options.transact(org, async t => (await t.query('SELECT 1 FROM chatwoot_connection_health WHERE organization_id=$1 AND channel_id=$2 AND identity_enforced', [org, channel])).rowCount);
      if (!enforced) return;
      try { await refresh(org, channel); }
      catch (error) { if (!(error instanceof IntegrationError && error.code === 'IDENTITY_UNVERIFIED')) throw error; }
      // The outbox's final transactional check releases the lease while keeping the message pending.
    },
    async assertReady(org: string, channel: string) {
      const enforced = await options.transact(org, async t => (await t.query('SELECT 1 FROM chatwoot_connection_health WHERE organization_id=$1 AND channel_id=$2 AND identity_enforced', [org, channel])).rowCount);
      if (!enforced) return;
      await refresh(org, channel);
      const ready = await options.transact(org, async t => (await t.query<{ ready: boolean }>('SELECT chatwoot_channel_identity_ready($1,$2) AS ready', [org, channel])).rows[0]?.ready);
      if (!ready) throw new IntegrationError('IDENTITY_CONFIRMATION_REQUIRED', 409);
    },
    async runOnce(org: string) {
      const due = await options.transact(org, async t => (await t.query<{ channel_id: string }>(`SELECT channel_id FROM chatwoot_connection_health
        WHERE organization_id=$1 AND identity_enforced AND (observed_at IS NULL OR observed_at<now()-interval '30 seconds') ORDER BY observed_at NULLS FIRST LIMIT 4`, [org])).rows);
      // Each refresh owns short transactions; provider errors retain the protective state.
      await Promise.allSettled(due.map(row => refresh(org, row.channel_id)));
    },
  };
}
export type ChatwootHealth = ReturnType<typeof createChatwootHealth>;
