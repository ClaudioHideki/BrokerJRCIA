import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { hashIdempotencyRequest } from '../instances/idempotency.js';

const id = z.uuid(), count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const individual = /^(?:[1-9]\d{7,14}(?::\d+)?@s\.whatsapp\.net|\d{1,30}(?::\d+)?@lid)$/u;
const group = /^\d+(?:-\d+)?@g\.us$/u;
const jid = z.string().max(128).refine(value => individual.test(value) || group.test(value));
const recipientKind = z.enum(['INDIVIDUAL', 'GROUP']);
export const HistorySyncScopeSchema = z.strictObject({
  organizationId: id, channelId: id, instanceId: id,
  engineId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), engineGeneration: count.positive(),
  sessionGeneration: id, bindingFingerprint: digest,
  identityScopeId: id.nullable(), historyAccountIdentity: id.nullable(), ownerFingerprint: digest.nullable(),
}).refine(value => [value.identityScopeId, value.historyAccountIdentity, value.ownerFingerprint].every(item => item === null)
  || [value.identityScopeId, value.historyAccountIdentity, value.ownerFingerprint].every(item => item !== null),
  'Partial identity cannot authorize promotion');

const media = z.strictObject({ type: z.literal('MEDIA'), referenceId: id,
  mediaType: z.enum(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER']),
  byteSize: count.positive().max(100 * 1024 * 1024), sha256: digest,
  mimeType: z.string().min(1).max(255), filename: z.string().min(1).max(255), caption: z.string().max(4096) });
const message = z.strictObject({ kind: z.literal('MESSAGE'), recipientKind, chatJid: jid,
  providerMessageId: z.string().min(1).max(256), fromMe: z.boolean(),
  participantJid: z.string().max(128).regex(individual).nullable(), messageTimestamp: count,
  displayName: z.string().max(512).nullable(),
  content: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('TEXT'), text: z.string().min(1).max(4096) }), media]),
  state: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
});
const chat = z.strictObject({ kind: z.literal('CHAT'), recipientKind, chatJid: jid,
  displayName: z.string().max(512).nullable(), lastMessageAt: count.nullable(), unreadCount: count });
const contact = z.strictObject({ kind: z.literal('CONTACT'), jid: z.string().max(128).regex(individual),
  displayName: z.string().max(512).nullable() });
const gap = z.strictObject({ kind: z.literal('GAP'), chatJid: jid.nullable(), providerMessageId: z.string().min(1).max(256).nullable(),
  reason: z.enum(['UNSUPPORTED_CONTENT', 'MEDIA_UNAVAILABLE', 'IDENTITY_UNRESOLVED', 'RECORD_INVALID', 'SOURCE_QUOTA']) });
export const HistorySyncRecordSchema = z.discriminatedUnion('kind', [message, chat, contact, gap]).refine(value => {
  if (value.kind !== 'MESSAGE' && value.kind !== 'CHAT') return true;
  if ((value.recipientKind === 'GROUP') !== group.test(value.chatJid)) return false;
  return value.kind !== 'MESSAGE' || value.recipientKind !== 'GROUP' || value.fromMe || value.participantJid !== null;
}, 'Recipient identity mismatch');
const records = z.array(HistorySyncRecordSchema).max(100);
export const HistorySyncChunkSchema = z.strictObject({
  schemaVersion: z.literal(2), provenance: z.literal('SOCKET'), scope: HistorySyncScopeSchema,
  chunkId: id, ordinal: count, capturedAt: z.iso.datetime({ offset: true }),
  isLast: z.boolean(), progress: z.number().int().min(0).max(100).nullable(),
  records, checksum: digest,
});
export type HistorySyncScope = z.infer<typeof HistorySyncScopeSchema>;
export type HistorySyncRecord = z.infer<typeof HistorySyncRecordSchema>;
export type HistorySyncChunk = z.infer<typeof HistorySyncChunkSchema>;

/** Capture identity survives promotion of that same authenticated socket's owner. */
export function historyCaptureScopeKey(scope: HistorySyncScope): string {
  return hashIdempotencyRequest({ ...HistorySyncScopeSchema.parse(scope), identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null });
}

export function historySyncRecordsDigest(value: unknown): string {
  return hashIdempotencyRequest(records.parse(value));
}

/** Scope comes from authenticated server bindings, never from the browser request. */
export function parseHistorySyncChunk(raw: unknown, expected: HistorySyncScope, now: Date): HistorySyncChunk {
  let value: HistorySyncChunk;
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 1_048_576 || !Number.isFinite(now.getTime())) throw new Error();
    value = HistorySyncChunkSchema.parse(raw);
    if (Date.parse(value.capturedAt) > now.getTime() + 300_000) throw new Error();
  } catch { throw new Error('HISTORY_SYNC_CHUNK_INVALID'); }
  if (hashIdempotencyRequest(value.scope) !== hashIdempotencyRequest(HistorySyncScopeSchema.parse(expected)))
    throw new Error('HISTORY_SYNC_SCOPE_CHANGED');
  if (historySyncRecordsDigest(value.records) !== value.checksum) throw new Error('HISTORY_SYNC_DIGEST_MISMATCH');
  return value;
}

/** A provisional envelope remains evidence of its original capture. A server-verified
 * current owner may admit it only within the same immutable capture generation.
 * An envelope that already claims an owner must match the current owner exactly.
 */
export function parseHistorySyncSourceChunk(raw: unknown, current: HistorySyncScope, now: Date): HistorySyncChunk {
  let capturedScope: HistorySyncScope;
  try { capturedScope = HistorySyncScopeSchema.parse((raw as {scope?: unknown})?.scope); }
  catch { throw Error('HISTORY_SYNC_CHUNK_INVALID'); }
  const chunk = parseHistorySyncChunk(raw, capturedScope, now);
  if (historyCaptureScopeKey(chunk.scope) !== historyCaptureScopeKey(current)
    || (chunk.scope.historyAccountIdentity !== null && hashIdempotencyRequest(chunk.scope) !== hashIdempotencyRequest(current)))
    throw Error('HISTORY_SYNC_SCOPE_CHANGED');
  return chunk;
}

/** Logical number identity excludes volatile instance keys, sessions and engine generations. */
export function historyLogicalOwnerFingerprint(key: string, organizationId: string, channelId: string, ownerPhone: string): string {
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || !/^[1-9]\d{7,14}$/u.test(ownerPhone))
    throw new Error('HISTORY_SYNC_IDENTITY_INVALID');
  return createHmac('sha256', key).update(JSON.stringify(['history-owner:v2', id.parse(organizationId), id.parse(channelId), ownerPhone])).digest('hex');
}
