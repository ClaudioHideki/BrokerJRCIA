import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { NicoExternalActorSchema, NicoTakeoverSnapshotSchema, NicoTakeoverRequestSchema, NicoTakeoverCancelSchema,
  type NicoTakeoverOperation, type NicoTakeoverRequest } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { ChatwootControlAuth, ChatwootControlPrincipal } from './chatwoot-control-auth.js';
import type { AccountRow } from './chatwoot-context.js';
import type { ChatwootClient } from './chatwoot-client.js';
import type { NicoTakeovers } from './nico-takeover-types.js';
import { IntegrationError } from './integration-error.js';
import { lockChatwootDestination } from './chatwoot-destination.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { recordManualAttendanceTakeover } from '../attendance/manual-takeover.js';
import { captureTakeover, assertTakeoverExecutorSettled, cancelUndispatchedTakeoverWork, takeoverHasUnsettledWork, type TakeoverSnapshot, type TakeoverRow } from './nico-takeover-store.js';

export type NicoTakeoverOptions = {
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  auth: ChatwootControlAuth;
  client(account: AccountRow): Pick<ChatwootClient, 'canonicalMessage'>;
};
export function nicoSendFingerprint(scope: { organizationId: string; accountId: number; inboxId: number; remoteConversationId: number }, actor: string, content: string) {
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  return createHash('sha256').update(`jrc-nico-send-v1\n${scope.organizationId}\n${scope.accountId}\n${scope.inboxId}\n${scope.remoteConversationId}\n${actor}\n${digest}`, 'utf8').digest('hex');
}
const publicSnapshot = (snapshot: TakeoverSnapshot) => NicoTakeoverSnapshotSchema.parse(Object.fromEntries(
  Object.keys(NicoTakeoverSnapshotSchema.shape).map(key => [key, snapshot[key as keyof TakeoverSnapshot]])));
const stableSnapshot = (s: TakeoverSnapshot) => ({ ...s, attendanceRevision: 0, controlRevision: 0, controlState: null, mode: 'HUMAN' });
const conflict = (code = 'NICO_TAKEOVER_CONTEXT_CHANGED') => new IntegrationError(code, 409);

