import { createOrganizationApiKey } from '@jrc/security';
import { IssueControlCredentialSchema, OperatorGrantsSchema, ControlIdempotencyKeySchema, type ChatwootControlScope } from '@jrc/contracts';
import type { z } from 'zod';
import type { AuthenticationContext, Role } from '../../http/plugins/authorization.js';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { createPostgresApiKeyRepository } from '../api-keys/repository.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';
import { resolveChatwootContext, requireApprovedDestination } from './chatwoot-context.js';
import { lockChatwootDestination } from './chatwoot-destination.js';
import { IntegrationError } from './integration-error.js';
import type { InstanceActorContext } from '../instances/service.js';
import { publicChatwootCapabilities } from './chatwoot-compatibility.js';

export function authorizeControlRequest(v: {
  credential: { organizationId: string; scopes: readonly string[]; revoked: boolean };
  binding: { organizationId: string; active: boolean; destinationRevision: number };
  requestedOrganizationId: string; requiredScope: string;
}): boolean {
  return !v.credential.revoked && v.binding.active &&
    v.credential.organizationId === v.binding.organizationId &&
    v.binding.organizationId === v.requestedOrganizationId && v.credential.scopes.includes(v.requiredScope);
}

export interface ChatwootControlPrincipal {
  readonly organizationId: string;
  readonly accountId: number;
  readonly destinationRevision: number;
  readonly chatwootOrigin: string;
  readonly authentication: AuthenticationContext;
  readonly externalActorId?: string;
  /** Server-created restrictions (e.g. short embed session), rechecked at each delegated action. */
  readonly restriction?: (tx: TenantTransaction, scope: ChatwootControlScope, integrationId?: string) => Promise<void>;
}

export interface ChatwootControlAuthOptions {
  enabled: boolean;
  managedOrigin?: string | undefined;
  hmacSecret: string;
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  resolveCurrentRole(userId: string, org: string): Promise<Role | null>;
}

