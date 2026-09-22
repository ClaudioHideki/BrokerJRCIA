import type { Pool } from 'pg';
import type { EmbedConnection } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../../db/tenant-transaction.js';
import type { ChatwootControlAuth } from '../chatwoot-control-auth.js';
import type { RateLimitStore } from '../../auth/rate-limit/store.js';
import { IntegrationError } from '../integration-error.js';
import type { ChatwootClient } from '../chatwoot-client.js';
import type { AccountRow } from '../chatwoot-context.js';

export const embedDenied = () => new IntegrationError('EMBED_AUTHORIZATION_DENIED', 403);
export interface EmbedOptions {
  enabled: boolean; pool: Pool; control: ChatwootControlAuth; managedOrigin?: string | undefined;
  rateLimitStore: RateLimitStore; rateLimitSecret: string;
  sessionSigningSecret: string;
  publicOrigin?: string | undefined;
  dashboardClient?: ((account: AccountRow) => ChatwootClient) | undefined;
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
}
export interface EmbedAppRow { id: string; organization_id: string; account_id: string; destination_revision: number; active: boolean }
export interface EmbedGrant extends EmbedConnection { identityRevision: number; approvedFingerprint: string | null }
export interface EmbedRequestRow {
  id: string; app_id: string; organization_id: string; challenge: string; state: 'PENDING' | 'APPROVED' | 'DENIED' | 'CONSUMED';
  approved_by: string | null; credential_version: number | null; grants: EmbedGrant[] | null; expires_at: Date;
  expired: boolean; throttled: boolean; failed_attempts: number;
}
export interface EmbedSessionRow {
  id: string; app_id: string; organization_id: string; user_id: string; credential_version: number;
  grants: EmbedGrant[]; expires_at: Date; revoked_at: Date | null; expired: boolean;
}
export class EmbedRepository {
  constructor(readonly options: EmbedOptions) {}
  enabled() { if (!this.options.enabled || !this.options.control.enabled) throw new IntegrationError('CHATWOOT_EMBED_DISABLED', 404); }
  async resolve(kind: 'app' | 'request' | 'session', value: string): Promise<string> {
    this.enabled();
    const functions = { app: 'resolve_chatwoot_embed_app', request: 'resolve_chatwoot_embed_request', session: 'resolve_chatwoot_embed_session' } as const;
    const row = (await this.options.pool.query<{ organization_id: string }>(`SELECT organization_id FROM ${functions[kind]}($1)`, [value])).rows[0];
    if (!row) throw embedDenied(); return row.organization_id;
  }
  async app(tx: TenantTransaction, id: string) {
    const row = (await tx.query<EmbedAppRow>('SELECT * FROM chatwoot_embed_apps WHERE id=$1', [id])).rows[0];
    if (!row) throw embedDenied(); return row;
  }
  async request(tx: TenantTransaction, id: string, lock = false) {
    const row = (await tx.query<EmbedRequestRow>(`SELECT *,expires_at<=clock_timestamp() AS expired,COALESCE(next_exchange_at>clock_timestamp(),false) AS throttled
      FROM chatwoot_embed_authorizations WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row || row.expired || ['DENIED', 'CONSUMED'].includes(row.state)) throw embedDenied(); return row;
  }
}
