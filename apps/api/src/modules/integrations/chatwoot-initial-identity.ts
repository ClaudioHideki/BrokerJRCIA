import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { AuthenticationContext } from '../../http/plugins/authorization.js';
import type { ChatwootControlAuth, ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import { chatwootEnvironment, type ChatwootOptions } from './chatwoot-service.js';
import type { ChatwootHealth } from './chatwoot-health.js';
import { IntegrationError } from './integration-error.js';
import { ChatwootError } from './chatwoot-client.js';
import { readChatwootAccount } from './chatwoot-context.js';
import { lockAttendanceChannelRead } from '../attendance/repository.js';

const intentSchema = z.strictObject({
  version: z.literal(1), grantId: z.uuid(), accountId: z.number().int().positive(), destinationRevision: z.number().int().positive(),
  credentialVersion: z.number().int().positive(), origin: z.url(), instanceId: z.uuid(), instanceKey: z.string().min(1),
  inboxId: z.number().int().positive().nullable(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  actorId: z.uuid().nullable(), apiKeyId: z.uuid().nullable(), externalActorId: z.string().nullable(),
  pairKey: z.uuid().nullable(), operationId: z.uuid().nullable(), disconnectCount: z.number().int().nonnegative().nullable(),
  disconnectRequestsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), settled: z.boolean(),
  lastAttemptedAt: z.iso.datetime().nullable().optional(),
}).refine(v => Boolean(v.actorId) !== Boolean(v.apiKeyId));
type Intent = z.infer<typeof intentSchema>;
interface State {
  channel_id: string; instance_id: string; upstream_instance_key: string; inbox_id: string | null;
  status: string; transport: string; archived_at: Date | null; encrypted_webhook_secret: string | null;
  initial_identity_intent: unknown; initial_live: boolean; pair_live: boolean;
  approved_fingerprint: string | null; observed_fingerprint: string | null; observed_connected: boolean;
  identity_revision: number; identity_error: string | null; access_error: string | null;
  account_id: string; base_url: string; credential_version: number; destination_revision: number;
  disconnect_count: string; disconnect_requests_hash: string;
}
interface Options extends ChatwootOptions { auth: ChatwootControlAuth; health: ChatwootHealth }

// A disconnect accepted while the local state is already DISCONNECTED has no provider operation.
// Its durable request ID still fences enrollment; replaying the same request does not change this set.
const disconnectRequestsHashSql = `(SELECT encode(sha256(convert_to(COALESCE(string_agg(ir.id::text,',' ORDER BY ir.id),''),'UTF8')),'hex')
  FROM idempotency_records ir WHERE ir.organization_id=c.organization_id AND ir.route='/v1/instances/'||i.id::text||'/disconnect')`;

/** A creation/pair mutation grants a single initial enrollment. Reads never call complete. */
export function createChatwootInitialIdentity(options: Options) {
  const tx = options.transact, env = chatwootEnvironment(options);
  async function read(t: TenantTransaction, org: string, id: string, lock = false) {
    return (await t.query<State>(`SELECT h.*,c.channel_id,c.inbox_id,c.status,c.encrypted_webhook_secret,
      ch.instance_id,ch.transport,i.upstream_instance_key,i.archived_at,a.account_id,a.base_url,a.credential_version,d.revision destination_revision,
      h.initial_identity_expires_at>clock_timestamp() initial_live,h.initial_identity_pair_expires_at>clock_timestamp() pair_live,
      (SELECT count(*) FROM provider_operations po WHERE po.organization_id=c.organization_id AND po.instance_id=i.id AND po.operation_type='DISCONNECT') disconnect_count,
      ${disconnectRequestsHashSql} disconnect_requests_hash
      FROM chatwoot_connections c JOIN chatwoot_connection_health h ON h.organization_id=c.organization_id AND h.integration_id=c.id
      JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id AND ch.provider='BAILEYS' AND ch.deleting_at IS NULL
      JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id
      JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
      JOIN chatwoot_destinations d ON d.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.id=$2${lock ? ' FOR UPDATE OF h' : ''}`, [org, id])).rows[0];
  }
  function principal(org: string, intent: Intent): ChatwootControlPrincipal {
    const authentication: AuthenticationContext = intent.actorId
      ? { kind: 'JWT', organizationId: org, actorId: intent.actorId, role: 'VIEWER' }
      : { kind: 'API_KEY', organizationId: org, actorId: null, apiKeyId: intent.apiKeyId!, scopes: [] };
    return { organizationId: org, accountId: intent.accountId, destinationRevision: intent.destinationRevision,
      chatwootOrigin: intent.origin, authentication, ...(intent.externalActorId ? { externalActorId: intent.externalActorId } : {}) };
  }
  const matching = (s: State, v: Intent) => s.initial_live && s.status === 'READY' && s.transport === 'BROKER_TRANSPORT' && !s.archived_at &&
    s.instance_id === v.instanceId && s.upstream_instance_key === v.instanceKey && Number(s.account_id) === v.accountId &&
    s.base_url === v.origin && s.destination_revision === v.destinationRevision && s.credential_version === v.credentialVersion &&
    (v.inboxId === null || Number(s.inbox_id) === v.inboxId) && !s.approved_fingerprint;
  async function revoke(t: TenantTransaction, org: string, id: string, intent: unknown) {
    await t.query(`UPDATE chatwoot_connection_health SET initial_identity_intent=NULL,initial_identity_expires_at=NULL,initial_identity_pair_expires_at=NULL
      WHERE organization_id=$1 AND integration_id=$2 AND initial_identity_intent->>'grantId'=$3`,
    [org, id, intent && typeof intent === 'object' && 'grantId' in intent ? intent.grantId : null]);
  }
  async function lockAuthority(t: TenantTransaction, p: ChatwootControlPrincipal, id: string) {
    if (p.authentication.kind === 'JWT') {
      const member = (await t.query<{ role: string }>('SELECT role FROM lock_local_attendance_member($1)', [p.authentication.actorId])).rows[0];
      if (!member || !['OWNER', 'ADMIN'].includes(member.role)) throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    } else {
      await t.query('SELECT id FROM api_keys WHERE organization_id=$1 AND id=$2 FOR SHARE', [p.organizationId, p.authentication.apiKeyId]);
      await t.query('SELECT api_key_id FROM chatwoot_control_bindings WHERE organization_id=$1 AND api_key_id=$2 FOR SHARE', [p.organizationId, p.authentication.apiKeyId]);
    }
    await t.query('SELECT organization_id FROM chatwoot_accounts WHERE organization_id=$1 FOR SHARE', [p.organizationId]);
    await t.query('SELECT organization_id FROM chatwoot_destinations WHERE organization_id=$1 FOR SHARE', [p.organizationId]);
    await t.query('SELECT id FROM chatwoot_connections WHERE organization_id=$1 AND id=$2 FOR SHARE', [p.organizationId, id]);
    await options.auth.revalidate(t, p, 'chatwoot:manage', id);
  }
  async function cancelPair(t: TenantTransaction, org: string, id: string, expectedGrantId?: string) {
    const row = await read(t, org, id, true), parsed = intentSchema.safeParse(row?.initial_identity_intent);
    if (!parsed.success || expectedGrantId && parsed.data.grantId !== expectedGrantId) return;
    await t.query(`UPDATE chatwoot_connection_health SET initial_identity_intent=$3,initial_identity_pair_expires_at=NULL,
      pair_window_key=NULL,pair_window_expires_at=NULL WHERE organization_id=$1 AND integration_id=$2`,
    [org, id, { ...parsed.data, grantId: randomUUID(), pairKey: null, operationId: null, disconnectCount: null, disconnectRequestsHash: null, settled: false }]);
  }
  async function complete(org: string, id: string, mode: 'CREATE' | 'PAIR') {
    const before = await tx(org, t => read(t, org, id));
    if (!before?.initial_identity_intent) return;
    const parsed = intentSchema.safeParse(before.initial_identity_intent);
    if (!parsed.success || !matching(before, parsed.data)) {
      await tx(org, t => revoke(t, org, id, before.initial_identity_intent)); return;
    }
    const intent = parsed.data, p = principal(org, intent);
    if (mode === 'PAIR' && (!intent.pairKey || !intent.settled || !before.pair_live)) return;
    if (intent.disconnectCount === null || Number(before.disconnect_count) !== intent.disconnectCount ||
      intent.disconnectRequestsHash === null || before.disconnect_requests_hash !== intent.disconnectRequestsHash) {
      await tx(org, t => cancelPair(t, org, id, intent.grantId)); return;
    }
    try {
      await tx(org, t => options.auth.revalidate(t, p, 'chatwoot:manage', id));
      const account = await tx(org, t => readChatwootAccount(t, org));
      if (!account || !before.inbox_id || !before.encrypted_webhook_secret) return;
      const client = env.client(account);
      await client.verifyAccount(p.accountId);
      const remote = await client.getInbox(p.accountId, Number(before.inbox_id));
      const localSecret = Buffer.from(env.vault.decrypt(`${org}:chatwoot-webhook:${id}`, before.encrypted_webhook_secret));
      const remoteSecret = Buffer.from(remote.secret ?? '');
      if (remote.channel_type !== 'Channel::Api' || remote.id !== Number(before.inbox_id) || remote.webhook_url !== env.callback(id) ||
        !remoteSecret.length || remoteSecret.length !== localSecret.length || !timingSafeEqual(localSecret, remoteSecret))
        throw new IntegrationError('CHATWOOT_WEBHOOK_NOT_READY', 409);
      const observed = await options.health.refresh(org, before.channel_id);
      if (!observed?.observed_connected || !observed.observed_fingerprint) return;
      await tx(org, async t => {
        await lockAttendanceChannelRead(t, org, before.channel_id);
        await lockAuthority(t, p, id);
        const current = await read(t, org, id, true), now = intentSchema.safeParse(current?.initial_identity_intent);
        if (!current || !now.success) return;
        if (!matching(current, now.data) || now.data.grantId !== intent.grantId || now.data.pairKey !== intent.pairKey || mode === 'PAIR' && (!current.pair_live || !now.data.settled)) return;
        // The instance SHARE lock above also fences logout through the generic instance API.
        if (now.data.disconnectCount === null || Number(current.disconnect_count) !== now.data.disconnectCount ||
          now.data.disconnectRequestsHash === null || current.disconnect_requests_hash !== now.data.disconnectRequestsHash) {
          await cancelPair(t, org, id, now.data.grantId); return;
        }
        if (current.identity_revision !== observed.identity_revision || current.observed_fingerprint !== observed.observed_fingerprint ||
          !current.observed_connected || current.identity_error || current.access_error || now.data.expectedFingerprint !== current.observed_fingerprint) return;
        if (mode === 'PAIR' && now.data.operationId) {
          const latest = (await t.query<{ id: string; status: string }>(`SELECT id,status FROM provider_operations
            WHERE organization_id=$1 AND instance_id=$2 AND operation_type='CONNECT' ORDER BY created_at DESC,id DESC LIMIT 1`, [org, current.instance_id])).rows[0];
          if (latest?.id !== now.data.operationId || latest.status !== 'SUCCEEDED') return;
        }
        const changed = await t.query(`UPDATE chatwoot_connection_health SET approved_fingerprint=observed_fingerprint,identity_enforced=true,
          identity_error=NULL,initial_identity_intent=NULL,initial_identity_expires_at=NULL,initial_identity_pair_expires_at=NULL,
          callback_verified_at=NULL,callback_destination_revision=NULL,callback_credential_version=NULL,updated_at=now()
          WHERE organization_id=$1 AND integration_id=$2 AND approved_fingerprint IS NULL AND identity_revision=$3
            AND initial_identity_expires_at>clock_timestamp() AND ($4::boolean OR initial_identity_pair_expires_at>clock_timestamp())`,
        [org, id, observed.identity_revision, mode === 'CREATE']);
        if (changed.rowCount) await options.auth.audit(t, p, 'CONTROL_IDENTITY_CONFIRMED', id);
      });
    } catch (failure) {
      if (failure instanceof IntegrationError && failure.status === 403)
        await tx(org, t => revoke(t, org, id, before.initial_identity_intent));
      // Remote failures leave the channel unapproved. An armed intent may retry only until its deadline.
      if (!(failure instanceof IntegrationError || failure instanceof ChatwootError)) throw failure;
    }
  }
  return {
    async authorize(value: AuthenticationContext | ChatwootControlPrincipal) {
      if ('authentication' in value) {
        await tx(value.organizationId, t => options.auth.revalidate(t, value, 'chatwoot:manage'));
        return value;
      }
      return options.auth.authorize(value, 'chatwoot:manage');
    },
    async register(t: TenantTransaction, p: ChatwootControlPrincipal, id: string) {
      await options.auth.revalidate(t, p, 'chatwoot:manage', id);
      const row = (await t.query<{ channel_id: string; instance_id: string; upstream_instance_key: string; credential_version: number; inbox_id: string | null; disconnect_count: string; disconnect_requests_hash: string }>(`SELECT c.channel_id,c.inbox_id,ch.instance_id,i.upstream_instance_key,a.credential_version,
        (SELECT count(*) FROM provider_operations po WHERE po.organization_id=c.organization_id AND po.instance_id=i.id AND po.operation_type='DISCONNECT') disconnect_count,
        ${disconnectRequestsHashSql} disconnect_requests_hash
        FROM chatwoot_connections c JOIN messaging_channels ch ON ch.organization_id=c.organization_id AND ch.id=c.channel_id AND ch.provider='BAILEYS'
        JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id JOIN chatwoot_accounts a ON a.organization_id=c.organization_id
        WHERE c.organization_id=$1 AND c.id=$2`, [p.organizationId, id])).rows[0];
      if (!row) return;
      const a = p.authentication;
      const intent: Intent = { version: 1, grantId: randomUUID(), accountId: p.accountId, destinationRevision: p.destinationRevision, credentialVersion: row.credential_version,
        origin: p.chatwootOrigin, instanceId: row.instance_id, instanceKey: row.upstream_instance_key, inboxId: row.inbox_id ? Number(row.inbox_id) : null, expectedFingerprint: null,
        actorId: a.actorId, apiKeyId: a.kind === 'API_KEY' ? a.apiKeyId : null, externalActorId: p.externalActorId ?? null,
        pairKey: null, operationId: null, disconnectCount: Number(row.disconnect_count), disconnectRequestsHash: row.disconnect_requests_hash, settled: false };
      await t.query(`INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,identity_enforced,initial_identity_intent,initial_identity_expires_at)
        VALUES($1,$2,$3,true,$4,clock_timestamp()+interval '24 hours') ON CONFLICT DO NOTHING`, [p.organizationId, id, row.channel_id, intent]);
    },
    async created(p: ChatwootControlPrincipal, id: string) {
      await tx(p.organizationId, async t => {
        await options.auth.revalidate(t, p, 'chatwoot:manage', id);
        const row = await read(t, p.organizationId, id, true), intent = intentSchema.safeParse(row?.initial_identity_intent);
        if (!row || !intent.success || !matching(row, intent.data) || !row.inbox_id) return;
        await t.query('UPDATE chatwoot_connection_health SET initial_identity_intent=$3 WHERE organization_id=$1 AND integration_id=$2',
          [p.organizationId, id, { ...intent.data, inboxId: Number(row.inbox_id) }]);
      });
      await complete(p.organizationId, id, 'CREATE');
    },
    async arm(t: TenantTransaction, p: ChatwootControlPrincipal, id: string, pairKey: string) {
      const row = await read(t, p.organizationId, id, true), parsed = intentSchema.safeParse(row?.initial_identity_intent);
      if (!row || !parsed.success || !matching(row, parsed.data) || !row.inbox_id) return;
      await options.auth.revalidate(t, p, 'chatwoot:manage', id);
      if (parsed.data.pairKey === pairKey) return;
      const a = p.authentication, intent = { ...parsed.data, inboxId: Number(row.inbox_id), grantId: randomUUID(), pairKey, operationId: null, settled: false,
        disconnectCount: Number(row.disconnect_count), disconnectRequestsHash: row.disconnect_requests_hash, lastAttemptedAt: null,
        actorId: a.actorId, apiKeyId: a.kind === 'API_KEY' ? a.apiKeyId : null, externalActorId: p.externalActorId ?? null };
      await t.query(`UPDATE chatwoot_connection_health SET initial_identity_intent=$3,
        initial_identity_pair_expires_at=LEAST(initial_identity_expires_at,clock_timestamp()+interval '2 minutes')
        WHERE organization_id=$1 AND integration_id=$2`, [p.organizationId, id, intent]);
    },
    async settled(p: ChatwootControlPrincipal, id: string, pairKey: string, operationId: string | null | undefined, expiresAt: string | null) {
      await tx(p.organizationId, async t => {
        const row = await read(t, p.organizationId, id, true), parsed = intentSchema.safeParse(row?.initial_identity_intent);
        if (!row || !parsed.success || parsed.data.pairKey !== pairKey || !matching(row, parsed.data)) return;
        await options.auth.revalidate(t, p, 'chatwoot:manage', id);
        await t.query(`UPDATE chatwoot_connection_health SET initial_identity_intent=$3,
          initial_identity_pair_expires_at=LEAST(initial_identity_pair_expires_at,COALESCE($4::timestamptz,initial_identity_pair_expires_at))
          WHERE organization_id=$1 AND integration_id=$2`, [p.organizationId, id, { ...parsed.data, operationId: operationId ?? null, settled: true }, expiresAt]);
      });
    },
    cancelPair,
    async pending(org: string, instanceId: string) {
      return tx(org, async t => (await t.query<{ integration_id: string }>(`SELECT h.integration_id
        FROM chatwoot_connection_health h JOIN messaging_channels ch ON ch.organization_id=h.organization_id AND ch.id=h.channel_id
        WHERE h.organization_id=$1 AND ch.instance_id=$2 AND ch.provider='BAILEYS' AND h.approved_fingerprint IS NULL
          AND h.initial_identity_intent IS NOT NULL AND h.initial_identity_expires_at>clock_timestamp()`, [org, instanceId])).rows[0]?.integration_id ?? null);
    },
    async runOnce(org: string) {
      const rows = await tx(org, async t => {
        await t.query(`UPDATE chatwoot_connection_health SET initial_identity_intent=NULL,initial_identity_expires_at=NULL,initial_identity_pair_expires_at=NULL
          WHERE organization_id=$1 AND initial_identity_expires_at<=clock_timestamp()`, [org]);
        // Rotate admitted attempts before remote I/O without changing observation freshness.
        return (await t.query<{ integration_id: string }>(`WITH selected AS (
          SELECT integration_id FROM chatwoot_connection_health
          WHERE organization_id=$1 AND initial_identity_intent IS NOT NULL AND initial_identity_intent->>'settled'='true'
            AND initial_identity_pair_expires_at>clock_timestamp()
          ORDER BY initial_identity_intent->>'lastAttemptedAt' NULLS FIRST,updated_at,integration_id LIMIT 4 FOR UPDATE SKIP LOCKED
        ) UPDATE chatwoot_connection_health h SET initial_identity_intent=jsonb_set(h.initial_identity_intent,'{lastAttemptedAt}',to_jsonb($2::text))
          FROM selected s WHERE h.organization_id=$1 AND h.integration_id=s.integration_id RETURNING h.integration_id`, [org, new Date().toISOString()])).rows;
      });
      await Promise.allSettled(rows.map(row => complete(org, row.integration_id, 'PAIR')));
    },
  };
}
