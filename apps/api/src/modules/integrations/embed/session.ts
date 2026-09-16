import { createHash } from 'node:crypto';
import type { ChatwootControlScope } from '@jrc/contracts';
import type { TenantTransaction } from '../../../db/tenant-transaction.js';
import type { AuthenticationContext } from '../../../http/plugins/authorization.js';
import type { ChatwootControlPrincipal } from '../chatwoot-control-auth.js';
import { EmbedApps } from './apps.js';
import { EmbedRepository, embedDenied, type EmbedGrant, type EmbedSessionRow } from './repository.js';

export const hashEmbedToken = (token: string) => createHash('sha256').update(token).digest('hex');
export class EmbedSessions {
  constructor(readonly repository: EmbedRepository, readonly apps: EmbedApps) {}
  async checkGrants(tx: TenantTransaction, principal: ChatwootControlPrincipal, grants: EmbedGrant[], scope: ChatwootControlScope, id: string) {
    if (scope !== 'chatwoot:read' && scope !== 'chatwoot:pair') throw embedDenied();
    const grant = grants.find(g => g.integrationId === id);
    if (!grant || (scope === 'chatwoot:pair' && !grant.canPair)) throw embedDenied();
    await this.repository.options.control.revalidate(tx, principal, scope, id);
    const current = (await tx.query<{ identity_revision: number; approved_fingerprint: string | null }>(
      'SELECT identity_revision,approved_fingerprint FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2', [principal.organizationId, id])).rows[0];
    if ((current?.identity_revision ?? 1) !== grant.identityRevision || (current?.approved_fingerprint ?? null) !== grant.approvedFingerprint) throw embedDenied();
  }
  async validate(tx: TenantTransaction, tokenHash: string, id: string, scope: ChatwootControlScope) {
    this.repository.enabled();
    const session = (await tx.query<EmbedSessionRow>('SELECT *,expires_at<=clock_timestamp() AS expired FROM chatwoot_embed_sessions WHERE token_hash=$1', [tokenHash])).rows[0];
    if (!session || session.expired || session.revoked_at) throw embedDenied();
    const app = await this.repository.app(tx, session.app_id), current = await this.apps.current(tx, app);
    if (current.account.credential_version !== session.credential_version) throw embedDenied();
    // Role is resolved afresh by control auth; the placeholder never grants authority.
    const authentication: AuthenticationContext = { kind: 'JWT', actorId: session.user_id, organizationId: session.organization_id, role: 'VIEWER' };
    const principal: ChatwootControlPrincipal = { authentication, organizationId: app.organization_id, accountId: Number(app.account_id),
      destinationRevision: app.destination_revision, chatwootOrigin: current.origin };
    await this.checkGrants(tx, principal, session.grants, scope, id);
    return principal;
  }
  async authorize(token: string, id: string, scope: ChatwootControlScope): Promise<ChatwootControlPrincipal> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw embedDenied();
    const hash = hashEmbedToken(token), org = await this.repository.resolve('session', hash);
    const principal = await this.repository.options.transact(org, tx => this.validate(tx, hash, id, scope));
    return Object.freeze({ ...principal, restriction: async (tx: TenantTransaction, action: ChatwootControlScope, integrationId?: string) => {
      if (!integrationId) throw embedDenied();
      await this.validate(tx, hash, integrationId, action);
    } });
  }
}
