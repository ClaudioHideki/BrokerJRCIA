import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EmbedApproveSchema, EmbedChallengeSchema, EmbedVerifierSchema, type EmbedConnection, type EmbedExchangeResult } from '@jrc/contracts';
import { issueEmbedSessionToken } from '@jrc/security';
import type { AuthenticationContext } from '../../../http/plugins/authorization.js';
import type { TenantTransaction } from '../../../db/tenant-transaction.js';
import type { ChatwootControlPrincipal } from '../chatwoot-control-auth.js';
import { IntegrationError } from '../integration-error.js';
import { EmbedApps } from './apps.js';
import { EmbedRepository, embedDenied, type EmbedGrant, type EmbedOptions, type EmbedRequestRow } from './repository.js';
import { EmbedSessions, hashEmbedToken } from './session.js';

export function verifyEmbedProof(verifier: string, challenge: string): boolean {
  if (!EmbedVerifierSchema.safeParse(verifier).success || !EmbedChallengeSchema.safeParse(challenge).success) return false;
  const expected = createHash('sha256').update(verifier).digest(), received = Buffer.from(challenge, 'base64url');
  return received.toString('base64url') === challenge && received.length === expected.length && timingSafeEqual(expected, received);
}
const publicGrant = ({ integrationId, inboxId, name, canPair }: EmbedGrant): EmbedConnection => ({ integrationId, inboxId, name, canPair });
export class EmbedAuthorizationService {
  readonly repository: EmbedRepository;
  readonly apps: EmbedApps;
  readonly sessions: EmbedSessions;
  constructor(readonly options: EmbedOptions) {
    this.repository = new EmbedRepository(options); this.apps = new EmbedApps(this.repository); this.sessions = new EmbedSessions(this.repository, this.apps);
  }
  async start(embedId: string, challenge: string, clientIp: string) {
    this.repository.enabled(); z.uuid().parse(embedId); EmbedChallengeSchema.parse(challenge);
    if (Buffer.from(challenge, 'base64url').toString('base64url') !== challenge) throw embedDenied();
    const digest = createHmac('sha256', this.options.rateLimitSecret).update(JSON.stringify(['embed-start', clientIp, embedId])).digest('hex');
    if (!(await this.options.rateLimitStore.consume(`ip:${digest}`, 10, 60000)).allowed) throw new IntegrationError('EMBED_RATE_LIMITED', 429);
    const org = await this.repository.resolve('app', embedId);
    return this.options.transact(org, async tx => {
      await this.apps.current(tx, await this.repository.app(tx, embedId));
      const row = (await tx.query<{ id: string; expires_at: Date }>(
        'INSERT INTO chatwoot_embed_authorizations(organization_id,app_id,challenge) VALUES($1,$2,$3) RETURNING id,expires_at', [org, embedId, challenge])).rows[0]!;
      return { requestId: row.id, expiresAt: row.expires_at.toISOString() };
    });
  }
  async authenticatedRequest(tx: TenantTransaction, auth: AuthenticationContext, id: string, lock = false) {
    this.repository.enabled();
    if (auth.kind !== 'JWT') throw embedDenied();
    const request = await this.repository.request(tx, id, lock);
    if (auth.organizationId !== request.organization_id || request.state !== 'PENDING') throw embedDenied();
    const app = await this.repository.app(tx, request.app_id), current = await this.apps.current(tx, app);
    const principal: ChatwootControlPrincipal = { authentication: auth, organizationId: app.organization_id, accountId: Number(app.account_id),
      destinationRevision: app.destination_revision, chatwootOrigin: current.origin };
    await this.options.control.revalidate(tx, principal, 'chatwoot:read');
    return { request, principal, credentialVersion: current.account.credential_version };
  }
  async grant(tx: TenantTransaction, principal: ChatwootControlPrincipal, id: string): Promise<EmbedGrant> {
    await this.options.control.revalidate(tx, principal, 'chatwoot:read', id);
    const row = (await tx.query<{ id: string; inbox_id: string; name: string; identity_revision: number; approved_fingerprint: string | null }>(`
      SELECT c.id,c.inbox_id,c.name,COALESCE(h.identity_revision,1) AS identity_revision,h.approved_fingerprint FROM chatwoot_connections c
      LEFT JOIN chatwoot_connection_health h ON h.organization_id=c.organization_id AND h.integration_id=c.id
      JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.status='READY' AND c.inbox_id IS NOT NULL AND ch.provider='BAILEYS'`, [principal.organizationId, id])).rows[0];
    if (!row) throw embedDenied();
    let canPair = Boolean(row.approved_fingerprint);
    try { await this.options.control.revalidate(tx, principal, 'chatwoot:pair', id); }
    catch (error) { if (!(error instanceof IntegrationError && error.status === 403)) throw error; canPair = false; }
    return { integrationId: row.id, inboxId: Number(row.inbox_id), name: row.name, canPair,
      identityRevision: row.identity_revision, approvedFingerprint: row.approved_fingerprint };
  }
  async describe(auth: AuthenticationContext, requestId: string) {
    z.uuid().parse(requestId);
    return this.options.transact(auth.organizationId, async tx => {
      const { principal, request } = await this.authenticatedRequest(tx, auth, requestId);
      const ids = (await tx.query<{ id: string }>('SELECT id FROM chatwoot_connections WHERE organization_id=$1 ORDER BY id LIMIT 100', [auth.organizationId])).rows;
      const connections: EmbedConnection[] = [];
      for (const { id } of ids) {
        try { connections.push(publicGrant(await this.grant(tx, principal, id))); }
        catch (error) { if (!(error instanceof IntegrationError && [403, 404].includes(error.status))) throw error; }
      }
      return { requestId, expiresAt: request.expires_at.toISOString(), accountId: principal.accountId, chatwootOrigin: principal.chatwootOrigin, connections };
    });
  }
  async approve(auth: AuthenticationContext, requestId: string, integrationIds: string[]) {
    z.uuid().parse(requestId); const input = EmbedApproveSchema.parse({ integrationIds });
    return this.options.transact(auth.organizationId, async tx => {
      const { principal, credentialVersion } = await this.authenticatedRequest(tx, auth, requestId, true);
      const grants: EmbedGrant[] = [];
      for (const id of input.integrationIds) grants.push(await this.grant(tx, principal, id));
      const approved = await tx.query("UPDATE chatwoot_embed_authorizations SET state='APPROVED',approved_by=$2,credential_version=$3,grants=$4::jsonb WHERE id=$1 AND expires_at>clock_timestamp()",
        [requestId, auth.actorId, credentialVersion, JSON.stringify(grants)]);
      if (approved.rowCount !== 1) throw embedDenied();
      await this.options.control.audit(tx, principal, 'EMBED_AUTHORIZATION_APPROVED', requestId);
      return { ok: true as const };
    });
  }
  async deny(auth: AuthenticationContext, requestId: string) {
    z.uuid().parse(requestId);
    return this.options.transact(auth.organizationId, async tx => {
      const { principal } = await this.authenticatedRequest(tx, auth, requestId, true);
      await tx.query("UPDATE chatwoot_embed_authorizations SET state='DENIED' WHERE id=$1", [requestId]);
      await this.options.control.audit(tx, principal, 'EMBED_AUTHORIZATION_DENIED', requestId);
      return { ok: true as const };
    });
  }
  async approvedPrincipal(tx: TenantTransaction, request: EmbedRequestRow) {
    const app = await this.repository.app(tx, request.app_id), current = await this.apps.current(tx, app);
    if (!request.approved_by || !request.grants?.length || current.account.credential_version !== request.credential_version) throw embedDenied();
    const principal: ChatwootControlPrincipal = { authentication: { kind: 'JWT', actorId: request.approved_by, role: 'VIEWER', organizationId: request.organization_id },
      organizationId: app.organization_id, accountId: Number(app.account_id), destinationRevision: app.destination_revision, chatwootOrigin: current.origin };
    for (const grant of request.grants) await this.sessions.checkGrants(tx, principal, request.grants, grant.canPair ? 'chatwoot:pair' : 'chatwoot:read', grant.integrationId);
    return principal;
  }
  async exchange(requestId: string, verifier: string): Promise<EmbedExchangeResult> {
    z.uuid().parse(requestId); EmbedVerifierSchema.parse(verifier);
    const org = await this.repository.resolve('request', requestId);
    const result = await this.options.transact(org, async tx => {
      const request = await this.repository.request(tx, requestId, true);
      if (request.throttled) return { error: 'THROTTLED' as const };
      // Commit counters even on an invalid proof; throwing inside this transaction would undo them.
      if (!verifyEmbedProof(verifier, request.challenge)) {
        await tx.query(`UPDATE chatwoot_embed_authorizations SET failed_attempts=failed_attempts+1,next_exchange_at=clock_timestamp()+interval '1 second',
          state=CASE WHEN failed_attempts>=4 THEN 'DENIED' ELSE state END WHERE id=$1`, [requestId]);
        return { error: 'DENIED' as const };
      }
      await this.apps.current(tx, await this.repository.app(tx, request.app_id));
      await tx.query("UPDATE chatwoot_embed_authorizations SET next_exchange_at=clock_timestamp()+interval '1 second' WHERE id=$1", [requestId]);
      if (request.state === 'PENDING') return { status: 'PENDING' as const };
      const principal = await this.approvedPrincipal(tx, request), sessionId = randomUUID();
      const token = await issueEmbedSessionToken({
        tenantId: principal.organizationId,
        destinationRevision: principal.destinationRevision,
        accountId: principal.accountId,
        inboxIds: [...new Set(request.grants!.map(grant => grant.inboxId))],
        externalUserId: request.approved_by!,
        scopes: request.grants!.some(grant => grant.canPair) ? ['chatwoot:read', 'chatwoot:pair'] : ['chatwoot:read'],
        nonce: sessionId,
      }, this.options.sessionSigningSecret);
      const consumed = await tx.query("UPDATE chatwoot_embed_authorizations SET state='CONSUMED',consumed_at=clock_timestamp() WHERE id=$1 AND state='APPROVED' AND expires_at>clock_timestamp()", [requestId]);
      if (consumed.rowCount !== 1) throw embedDenied();
      const session = (await tx.query<{ expires_at: Date }>(`INSERT INTO chatwoot_embed_sessions(id,organization_id,app_id,authorization_id,user_id,token_hash,credential_version,grants)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING expires_at`, [sessionId, org, request.app_id, requestId, request.approved_by, hashEmbedToken(token), request.credential_version, JSON.stringify(request.grants)])).rows[0]!;
      await this.options.control.audit(tx, principal, 'EMBED_SESSION_ISSUED', requestId);
      return { status: 'AUTHORIZED' as const, token, expiresAt: session.expires_at.toISOString(), accountId: principal.accountId,
        connections: request.grants!.map(publicGrant) };
    });
    if ('error' in result) throw result.error === 'THROTTLED' ? new IntegrationError('EMBED_RATE_LIMITED', 429) : embedDenied();
    return result;
  }
}
export const createEmbedService = (options: EmbedOptions) => new EmbedAuthorizationService(options);
