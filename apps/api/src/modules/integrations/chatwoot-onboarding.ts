import { randomUUID } from 'node:crypto';
import { ControlIdempotencyKeySchema, OnboardingInputSchema, OnboardingOperationSchema, type OnboardingInput, type OnboardingOperation } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { AuthenticationContext } from '../../http/plugins/authorization.js';
import { InstanceServiceError, type InstanceService } from '../instances/service.js';
import { tenantOperationalProblem } from '../tenancy/operational-limits.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';
import type { ChatwootControlAuth, ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import { type ChatwootService, type ConnectionRow } from './chatwoot-service.js';
import { ChatwootError } from './chatwoot-client.js';
import { IntegrationError } from './integration-error.js';
import { lockChatwootDestination } from './chatwoot-destination.js';

interface Operation {
  id: string; organization_id: string; input_hash: string; input: OnboardingInput;
  account_id: string; destination_revision: number; chatwoot_origin: string;
  actor_id: string | null; actor_api_key_id: string | null; external_actor_id: string | null;
  state: OnboardingOperation['state']; stage: OnboardingOperation['stage'];
  instance_id: string | null; channel_id: string | null; integration_id: string | null; inbox_id: string | null;
  lease_token: string | null; reconcile_only: boolean; retry_requested: boolean; cancel_requested: boolean; last_error: string | null;
}
export interface OnboardingOptions {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  auth: ChatwootControlAuth; instances: InstanceService; chatwoot: ChatwootService;
  activateQr(org: string, instanceId: string): Promise<{ id: string }>;
}
const nextStage = { INSTANCE: 'ACTIVATE_CHANNEL', ACTIVATE_CHANNEL: 'LINK_INBOX', LINK_INBOX: 'ASSIGN_AGENTS', ASSIGN_AGENTS: 'VERIFY', VERIFY: 'DONE', DONE: 'DONE' } as const;
const uncertain = () => new IntegrationError('ONBOARDING_RECONCILIATION_REQUIRED', 409);
function view(row: Operation): OnboardingOperation {
  return OnboardingOperationSchema.parse({ operationId: row.id, state: row.state, stage: row.stage, instanceId: row.instance_id,
    integrationId: row.integration_id, inboxId: row.inbox_id ? Number(row.inbox_id) : null, lastError: row.last_error });
}
function storedPrincipal(row: Operation): ChatwootControlPrincipal {
  // These are identifiers for authoritative revalidation, never a replayed bearer token or role grant.
  const authentication: AuthenticationContext = row.actor_id
    ? { kind: 'JWT', organizationId: row.organization_id, actorId: row.actor_id, role: 'VIEWER' }
    : { kind: 'API_KEY', organizationId: row.organization_id, actorId: null, apiKeyId: row.actor_api_key_id!, scopes: [] };
  return { organizationId: row.organization_id, accountId: Number(row.account_id), destinationRevision: row.destination_revision,
    chatwootOrigin: row.chatwoot_origin, authentication, ...(row.external_actor_id ? { externalActorId: row.external_actor_id } : {}) };
}
export function createOnboardingService(options: OnboardingOptions) {
  const tx = options.transact;
  async function read(t: TenantTransaction, org: string, id: string, lock = false) {
    const row = (await t.query<Operation>(`SELECT * FROM chatwoot_onboarding_operations WHERE organization_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [org, id])).rows[0];
    if (!row) throw new IntegrationError('ONBOARDING_NOT_FOUND', 404);
    return row;
  }
  async function validateLease(t: TenantTransaction, row: Operation) {
    const active = await t.query(`SELECT 1 FROM chatwoot_onboarding_operations WHERE organization_id=$1 AND id=$2
      AND state='RUNNING' AND lease_token=$3 AND lease_expires_at>now() AND NOT cancel_requested`, [row.organization_id, row.id, row.lease_token]);
    if (!active.rowCount) throw new IntegrationError('ONBOARDING_LEASE_LOST', 409);
    await options.auth.revalidate(t, storedPrincipal(row), 'chatwoot:manage');
  }
  async function remember(row: Operation) {
    await tx(row.organization_id, t => t.query(`UPDATE chatwoot_onboarding_operations SET instance_id=$4,channel_id=$5,integration_id=$6,inbox_id=$7,updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND state='RUNNING' AND lease_token=$3`,
    [row.organization_id, row.id, row.lease_token, row.instance_id, row.channel_id, row.integration_id, row.inbox_id]));
  }
  async function connection(row: Operation): Promise<ConnectionRow | undefined> {
    return tx(row.organization_id, async t => {
      const c = (await t.query<ConnectionRow>('SELECT * FROM chatwoot_connections WHERE organization_id=$1 AND channel_id=$2', [row.organization_id, row.channel_id])).rows[0];
      if (c) {
        if ((row.integration_id && row.integration_id !== c.id) || (row.input.inboxId && c.inbox_id && row.input.inboxId !== Number(c.inbox_id)))
          throw new IntegrationError('CHATWOOT_BINDING_MISMATCH', 409);
        row.integration_id = c.id; row.inbox_id = c.inbox_id;
      }
      return c;
    });
  }
  async function step(row: Operation) {
    const org = row.organization_id, principal = storedPrincipal(row), input = OnboardingInputSchema.parse(row.input);
    const validate = () => tx(org, t => validateLease(t, row));
    const delegated = options.auth.delegate(principal, { requestId: randomUUID(), deadline: new Date(Date.now() + 30_000), signal: AbortSignal.timeout(30_000) });
    await validate();
    if (row.stage === 'INSTANCE') {
      if (input.source.kind === 'EXISTING') row.instance_id = input.source.instanceId;
      else if (!row.instance_id) {
        if (row.reconcile_only) throw uncertain();
        if (delegated.credentialKind !== 'CHATWOOT_CONTROL') throw new Error('INVALID_DELEGATION');
        const result = await options.instances.createInstance({ ...delegated,
          async onInstanceCreated(t, id) {
            await validateLease(t, row);
            await t.query(`UPDATE chatwoot_onboarding_operations SET instance_id=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3`, [org, row.id, row.lease_token, id]);
            row.instance_id = id;
          },
        }, { name: input.source.instanceName, provider: 'BAILEYS', providerAccountId: input.source.providerAccountId, idempotencyKey: `${row.id}:INSTANCE` });
        row.instance_id = result.instance.id;
        if (result.reconciliationRequired || result.pending) throw uncertain();
        if (result.instance.status === 'PROVISIONING_FAILED') throw new IntegrationError('ONBOARDING_INSTANCE_FAILED', 502);
      }
      const instance = row.reconcile_only
        ? await options.instances.getInstanceStatus(delegated, row.instance_id!)
        : await options.instances.getInstance(delegated, row.instance_id!);
      if (['PROVISIONING', 'PROVISIONING_FAILED'].includes(instance.status)) throw uncertain();
    } else if (row.stage === 'ACTIVATE_CHANNEL') {
      // Repeating this PUT-like configuration uses the existing unique channel and same callback/secret.
      row.channel_id = (await options.activateQr(org, row.instance_id!)).id;
    } else if (row.stage === 'LINK_INBOX') {
      let c = await connection(row);
      if (!c) {
        if (row.reconcile_only) throw uncertain();
        await validate();
        try { await options.chatwoot.connect(org, { channelId: row.channel_id!, name: input.name, requireIdentity: true,
          ...(input.inboxId ? { inboxId: input.inboxId } : {}), replaceExistingWebhook: input.replaceExistingWebhook }, principal.authentication.actorId ?? undefined); }
        finally { await connection(row); await remember(row); }
      } else if (c.status !== 'READY') {
        await validate();
        if (c.status === 'FAILED' && row.retry_requested && !row.reconcile_only)
          await options.chatwoot.retryConnection(org, c.id, input.replaceExistingWebhook, principal.authentication.actorId ?? undefined);
        else await options.chatwoot.reconcileConnection(org, c.id);
      }
      c = await connection(row);
      if (c?.status !== 'READY') throw uncertain();
    } else if (row.stage === 'ASSIGN_AGENTS') {
      if (input.agentIds.length) {
        const current = await options.chatwoot.agents(org, row.integration_id!);
        const assigned = new Set(current.data.filter(a => a.assigned).map(a => a.id));
        if (!input.agentIds.every(id => assigned.has(id))) {
          if (row.reconcile_only) throw uncertain();
          await validate();
          await options.chatwoot.addAgents(org, row.integration_id!, [...new Set([...assigned, ...input.agentIds])], principal.authentication.actorId ?? undefined);
        }
      }
    } else if (row.stage === 'VERIFY') {
      await options.chatwoot.reconcileConnection(org, row.integration_id!);
      await validate();
      if (input.agentIds.length) {
        const assigned = (await options.chatwoot.agents(org, row.integration_id!)).data.filter(a => a.assigned).map(a => a.id);
        if (!input.agentIds.every(id => assigned.includes(id))) throw new IntegrationError('CHATWOOT_AGENTS_NOT_READY', 409);
      }
      await connection(row);
    }
    await remember(row);
  }
  return {
    async start(principal: ChatwootControlPrincipal, value: OnboardingInput, key: string) {
      const input = OnboardingInputSchema.parse(value), idempotency = ControlIdempotencyKeySchema.parse(key), hash = hashIdempotencyRequest(input);
      return tx(principal.organizationId, async t => {
        await lockChatwootDestination(t, principal.organizationId);
        await options.auth.revalidate(t, principal, 'chatwoot:manage');
        const previous = (await t.query<Operation>('SELECT * FROM chatwoot_onboarding_operations WHERE organization_id=$1 AND idempotency_key=$2', [principal.organizationId, idempotency])).rows[0];
        if (previous) {
          if (previous.input_hash !== hash) throw new IntegrationError('IDEMPOTENCY_CONFLICT', 409);
          return view(previous);
        }
        if (input.source.kind === 'EXISTING') {
          const instance = await t.query(`SELECT i.id FROM instances i JOIN provider_accounts p ON p.organization_id=i.organization_id AND p.id=i.provider_account_id
            WHERE i.organization_id=$1 AND i.id=$2 AND p.provider='BAILEYS' AND i.status NOT IN ('PROVISIONING','PROVISIONING_FAILED')`, [principal.organizationId, input.source.instanceId]);
          if (!instance.rowCount) throw new IntegrationError('QR_INSTANCE_NOT_FOUND', 404);
          const used = await t.query(`SELECT 1 FROM messaging_channels ch JOIN chatwoot_connections c ON c.organization_id=ch.organization_id AND c.channel_id=ch.id
            WHERE ch.organization_id=$1 AND ch.instance_id=$2`, [principal.organizationId, input.source.instanceId]);
          if (used.rowCount) throw new IntegrationError('CONNECTION_ALREADY_EXISTS', 409);
        } else if (!(await t.query("SELECT 1 FROM provider_accounts WHERE organization_id=$1 AND id=$2 AND provider='BAILEYS'", [principal.organizationId, input.source.providerAccountId])).rowCount)
          throw new IntegrationError('PROVIDER_ACCOUNT_NOT_FOUND', 404);
        const a = principal.authentication;
        const row = (await t.query<Operation>(`INSERT INTO chatwoot_onboarding_operations(organization_id,idempotency_key,input_hash,input,
          account_id,destination_revision,chatwoot_origin,actor_id,actor_api_key_id,external_actor_id,instance_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [principal.organizationId, idempotency, hash, JSON.stringify(input),
          principal.accountId, principal.destinationRevision, principal.chatwootOrigin, a.actorId, a.kind === 'API_KEY' ? a.apiKeyId : null,
          principal.externalActorId ?? null, input.source.kind === 'EXISTING' ? input.source.instanceId : null])).rows[0]!;
        await options.auth.audit(t, principal, 'ONBOARDING_STARTED', row.id);
        return view(row);
      });
    },
    async get(principal: ChatwootControlPrincipal, id: string) {
      return tx(principal.organizationId, async t => {
        const row = await read(t, principal.organizationId, id);
        await options.auth.revalidate(t, principal, 'chatwoot:read', row.integration_id ?? undefined);
        if (principal.authentication.kind === 'JWT' && !row.integration_id && row.actor_id !== principal.authentication.actorId)
          await options.auth.revalidate(t, principal, 'chatwoot:manage');
        return view(row);
      });
    },
    async list(principal: ChatwootControlPrincipal) {
      return tx(principal.organizationId, async t => {
        await options.auth.revalidate(t, principal, 'chatwoot:manage');
        const rows = (await t.query<Operation>(`SELECT * FROM chatwoot_onboarding_operations WHERE organization_id=$1
          AND account_id=$2 AND destination_revision=$3 AND chatwoot_origin=$4 ORDER BY created_at DESC,id DESC LIMIT 50`,
        [principal.organizationId, principal.accountId, principal.destinationRevision, principal.chatwootOrigin])).rows;
        return { data: rows.map(view) };
      });
    },
    async recover(principal: ChatwootControlPrincipal, id: string, action: 'RETRY' | 'RECONCILE' | 'CANCEL', key: string) {
      return tx(principal.organizationId, async t => {
        await options.auth.revalidate(t, principal, 'chatwoot:manage');
        const row = await read(t, principal.organizationId, id, true);
        const claim = await claimIdempotency(t, { organizationId: principal.organizationId, route: `chatwoot-onboarding-recovery:${id}`,
          key: ControlIdempotencyKeySchema.parse(key), requestHash: hashIdempotencyRequest({ action }), expiresAt: new Date(Date.now() + 86400000) });
        if (claim.kind === 'REPLAY') return view(row);
        if (row.state === 'SUCCEEDED' || row.cancel_requested) throw new IntegrationError('ONBOARDING_ALREADY_FINISHED', 409);
        if (action !== 'CANCEL' && (row.state === 'RUNNING' || row.state === 'PENDING')) throw new IntegrationError('ONBOARDING_IN_PROGRESS', 409);
        if (action === 'RETRY' && row.state === 'UNKNOWN') throw uncertain();
        const a = principal.authentication;
        // An authorized recovery can take over from a removed actor; it is separately audited.
        await t.query(`UPDATE chatwoot_onboarding_operations SET
          state=CASE WHEN $3='CANCEL' THEN CASE WHEN state='RUNNING' THEN state ELSE 'FAILED' END ELSE 'PENDING' END,
          cancel_requested=($3='CANCEL'),reconcile_only=($3='RECONCILE'),retry_requested=($3='RETRY'),
          last_error=CASE WHEN $3='CANCEL' THEN 'ONBOARDING_CANCELLED' ELSE NULL END,
          actor_id=$4,actor_api_key_id=$5,external_actor_id=$6,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [principal.organizationId, id, action, a.actorId, a.kind === 'API_KEY' ? a.apiKeyId : null, principal.externalActorId ?? null]);
        await options.auth.audit(t, principal, `ONBOARDING_${action}`, id);
        await completeIdempotencyRecord(t, { organizationId: principal.organizationId, recordId: claim.recordId, status: 'COMPLETED', responseMetadata: { operationId: id } });
        return view(await read(t, principal.organizationId, id));
      });
    },
    async runOnce(org: string) {
      if (!options.auth.enabled) return false;
      const row = await tx(org, async t => {
        await t.query(`UPDATE chatwoot_onboarding_operations SET state=CASE WHEN cancel_requested THEN 'FAILED' ELSE 'UNKNOWN' END,
          last_error=CASE WHEN cancel_requested THEN 'ONBOARDING_CANCELLED' ELSE 'ONBOARDING_LEASE_EXPIRED' END,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND state='RUNNING' AND lease_expires_at<=now()`, [org]);
        return (await t.query<Operation>(`UPDATE chatwoot_onboarding_operations SET state='RUNNING',lease_token=$2,lease_expires_at=now()+interval '120 seconds',updated_at=now()
          WHERE id=(SELECT id FROM chatwoot_onboarding_operations WHERE organization_id=$1 AND state='PENDING' AND NOT cancel_requested
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [org, randomUUID()])).rows[0];
      });
      if (!row) return false;
      try {
        await step(row);
        await tx(org, async t => {
          const saved = await read(t, org, row.id, true);
          if (saved.lease_token !== row.lease_token || saved.state !== 'RUNNING') return;
          if (!saved.cancel_requested) await options.auth.revalidate(t, storedPrincipal(row), 'chatwoot:manage');
          const next = nextStage[row.stage];
          await t.query(`UPDATE chatwoot_onboarding_operations SET stage=$4,state=$5,lease_token=NULL,lease_expires_at=NULL,
            reconcile_only=false,retry_requested=false,last_error=$6,updated_at=now() WHERE organization_id=$1 AND id=$2 AND lease_token=$3`,
          [org, row.id, row.lease_token, saved.cancel_requested ? row.stage : next, saved.cancel_requested ? 'FAILED' : next === 'DONE' ? 'SUCCEEDED' : 'PENDING', saved.cancel_requested ? 'ONBOARDING_CANCELLED' : null]);
          if (next === 'DONE' && !saved.cancel_requested) await options.auth.audit(t, storedPrincipal(row), 'ONBOARDING_COMPLETED', row.id);
        });
      } catch (failure) {
        const operational = tenantOperationalProblem(failure, row.id);
        const known = failure instanceof IntegrationError || failure instanceof ChatwootError || failure instanceof InstanceServiceError;
        const isUnknown = (!known && !operational) || (failure instanceof ChatwootError && failure.uncertain) ||
          (failure instanceof IntegrationError && ['ONBOARDING_RECONCILIATION_REQUIRED', 'CHATWOOT_INBOX_RECONCILIATION_REQUIRED', 'ONBOARDING_LEASE_LOST'].includes(failure.code));
        const code = operational?.code ?? (known && /^[A-Z][A-Z0-9_]{0,127}$/.test(failure.code) ? failure.code : 'ONBOARDING_RESULT_UNKNOWN');
        // Never persist exception text, tokens, provider payloads or QR values.
        await tx(org, t => t.query(`UPDATE chatwoot_onboarding_operations SET state=CASE WHEN cancel_requested THEN 'FAILED' ELSE $4 END,
          last_error=CASE WHEN cancel_requested THEN 'ONBOARDING_CANCELLED' ELSE $5 END,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='RUNNING'`, [org, row.id, row.lease_token, isUnknown ? 'UNKNOWN' : 'FAILED', code]));
      }
      return true;
    },
  };
}
export type OnboardingService = ReturnType<typeof createOnboardingService>;
