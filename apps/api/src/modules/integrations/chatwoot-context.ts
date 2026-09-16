import type { ChatwootDestination } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { readChatwootDestination } from './chatwoot-destination.js';
import { IntegrationError } from './integration-error.js';

export interface AccountRow {
  organization_id: string;
  base_url: string;
  account_id: string | null;
  encrypted_token: string | null;
  status: 'PENDING' | 'READY' | 'FAILED' | 'UNKNOWN' | 'DISABLED';
  last_error: string | null;
  credential_version: number;
  destination: ChatwootDestination | undefined;
}

export function mayUsePlatformToken(v: { mode: 'MANAGED' | 'EXTERNAL'; origin: string; managedOrigin: string | null }): boolean {
  return v.mode === 'MANAGED' && v.origin === v.managedOrigin;
}

/** The single tenant lookup used by HTTP, jobs and attachment delivery. */
export async function resolveChatwootContext(tx: TenantTransaction, org: string, managedOrigin?: string) {
  const saved = await readChatwootDestination(tx, org);
  const row = (await tx.query<Omit<AccountRow, 'destination'>>(
    'SELECT organization_id,base_url,account_id,encrypted_token,status,last_error,credential_version FROM chatwoot_accounts WHERE organization_id=$1', [org],
  )).rows[0];
  // Only an unbound legacy tenant may inherit the operator-configured origin.
  const destination = saved ?? (!row && managedOrigin ? {
    organizationId: org, baseUrl: managedOrigin, mode: 'MANAGED' as const,
    approvalStatus: 'APPROVED' as const, mediaOrigins: [], revision: 1,
  } : undefined);
  return { destination, account: row ? { ...row, destination: saved } : undefined };
}

export function requireApprovedDestination(destination: ChatwootDestination | undefined, org: string, managedOrigin?: string) {
  if (!destination || destination.organizationId !== org)
    throw new IntegrationError('CHATWOOT_DESTINATION_REQUIRED', 409);
  if (destination.approvalStatus !== 'APPROVED')
    throw new IntegrationError('CHATWOOT_DESTINATION_NOT_APPROVED', 409);
  if (destination.mode === 'MANAGED' && destination.baseUrl !== managedOrigin)
    throw new IntegrationError('INVALID_MANAGED_DESTINATION', 409);
  return destination;
}

export async function readChatwootAccount(tx: TenantTransaction, org: string) {
  return (await resolveChatwootContext(tx, org)).account;
}
