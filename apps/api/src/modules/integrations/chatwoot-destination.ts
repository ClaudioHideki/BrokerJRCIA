import { isIP } from 'node:net';
import type { ChatwootDestination } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';

export class ChatwootDestinationError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code); }
}

/** Syntactic policy only. The transport must also validate and pin DNS answers. */
export function normalizeChatwootOrigin(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new ChatwootDestinationError('INVALID_CHATWOOT_ORIGIN'); }
  const host = u.hostname;
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) || u.protocol !== 'https:' ||
    u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.port ||
    isIP(host.replace(/^\[|\]$/g, '')) || host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|home|lan|onion)$/.test(host)) {
    throw new ChatwootDestinationError('INVALID_CHATWOOT_ORIGIN');
  }
  return u.origin;
}

export async function readChatwootDestination(t: TenantTransaction, org: string): Promise<ChatwootDestination | undefined> {
  return (await t.query<ChatwootDestination>(`SELECT organization_id AS "organizationId", base_url AS "baseUrl", mode,
    approval_status AS "approvalStatus", media_origins AS "mediaOrigins", revision
    FROM chatwoot_destinations WHERE organization_id=$1`, [org])).rows[0];
}

export function createChatwootDestinationService(options: {
  enabled: boolean;
  managedOrigin?: string | undefined;
  transact<T>(org: string, operation: OrganizationTransaction<T>): Promise<T>;
}) {
  const requireEnabled = () => {
    if (!options.enabled) throw new ChatwootDestinationError('CHATWOOT_EXTERNAL_DESTINATIONS_DISABLED', 404);
  };
  return {
    enabled: options.enabled,
    async get(org: string) {
      requireEnabled();
      return options.transact(org, t => readChatwootDestination(t, org));
    },
    async request(org: string, input: { baseUrl: string; mode: 'MANAGED' | 'EXTERNAL' }) {
      requireEnabled();
      const baseUrl = normalizeChatwootOrigin(input.baseUrl);
      if (input.mode === 'MANAGED' && baseUrl !== options.managedOrigin)
        throw new ChatwootDestinationError('INVALID_MANAGED_DESTINATION');
      return options.transact(org, async t => {
        await requireActiveOrganization(t, org);
        // No UPDATE privilege on organizations is required for this tenant-scoped lock.
        await lockChatwootDestination(t, org);
        const current = await readChatwootDestination(t, org);
        if (current?.baseUrl === baseUrl && current.mode === input.mode) return current;
        const busy = await t.query(`SELECT 1 FROM chatwoot_connections WHERE organization_id=$1
            UNION ALL SELECT 1 FROM chatwoot_provisioning WHERE organization_id=$1 AND state IN ('PENDING','RUNNING','UNKNOWN')
            UNION ALL SELECT 1 FROM chatwoot_onboarding_operations WHERE organization_id=$1 AND NOT cancel_requested AND state<>'SUCCEEDED' LIMIT 1`, [org]);
        if (busy.rowCount) throw new ChatwootDestinationError('DESTINATION_IN_USE', 409);
        await t.query(`INSERT INTO chatwoot_destinations(organization_id,base_url,mode) VALUES($1,$2,$3)
          ON CONFLICT(organization_id) DO UPDATE SET base_url=$2,mode=$3`, [org, baseUrl, input.mode]);
        // Old credentials must never follow a new origin. The FK is checked at commit.
        await t.query(`UPDATE chatwoot_accounts SET base_url=$2,account_id=NULL,encrypted_token=NULL,status='PENDING',
          capabilities='{}',capabilities_verified_at=NULL,credential_version=credential_version+1,updated_at=now()
          WHERE organization_id=$1`, [org, baseUrl]);
        return (await readChatwootDestination(t, org))!;
      });
    },
  };
}

export async function lockChatwootDestination(t: TenantTransaction, org: string) {
  await t.query("SELECT pg_advisory_xact_lock(hashtextextended('chatwoot-destination:'||$1,0))", [org]);
}
