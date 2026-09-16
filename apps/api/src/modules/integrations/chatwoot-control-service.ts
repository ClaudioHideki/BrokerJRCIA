import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ControlIdempotencyKeySchema, ControlAgentIdsSchema, type ChatwootControlScope, type ConnectionHealth } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { ChatwootControlAuth, ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import { InstanceServiceError, type InstanceService } from '../instances/service.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';
import { chatwootEnvironment, type ChatwootOptions, type ChatwootService, type ConnectionRow } from './chatwoot-service.js';
import { readChatwootAccount } from './chatwoot-context.js';
import { readChatwootHealth, identityStatus, deriveTransportStatus, type ChatwootHealth } from './chatwoot-health.js';
import { IntegrationError } from './integration-error.js';
import { ChatwootError } from './chatwoot-client.js';

export interface ChatwootControlOptions extends ChatwootOptions { auth: ChatwootControlAuth; health: ChatwootHealth; instances: InstanceService; chatwoot: ChatwootService }
interface Mapping extends ConnectionRow { instance_id: string }
export function createChatwootControlService(options: ChatwootControlOptions) {
  const env = chatwootEnvironment(options), tx = options.transact;
  async function mapping(t: TenantTransaction, p: ChatwootControlPrincipal, id: string, scope: ChatwootControlScope): Promise<Mapping> {
    await options.auth.revalidate(t, p, scope, id);
    const row = (await t.query<Mapping>(`SELECT c.*,ch.instance_id FROM chatwoot_connections c JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
      WHERE c.organization_id=$1 AND c.id=$2 AND ch.provider='BAILEYS' AND ch.instance_id IS NOT NULL`, [p.organizationId, id])).rows[0];
    if (!row) throw new IntegrationError('CONTROL_QR_INTEGRATION_NOT_FOUND', 404);
    return row;
  }
  const delegated = (p: ChatwootControlPrincipal, id: string) => options.auth.delegate(p, { requestId: randomUUID(), deadline: new Date(Date.now() + 30000), signal: AbortSignal.timeout(30000) }, id);
  async function can(t: TenantTransaction, p: ChatwootControlPrincipal, id: string, scope: ChatwootControlScope) {
    try { await options.auth.revalidate(t, p, scope, id); return true; }
    catch (error) { if (error instanceof IntegrationError && error.status === 403) return false; throw error; }
  }
  async function prepare(p: ChatwootControlPrincipal, id: string, scope: ChatwootControlScope) {
    const c = await tx(p.organizationId, t => mapping(t, p, id, scope));
    if (c.status !== 'READY' || !c.inbox_id || !c.encrypted_webhook_secret) throw new IntegrationError('CHATWOOT_WEBHOOK_NOT_READY', 409);
    const a = await tx(p.organizationId, t => readChatwootAccount(t, p.organizationId));
    if (!a) throw new IntegrationError('CHATWOOT_ACCOUNT_NOT_READY', 409);
    try {
      const client = env.client(a);
      await client.verifyAccount(p.accountId);
      const remote = await client.getInbox(p.accountId, Number(c.inbox_id));
      const localSecret = Buffer.from(env.vault.decrypt(`${p.organizationId}:chatwoot-webhook:${id}`, c.encrypted_webhook_secret));
      const remoteSecret = Buffer.from(remote.secret ?? '');
      if (remote.channel_type !== 'Channel::Api' || remote.webhook_url !== env.callback(id) || !remoteSecret.length ||
        remoteSecret.length !== localSecret.length || !timingSafeEqual(remoteSecret, localSecret)) throw new IntegrationError('CHATWOOT_WEBHOOK_NOT_READY', 409);
      await tx(p.organizationId, async t => {
        await mapping(t, p, id, scope);
        const current = await readChatwootAccount(t, p.organizationId);
        if (current?.credential_version !== a.credential_version) throw new IntegrationError('CHATWOOT_CONTEXT_CHANGED', 409);
        await t.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id) VALUES($1,$2,$3)
          ON CONFLICT(organization_id,integration_id) DO UPDATE SET access_error=NULL`, [p.organizationId, id, c.channel_id]);
      });
    } catch (failure) {
      const code = failure instanceof IntegrationError || failure instanceof ChatwootError ? failure.code : 'CHATWOOT_ACCESS_UNVERIFIED';
      await tx(p.organizationId, t => t.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,access_error) VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id,integration_id) DO UPDATE SET access_error=$4`, [p.organizationId, id, c.channel_id, code]));
      throw failure;
    }
    return c;
  }
  return {
    async status(p: ChatwootControlPrincipal, id: string): Promise<ConnectionHealth> {
      const c = await tx(p.organizationId, async t => {
        const mapped = await mapping(t, p, id, 'chatwoot:read');
        await t.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [p.organizationId, id, mapped.channel_id]);
        return mapped;
      });
      let instance = await options.instances.getInstance(delegated(p, id), c.instance_id);
      try { instance = await options.instances.getInstanceStatus(delegated(p, id), c.instance_id); }
      catch (error) { if (!(error instanceof InstanceServiceError)) throw error; }
      try { await options.health.refresh(p.organizationId, c.channel_id); }
      catch (error) { if (!(error instanceof IntegrationError && error.code === 'IDENTITY_UNVERIFIED')) throw error; }
      return tx(p.organizationId, async t => {
        await mapping(t, p, id, 'chatwoot:read');
        const h = (await readChatwootHealth(t, p.organizationId, id))!;
        const a = (await readChatwootAccount(t, p.organizationId))!;
        const evidence = (await t.query<{ incoming: Date | null; outgoing: Date | null; failure: boolean }>(`SELECT
          (SELECT max(j.updated_at) FROM integration_jobs j JOIN messaging_messages m ON m.organization_id=j.organization_id AND m.id=j.message_id
            WHERE j.organization_id=$1 AND j.integration_id=$2 AND j.kind='MIRROR_MESSAGE' AND j.status='SUCCEEDED' AND m.direction='INCOMING'
              AND m.created_at>=COALESCE((SELECT max(created_at) FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'),'infinity'::timestamptz)) AS incoming,
          (SELECT max(m.updated_at) FROM chatwoot_messages cw JOIN messaging_messages m ON m.organization_id=cw.organization_id AND m.id=cw.message_id
            WHERE cw.organization_id=$1 AND cw.integration_id=$2 AND m.direction='OUTGOING' AND m.state IN ('SENT','DELIVERED','READ')
              AND m.created_at>=COALESCE((SELECT max(created_at) FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'),'infinity'::timestamptz)) AS outgoing,
          (EXISTS(SELECT 1 FROM integration_jobs WHERE organization_id=$1 AND integration_id=$2 AND status IN ('FAILED','UNKNOWN'))
            OR EXISTS(SELECT 1 FROM chatwoot_messages cw JOIN messaging_messages m ON m.organization_id=cw.organization_id AND m.id=cw.message_id
              WHERE cw.organization_id=$1 AND cw.integration_id=$2 AND m.state IN ('FAILED','UNKNOWN'))) AS failure`, [p.organizationId, id])).rows[0]!;
        const manage = await can(t, p, id, 'chatwoot:manage');
        const identity = identityStatus(h), allowedActions: ConnectionHealth['allowedActions'] = ['status'];
        const bindingApproved = Boolean(h.approved_fingerprint) && identity !== 'CONFIRMATION_REQUIRED' && !(h.observed_connected && h.identity_error);
        if (((manage && !h.approved_fingerprint) || bindingApproved) && await can(t, p, id, 'chatwoot:pair')) allowedActions.push('pair');
        if (await can(t, p, id, 'chatwoot:disconnect')) allowedActions.push('disconnect');
        if (manage) allowedActions.push('manage');
        const callback = h.callback_destination_revision === p.destinationRevision && h.callback_credential_version === a.credential_version ? h.callback_verified_at : null;
        const recent = (date: Date | null) => Boolean(date && date.getTime() > Date.now() - 86400000);
        const lastError = h.identity_error ?? h.access_error ?? c.last_error;
        return { integrationId: id, inboxId: c.inbox_id ? Number(c.inbox_id) : null, instanceId: c.instance_id, integrationStatus: c.status, instanceStatus: instance.status,
          callbackVerifiedAt: callback?.toISOString() ?? null, lastSuccessfulInboundAt: evidence.incoming?.toISOString() ?? null, lastSuccessfulOutboundAt: evidence.outgoing?.toISOString() ?? null,
          transportStatus: deriveTransportStatus({ integrationReady: c.status === 'READY', connected: instance.status === 'CONNECTED' && h.observed_connected && identity === 'CONFIRMED',
            callbackVerified: Boolean(callback), recentInbound: recent(evidence.incoming), recentOutbound: recent(evidence.outgoing), activeFailure: Boolean(lastError) || evidence.failure }),
          checkedAt: new Date().toISOString(), lastError, allowedActions, identityStatus: identity, identityRevision: h.identity_revision, observedNumberSuffix: h.observed_last4 };
      });
    },
    async pair(p: ChatwootControlPrincipal, id: string, key: string) {
      ControlIdempotencyKeySchema.parse(key);
      const c = await tx(p.organizationId, async t => {
        const mapped = await mapping(t, p, id, 'chatwoot:pair'), h = await readChatwootHealth(t, p.organizationId, id);
        if (!h?.approved_fingerprint && !await can(t, p, id, 'chatwoot:manage')) throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
        return mapped;
      });
      await prepare(p, id, 'chatwoot:pair');
      await options.health.refresh(p.organizationId, c.channel_id);
      const providerKey = await tx(p.organizationId, async t => {
        await mapping(t, p, id, 'chatwoot:pair');
        const h = await readChatwootHealth(t, p.organizationId, id);
        if (h?.approved_fingerprint && (identityStatus(h) === 'CONFIRMATION_REQUIRED' || (h.observed_connected && h.identity_error)))
          throw new IntegrationError('IDENTITY_CONFIRMATION_REQUIRED', 409);
        await options.health.enroll(t, p.organizationId, id);
        const claimed = await claimIdempotency(t, { organizationId: p.organizationId, route: `chatwoot-pair:${id}`, key,
          requestHash: hashIdempotencyRequest({ id }), expiresAt: new Date(Date.now() + 86400000) });
        if (claimed.kind === 'REPLAY') {
          const childKey = claimed.record.responseMetadata.providerKey;
          if (typeof childKey !== 'string') throw new IntegrationError('PAIR_RECONCILIATION_REQUIRED', 409);
          return childKey;
        }
        const window = (await t.query<{ pair_window_key: string | null; active: boolean }>(`SELECT pair_window_key,pair_window_expires_at>now() AS active
          FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2 FOR UPDATE`, [p.organizationId, id])).rows[0]!;
        const childKey = window.active && window.pair_window_key ? window.pair_window_key : randomUUID();
        if (!window.active || !window.pair_window_key) await t.query(`UPDATE chatwoot_connection_health SET pair_window_key=$3,pair_window_expires_at=now()+interval '60 seconds'
          WHERE organization_id=$1 AND integration_id=$2`, [p.organizationId, id, childKey]);
        await completeIdempotencyRecord(t, { organizationId: p.organizationId, recordId: claimed.recordId, status: 'COMPLETED', responseMetadata: { providerKey: childKey } });
        return childKey;
      });
      const result = await options.instances.connectInstance(delegated(p, id), { instanceId: c.instance_id, idempotencyKey: `cw:${id}:${providerKey}` });
      const expiry = 'expiresAt' in result.action ? result.action.expiresAt : null;
      if (expiry) await tx(p.organizationId, t => t.query(`UPDATE chatwoot_connection_health SET pair_window_expires_at=LEAST(pair_window_expires_at,$4)
        WHERE organization_id=$1 AND integration_id=$2 AND pair_window_key=$3`, [p.organizationId, id, providerKey, expiry]));
      return result;
    },
    async disconnect(p: ChatwootControlPrincipal, id: string, key: string) {
      ControlIdempotencyKeySchema.parse(key);
      const c = await tx(p.organizationId, t => mapping(t, p, id, 'chatwoot:disconnect'));
      const result = await options.instances.disconnectInstance(delegated(p, id), { instanceId: c.instance_id, idempotencyKey: `cw:${id}:${key}` });
      await tx(p.organizationId, t => options.health.observe(t, p.organizationId, c.channel_id, { connected: false, phone: null }));
      return result;
    },
    async confirmIdentity(p: ChatwootControlPrincipal, id: string, revision: number, key: string) {
      const c = await prepare(p, id, 'chatwoot:manage');
      await options.health.refresh(p.organizationId, c.channel_id);
      await tx(p.organizationId, async t => {
        await mapping(t, p, id, 'chatwoot:manage');
        const claim = await claimIdempotency(t, { organizationId: p.organizationId, route: `chatwoot-identity:${id}`, key: ControlIdempotencyKeySchema.parse(key),
          requestHash: hashIdempotencyRequest({ revision }), expiresAt: new Date(Date.now() + 86400000) });
        if (claim.kind === 'REPLAY') return;
        const updated = await t.query(`UPDATE chatwoot_connection_health SET approved_fingerprint=observed_fingerprint,identity_enforced=true,identity_error=NULL,
          callback_verified_at=NULL,callback_destination_revision=NULL,callback_credential_version=NULL,updated_at=now()
          WHERE organization_id=$1 AND integration_id=$2 AND identity_revision=$3 AND observed_connected AND observed_fingerprint IS NOT NULL`, [p.organizationId, id, revision]);
        if (!updated.rowCount) throw new IntegrationError('IDENTITY_OBSERVATION_CHANGED', 409);
        await options.auth.audit(t, p, 'CONTROL_IDENTITY_CONFIRMED', id);
        await completeIdempotencyRecord(t, { organizationId: p.organizationId, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { ok: true } });
      });
      return { ok: true as const };
    },
    async agents(p: ChatwootControlPrincipal, id: string, value: number[], key: string) {
      const ids = ControlAgentIdsSchema.parse(value);
      await prepare(p, id, 'chatwoot:manage');
      const claim = await tx(p.organizationId, async t => {
        await mapping(t, p, id, 'chatwoot:manage');
        return claimIdempotency(t, { organizationId: p.organizationId, route: `chatwoot-control-agents:${id}`, key: ControlIdempotencyKeySchema.parse(key), requestHash: hashIdempotencyRequest(ids), expiresAt: new Date(Date.now() + 86400000) });
      });
      if (claim.kind === 'REPLAY') {
        if (claim.record.status !== 'COMPLETED') throw new IntegrationError('CHATWOOT_AGENTS_RECONCILIATION_REQUIRED', 409);
        return { ok: true as const };
      }
      // The remote write is outside the transaction; an uncertain result cannot trigger a blind replay.
      if (ids.length) await options.chatwoot.addAgents(p.organizationId, id, ids, p.authentication.actorId ?? undefined);
      await tx(p.organizationId, async t => {
        await mapping(t, p, id, 'chatwoot:manage'); await options.auth.audit(t, p, 'CONTROL_AGENTS_CHANGED', id);
        await completeIdempotencyRecord(t, { organizationId: p.organizationId, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { ok: true } });
      });
      return { ok: true as const };
    },
  };
}
export type ChatwootControlService = ReturnType<typeof createChatwootControlService>;