export function createChatwootControlAuth(options: ChatwootControlAuthOptions) {
  const repository = createPostgresApiKeyRepository();
  const denied = () => new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
  const enabled = () => { if (!options.enabled) throw new IntegrationError('CHATWOOT_CONTROL_DISABLED', 404); };
  async function authorizeInTransaction(tx: TenantTransaction, authentication: AuthenticationContext, scope: ChatwootControlScope,
    integrationId?: string, externalActorId?: string): Promise<ChatwootControlPrincipal> {
    enabled();
    const org = authentication.organizationId;
    await requireActiveOrganization(tx, org);
    const context = await resolveChatwootContext(tx, org, options.managedOrigin);
    const destination = requireApprovedDestination(context.destination, org, options.managedOrigin);
    const account = context.account;
    if (!account?.account_id || !account.encrypted_token || account.status !== 'READY' || account.base_url !== destination.baseUrl)
      throw new IntegrationError('CHATWOOT_ACCOUNT_NOT_READY', 409);
    if (integrationId && !(await tx.query('SELECT 1 FROM chatwoot_connections WHERE organization_id=$1 AND id=$2', [org, integrationId])).rowCount)
      throw new IntegrationError('INTEGRATION_NOT_FOUND', 404);
    if (authentication.kind === 'JWT') {
      const role = await options.resolveCurrentRole(authentication.actorId, org);
      if (!role) throw denied();
      if (!['OWNER', 'ADMIN'].includes(role)) {
        if (!integrationId) { if (scope !== 'chatwoot:read') throw denied(); }
        else {
          const grant = (await tx.query<{ can_pair: boolean }>(`SELECT can_pair FROM chatwoot_operator_grants
            WHERE organization_id=$1 AND integration_id=$2 AND user_id=$3`, [org, integrationId, authentication.actorId])).rows[0];
          if (!grant || (scope !== 'chatwoot:read' && (scope !== 'chatwoot:pair' || !grant.can_pair))) throw denied();
        }
      }
    } else {
      const row = (await tx.query<{ organization_id: string; scopes: string[]; revoked: boolean; active: boolean; account_id: string; destination_revision: number }>(`
        SELECT k.organization_id,k.scopes,(k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=now())) AS revoked,
          b.active,b.account_id,b.destination_revision FROM api_keys k JOIN chatwoot_control_bindings b
          ON b.organization_id=k.organization_id AND b.api_key_id=k.id WHERE k.organization_id=$1 AND k.id=$2`, [org, authentication.apiKeyId])).rows[0];
      if (!row || !authorizeControlRequest({ credential: { organizationId: row.organization_id, scopes: row.scopes, revoked: row.revoked },
        binding: { organizationId: row.organization_id, active: row.active, destinationRevision: row.destination_revision }, requestedOrganizationId: org, requiredScope: scope }) ||
        Number(row.account_id) !== Number(account.account_id) || row.destination_revision !== destination.revision) throw denied();
    }
    if (externalActorId !== undefined && (authentication.kind !== 'API_KEY' || !/^[A-Za-z0-9:_-]{1,80}$/.test(externalActorId))) throw denied();
    return Object.freeze({ organizationId: org, accountId: Number(account.account_id), destinationRevision: destination.revision,
      chatwootOrigin: destination.baseUrl, authentication, ...(externalActorId === undefined ? {} : { externalActorId }) });
  }
  async function audit(tx: TenantTransaction, principal: ChatwootControlPrincipal, action: string, resourceId: string | null) {
    const a = principal.authentication;
    await tx.query(`INSERT INTO integration_audit(organization_id,actor_id,actor_api_key_id,external_actor_id,action,resource_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,'Authorized Chatwoot control action')`, [principal.organizationId, a.actorId,
      a.kind === 'API_KEY' ? a.apiKeyId : null, principal.externalActorId ?? null, action, resourceId]);
  }
  return {
    enabled: options.enabled,
    audit,
    async authorize(authentication: AuthenticationContext, scope: ChatwootControlScope, integrationId?: string, externalActorId?: string) {
      return options.transact(authentication.organizationId, tx => authorizeInTransaction(tx, authentication, scope, integrationId, externalActorId));
    },
    async revalidate(tx: TenantTransaction, principal: ChatwootControlPrincipal, scope: ChatwootControlScope, integrationId?: string) {
      await principal.restriction?.(tx, scope, integrationId);
      const current = await authorizeInTransaction(tx, principal.authentication, scope, integrationId, principal.externalActorId);
      if (current.accountId !== principal.accountId || current.destinationRevision !== principal.destinationRevision || current.chatwootOrigin !== principal.chatwootOrigin)
        throw denied();
      return current;
    },
    async context(authentication: AuthenticationContext) {
      const principal = await this.authorize(authentication, 'chatwoot:read');
      return options.transact(principal.organizationId, async tx => {
        await this.revalidate(tx, principal, 'chatwoot:read');
        const { account } = await resolveChatwootContext(tx, principal.organizationId, options.managedOrigin);
        return { organizationId: principal.organizationId, accountId: principal.accountId, destinationRevision: principal.destinationRevision,
          chatwootOrigin: principal.chatwootOrigin, capabilities: publicChatwootCapabilities(account!) };
      });
    },
    async resources(authentication: AuthenticationContext) {
      return options.transact(authentication.organizationId, async tx => {
        await authorizeInTransaction(tx, authentication, 'chatwoot:manage');
        const org = authentication.organizationId;
        const providers = (await tx.query<{ id: string; name: string }>(
          "SELECT id,name FROM provider_accounts WHERE organization_id=$1 AND provider='BAILEYS' ORDER BY name,id LIMIT 500", [org])).rows;
        const instances = (await tx.query<{ id: string; name: string; status: string }>(`SELECT i.id,i.name,i.status FROM instances i
          JOIN provider_accounts p ON p.organization_id=i.organization_id AND p.id=i.provider_account_id
          WHERE i.organization_id=$1 AND p.provider='BAILEYS' AND i.status NOT IN ('PROVISIONING','PROVISIONING_FAILED')
          AND NOT EXISTS(SELECT 1 FROM messaging_channels ch JOIN chatwoot_connections c ON c.organization_id=ch.organization_id AND c.channel_id=ch.id
            WHERE ch.organization_id=i.organization_id AND ch.instance_id=i.id)
          AND NOT EXISTS(SELECT 1 FROM chatwoot_onboarding_operations op WHERE op.organization_id=i.organization_id AND op.instance_id=i.id
            AND op.state<>'SUCCEEDED' AND NOT op.cancel_requested) ORDER BY i.name,i.id LIMIT 500`, [org])).rows;
        const connections = (await tx.query<{ integrationId: string; inboxId: number; instanceId: string; name: string }>(`SELECT
          c.id AS "integrationId", c.inbox_id::integer AS "inboxId", ch.instance_id AS "instanceId", c.name
          FROM chatwoot_connections c JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
          WHERE c.organization_id=$1 AND c.status='READY' AND c.inbox_id IS NOT NULL
          AND ch.provider='BAILEYS' AND ch.instance_id IS NOT NULL ORDER BY c.name,c.id LIMIT 500`, [org])).rows;
        return { providers, instances, connections };
      });
    },
    delegate(principal: ChatwootControlPrincipal, request: { requestId: string; deadline: Date; signal: AbortSignal }, integrationId?: string): InstanceActorContext {
      const service = this;
      return { ...request, organizationId: principal.organizationId, credentialKind: 'CHATWOOT_CONTROL',
        actorId: principal.authentication.actorId,
        ...(principal.authentication.kind === 'API_KEY' ? { apiKeyId: principal.authentication.apiKeyId } : {}),
        async authorize(tx, operation, instanceId) {
          const scope: ChatwootControlScope = !integrationId ? 'chatwoot:manage' : operation === 'pair' ? 'chatwoot:pair'
            : operation === 'disconnect' ? 'chatwoot:disconnect' : 'chatwoot:read';
          await service.revalidate(tx, principal, scope, integrationId);
          if (integrationId) {
            if (!instanceId || operation === 'create' || operation === 'list') throw denied();
            const mapped = await tx.query(`SELECT 1 FROM chatwoot_connections c JOIN messaging_channels ch
              ON ch.organization_id=c.organization_id AND ch.id=c.channel_id
              WHERE c.organization_id=$1 AND c.id=$2 AND ch.instance_id=$3`, [principal.organizationId, integrationId, instanceId]);
            if (!mapped.rowCount) throw denied();
          }
          if (['create', 'pair', 'disconnect'].includes(operation))
            await audit(tx, principal, `CONTROL_${operation.toUpperCase()}_REQUESTED`, integrationId ?? null);
        },
      };
    },
    async issueCredential(authentication: AuthenticationContext, value: z.infer<typeof IssueControlCredentialSchema>, key: string) {
      enabled();
      if (authentication.kind !== 'JWT') throw denied();
      const input = IssueControlCredentialSchema.parse(value);
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt <= new Date()) throw new IntegrationError('INVALID_EXPIRATION', 400);
      return options.transact(authentication.organizationId, async tx => {
        await lockChatwootDestination(tx, authentication.organizationId);
        const principal = await authorizeInTransaction(tx, authentication, 'chatwoot:manage');
        const claim = await claimIdempotency(tx, { organizationId: principal.organizationId, route: 'chatwoot-control-credentials', key: ControlIdempotencyKeySchema.parse(key),
          requestHash: hashIdempotencyRequest({ input, actor: authentication.actorId }), expiresAt: new Date(Date.now() + 86400000) });
        if (claim.kind === 'REPLAY') throw new IntegrationError('CONTROL_CREDENTIAL_ALREADY_ISSUED', 409);
        const credential = createOrganizationApiKey(principal.organizationId, options.hmacSecret);
        const scopes = [...new Set(input.scopes)];
        const row = await repository.insert(tx, { organizationId: principal.organizationId, name: input.name, prefix: credential.prefix,
          keyHmac: credential.hmac, scopes, expiresAt });
        await tx.query(`INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,$3,$4)`,
          [row.id, principal.organizationId, principal.accountId, principal.destinationRevision]);
        await audit(tx, principal, 'CONTROL_CREDENTIAL_ISSUED', row.id);
        await completeIdempotencyRecord(tx, { organizationId: principal.organizationId, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { id: row.id } });
        return { id: row.id, secret: credential.secret, scopes, expiresAt: expiresAt?.toISOString() ?? null,
          binding: { organizationId: principal.organizationId, accountId: principal.accountId, destinationRevision: principal.destinationRevision } };
      });
    },
    async operatorGrants(authentication: AuthenticationContext, integrationId: string) {
      enabled(); if (authentication.kind !== 'JWT') throw denied();
      return options.transact(authentication.organizationId, async tx => {
        await authorizeInTransaction(tx, authentication, 'chatwoot:manage', integrationId);
        const org = authentication.organizationId;
        const members = (await tx.query<{ userId: string; email: string; role: Role }>('SELECT user_id AS "userId",email,role FROM current_chatwoot_operator_members()')).rows;
        const grants = (await tx.query<{ userId: string; canPair: boolean }>('SELECT user_id AS "userId",can_pair AS "canPair" FROM chatwoot_operator_grants WHERE organization_id=$1 AND integration_id=$2 ORDER BY user_id', [org, integrationId])).rows;
        return { members, grants };
      });
    },
    async setOperatorGrants(authentication: AuthenticationContext, integrationId: string, value: z.infer<typeof OperatorGrantsSchema>, key: string) {
      enabled();
      if (authentication.kind !== 'JWT') throw denied();
      const input = OperatorGrantsSchema.parse(value);
      return options.transact(authentication.organizationId, async tx => {
        const principal = await authorizeInTransaction(tx, authentication, 'chatwoot:manage', integrationId);
        const claim = await claimIdempotency(tx, { organizationId: principal.organizationId, route: `chatwoot-grants:${integrationId}`, key: ControlIdempotencyKeySchema.parse(key),
          requestHash: hashIdempotencyRequest(input), expiresAt: new Date(Date.now() + 86400000) });
        if (claim.kind === 'REPLAY') return { ok: true as const };
        for (const grant of input.grants) if (!await options.resolveCurrentRole(grant.userId, principal.organizationId)) throw denied();
        await tx.query('DELETE FROM chatwoot_operator_grants WHERE organization_id=$1 AND integration_id=$2', [principal.organizationId, integrationId]);
        for (const grant of input.grants) await tx.query(`INSERT INTO chatwoot_operator_grants(organization_id,integration_id,user_id,can_pair) VALUES($1,$2,$3,$4)`,
          [principal.organizationId, integrationId, grant.userId, grant.canPair]);
        await audit(tx, principal, 'CONTROL_GRANTS_CHANGED', integrationId);
        await completeIdempotencyRecord(tx, { organizationId: principal.organizationId, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { ok: true } });
        return { ok: true as const };
      });
    },
  };
}
export type ChatwootControlAuth = ReturnType<typeof createChatwootControlAuth>;