export function createNicoTakeovers(options: NicoTakeoverOptions): NicoTakeovers {
  async function authorize(tx: TenantTransaction, p: ChatwootControlPrincipal, integration: string) {
    if (p.authentication.kind !== 'API_KEY' || !NicoExternalActorSchema.safeParse(p.externalActorId).success)
      throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    await tx.query(`SELECT k.id FROM api_keys k JOIN chatwoot_control_bindings b ON b.organization_id=k.organization_id AND b.api_key_id=k.id
      WHERE k.organization_id=$1 AND k.id=$2 FOR SHARE OF k,b`, [p.organizationId, p.authentication.apiKeyId]);
    await options.auth.revalidate(tx, p, 'chatwoot:manage', integration);
  }
  async function locked(tx: TenantTransaction, p: ChatwootControlPrincipal, integration: string, remote: number, requestId?: string) {
    await lockChatwootDestination(tx, p.organizationId);
    await authorize(tx, p, integration);
    if (requestId) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`nico-takeover:${p.organizationId}:${requestId}`]);
    return captureTakeover(tx, p, integration, remote);
  }
  async function rowById(tx: TenantTransaction, p: ChatwootControlPrincipal, integration: string, remote: number, id: string) {
    const row = (await tx.query<TakeoverRow>('SELECT * FROM nico_takeover_operations WHERE organization_id=$1 AND id=$2', [p.organizationId, id])).rows[0];
    if (!row || row.integration_id !== integration || Number(row.remote_conversation_id) !== remote)
      throw new IntegrationError('NICO_TAKEOVER_NOT_FOUND', 404);
    if (row.external_actor_id !== p.externalActorId || row.snapshot.accountId !== p.accountId || row.snapshot.origin !== p.chatwootOrigin)
      throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    return row;
  }
  async function view(tx: TenantTransaction, row: TakeoverRow, current: TakeoverSnapshot, p: ChatwootControlPrincipal): Promise<NicoTakeoverOperation> {
    let state: NicoTakeoverOperation['state'] = row.state === 'OPEN' ? 'STALE' : row.state;
    if (row.state === 'OPEN' && p.authentication.kind === 'API_KEY' && row.api_key_id === p.authentication.apiKeyId &&
      isDeepStrictEqual(row.snapshot, current)) state = await takeoverHasUnsettledWork(tx, p.organizationId, row.conversation_id) ? 'DRAINING' : 'PAUSED';
    return { ...publicSnapshot(current), id: row.id, requestId: row.request_id, fingerprint: row.fingerprint, state };
  }
  async function insert(tx: TenantTransaction, p: ChatwootControlPrincipal, snapshot: TakeoverSnapshot,
    input: Pick<NicoTakeoverRequest, 'requestId' | 'fingerprint'>, request: NicoTakeoverRequest | null, state: 'OPEN' | 'CANCELED') {
    if (p.authentication.kind !== 'API_KEY') throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
    return (await tx.query<TakeoverRow>(`INSERT INTO nico_takeover_operations(organization_id,id,channel_id,conversation_id,integration_id,
      remote_conversation_id,request_id,external_actor_id,api_key_id,fingerprint,request_body,snapshot,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [p.organizationId, randomUUID(), snapshot.channelId, snapshot.conversationId, snapshot.integrationId, snapshot.remoteConversationId,
      input.requestId, p.externalActorId, p.authentication.apiKeyId, input.fingerprint, request ? JSON.stringify(request) : null, JSON.stringify(snapshot), state])).rows[0]!;
  }
  const sameIntent = (row: TakeoverRow, p: ChatwootControlPrincipal, integration: string, remote: number,
    input: Pick<NicoTakeoverRequest, 'requestId' | 'fingerprint'>) => {
    if (row.integration_id !== integration || Number(row.remote_conversation_id) !== remote || row.external_actor_id !== p.externalActorId ||
      row.fingerprint !== input.fingerprint || row.snapshot.accountId !== p.accountId || row.snapshot.origin !== p.chatwootOrigin)
      throw conflict('NICO_TAKEOVER_IDEMPOTENCY_CONFLICT');
  };
  return {
    async attendance(p, integration, remote) {
      return options.transact(p.organizationId, async tx => publicSnapshot((await locked(tx, p, integration, remote)).snapshot));
    },
    async start(p, integration, remote, raw) {
      const input = NicoTakeoverRequestSchema.parse(raw);
      return options.transact(p.organizationId, async tx => {
        const current = await locked(tx, p, integration, remote, input.requestId);
        const prior = (await tx.query<TakeoverRow>('SELECT * FROM nico_takeover_operations WHERE organization_id=$1 AND request_id=$2', [p.organizationId, input.requestId])).rows[0];
        if (prior) {
          sameIntent(prior, p, integration, remote, input);
          if (prior.state !== 'CANCELED' && !isDeepStrictEqual(prior.request_body, input)) throw conflict('NICO_TAKEOVER_IDEMPOTENCY_CONFLICT');
          return view(tx, prior, current.snapshot, p);
        }
        const s = current.snapshot;
        if (s.ownerRevision !== input.expectedOwnerRevision || s.attendanceRevision !== input.expectedAttendanceRevision ||
          s.controlRevision !== input.expectedControlRevision || s.destinationRevision !== input.expectedDestinationRevision ||
          s.credentialRevision !== input.expectedCredentialRevision) throw conflict();
        if (!['NONE', 'BROKER'].includes(s.executor) || s.remoteBinding !== null) throw conflict('NICO_TAKEOVER_EXECUTOR_UNSUPPORTED');
        await assertTakeoverExecutorSettled(tx,p.organizationId,s.channelId);
        if ((await tx.query("SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1 AND conversation_id=$2 AND state='OPEN'", [p.organizationId, s.conversationId])).rowCount)
          throw conflict('NICO_TAKEOVER_IN_PROGRESS');
        await recordManualAttendanceTakeover(tx, p.organizationId, s.conversationId);
        await cancelUndispatchedTakeoverWork(tx, p.organizationId, s.conversationId);
        const paused = (await captureTakeover(tx, p, integration, remote)).snapshot;
        const row = await insert(tx, p, paused, input, input, 'OPEN');
        await options.auth.audit(tx, p, 'NICO_TAKEOVER_REQUESTED', row.id);
        return view(tx, row, paused, p);
      });
    },
    async get(p, integration, remote, id) {
      z.uuid().parse(id);
      return options.transact(p.organizationId, async tx => {
        const current = await locked(tx, p, integration, remote);
        return view(tx, await rowById(tx, p, integration, remote, id), current.snapshot, p);
      });
    },
    async complete(p, integration, remote, id, messageId) {
      z.uuid().parse(id); z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(messageId);
      const prepare = async (tx: TenantTransaction) => {
        const current = await locked(tx, p, integration, remote), row = await rowById(tx, p, integration, remote, id);
        if (row.state === 'CANCELED' || row.state === 'COMPLETED' && Number(row.message_id) !== messageId) throw conflict('NICO_TAKEOVER_RECEIPT_CONFLICT');
        if (row.state === 'OPEN' && (p.authentication.kind !== 'API_KEY' || row.api_key_id !== p.authentication.apiKeyId ||
          !isDeepStrictEqual(stableSnapshot(row.snapshot), stableSnapshot(current.snapshot)) || current.snapshot.mode !== 'HUMAN' ||
          current.snapshot.controlState !== null && current.snapshot.controlState !== 'HUMAN' ||
          await takeoverHasUnsettledWork(tx, p.organizationId, row.conversation_id))) throw conflict('NICO_TAKEOVER_NOT_PAUSED');
        return { ...current, row };
      };
      const before = await options.transact(p.organizationId, prepare);
      if (before.row.state === 'COMPLETED') return { ...publicSnapshot(before.snapshot), id, requestId: before.row.request_id, fingerprint: before.row.fingerprint, state: 'COMPLETED' };
      // No transaction is held while the authenticated canonical read runs.
      const message = await options.client(before.account).canonicalMessage(p.accountId, before.snapshot.inboxId, remote, messageId);
      const receipt = z.object({ takeoverId: z.uuid(), requestId: z.uuid(), fingerprint: z.string() }).safeParse(message.content_attributes.jrc_nico_takeover);
      if (message.id !== messageId || message.account_id !== undefined && message.account_id !== p.accountId ||
        message.inbox_id !== before.snapshot.inboxId || message.conversation_id !== remote || message.private || message.message_type !== 'outgoing' ||
        !message.sender || !['user', 'User'].includes(message.sender.type ?? '') || String(message.sender.id) !== p.externalActorId ||
        typeof message.content !== 'string' || !receipt.success || receipt.data.takeoverId !== id || receipt.data.requestId !== before.row.request_id ||
        receipt.data.fingerprint !== before.row.fingerprint || nicoSendFingerprint(before.snapshot, p.externalActorId!, message.content) !== before.row.fingerprint)
        throw conflict('NICO_TAKEOVER_RECEIPT_MISMATCH');
      return options.transact(p.organizationId, async tx => {
        const current = await prepare(tx);
        // The destination lock serializes receipt admission in this organization.
        // Keep the unique index as the final invariant, but expose a stable API conflict.
        if ((await tx.query(`SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1 AND id<>$2 AND message_id=$3
          AND snapshot->>'origin'=$4 AND snapshot->>'accountId'=$5`,
        [p.organizationId,id,messageId,current.snapshot.origin,String(current.snapshot.accountId)])).rowCount)
          throw conflict('NICO_TAKEOVER_RECEIPT_CONFLICT');
        const saved = (await tx.query<TakeoverRow>(`UPDATE nico_takeover_operations SET state='COMPLETED',message_id=$3,updated_at=now()
          WHERE organization_id=$1 AND id=$2 RETURNING *`, [p.organizationId, id, messageId])).rows[0]!;
        await options.auth.audit(tx, p, 'NICO_TAKEOVER_COMPLETED', id);
        return view(tx, saved, current.snapshot, p);
      });
    },
    async cancel(p, integration, remote, raw) {
      const input = NicoTakeoverCancelSchema.parse({ requestId: raw.requestId, fingerprint: raw.fingerprint });
      return options.transact(p.organizationId, async tx => {
        await lockChatwootDestination(tx, p.organizationId); await authorize(tx, p, integration);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`nico-takeover:${p.organizationId}:${input.requestId}`]);
        const prior = (await tx.query<TakeoverRow>('SELECT * FROM nico_takeover_operations WHERE organization_id=$1 AND request_id=$2', [p.organizationId, input.requestId])).rows[0];
        if (prior) {
          sameIntent(prior, p, integration, remote, input);
          await lockAttendanceChannel(tx, p.organizationId, prior.channel_id);
          await authorize(tx, p, integration);
          // Trusted BFF has durably invalidated every local sender lease before this request.
          const row = (await tx.query<TakeoverRow>(`UPDATE nico_takeover_operations SET state=CASE WHEN state='OPEN' THEN 'CANCELED' ELSE state END,
            updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`, [p.organizationId, prior.id])).rows[0]!;
          if (prior.state === 'OPEN') await options.auth.audit(tx, p, 'NICO_TAKEOVER_CANCELED', row.id);
          const mode = (await tx.query<{ mode: 'BOT' | 'HUMAN' }>('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2', [p.organizationId, prior.conversation_id])).rows[0]!.mode;
          return view(tx, row, { ...row.snapshot, mode }, p);
        }
        const current = await captureTakeover(tx, p, integration, remote);
        const tombstone = await insert(tx, p, current.snapshot, input, null, 'CANCELED');
        await options.auth.audit(tx, p, 'NICO_TAKEOVER_CANCELED', tombstone.id);
        return view(tx, tombstone, current.snapshot, p);
      });
    },
  };
}
