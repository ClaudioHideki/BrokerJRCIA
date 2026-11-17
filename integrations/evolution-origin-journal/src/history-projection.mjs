import { createHash } from 'node:crypto';

const individual = /^(?:[1-9]\d{7,14}(?::\d+)?@s\.whatsapp\.net|\d{1,30}(?::\d+)?@lid)$/u;
const group = /^\d+(?:-\d+)?@g\.us$/u;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const historyProjectionDigest = value => sha(canonical(value));
export const historyCaptureScopeKey = scope => historyProjectionDigest({ ...scope,
  identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null });
const kind = jid => typeof jid === 'string' && jid.length <= 128 ? group.test(jid) ? 'GROUP' : individual.test(jid) ? 'INDIVIDUAL' : null : null;
const name = value => typeof value === 'string' && value.length <= 512 ? value : null;
const number = value => {
  const result = typeof value === 'number' ? value : typeof value?.low === 'number' && typeof value?.high === 'number'
    ? (value.low >>> 0) + (value.high >>> 0) * 4294967296 : NaN;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
};
const gap = (reason, message = {}) => ({ kind: 'GAP', reason, chatJid: kind(message?.key?.remoteJid) ? message.key.remoteJid : null,
  providerMessageId: typeof message?.key?.id === 'string' && message.key.id.length > 0 && message.key.id.length <= 256 ? message.key.id : null });

function mediaContent(reference, mediaType) {
  if (!reference || !uuid.test(reference.referenceId) || reference.mediaType !== mediaType
    || !Number.isSafeInteger(reference.byteSize) || reference.byteSize < 1 || reference.byteSize > 100 * 1024 * 1024
    || !/^[a-f\d]{64}$/u.test(reference.sha256) || typeof reference.mimeType !== 'string' || !reference.mimeType.length || reference.mimeType.length > 255
    || typeof reference.filename !== 'string' || !reference.filename.length || reference.filename.length > 255
    || typeof reference.caption !== 'string' || reference.caption.length > 4096) return null;
  return { type: 'MEDIA', referenceId: reference.referenceId, mediaType, byteSize: reference.byteSize,
    sha256: reference.sha256, mimeType: reference.mimeType, filename: reference.filename, caption: reference.caption };
}

function projectMessage(message, context) {
  const key = message?.key, recipientKind = kind(key?.remoteJid), timestamp = number(message?.messageTimestamp);
  if (!recipientKind || typeof key?.id !== 'string' || !key.id.length || key.id.length > 256 || typeof key.fromMe !== 'boolean' || timestamp === null)
    return gap('RECORD_INVALID', message);
  const participantJid = typeof key.participant === 'string' && individual.test(key.participant) && key.participant.length <= 128 ? key.participant : null;
  if (recipientKind === 'GROUP' && !key.fromMe && !participantJid) return gap('IDENTITY_UNRESOLVED', message);
  let body = message.message;
  for (let i = 0; i < 4 && body; i++) {
    if (body.protocolMessage || body.editedMessage || body.reactionMessage || body.senderKeyDistributionMessage) return gap('UNSUPPORTED_CONTENT', message);
    const wrapped = body.ephemeralMessage?.message ?? body.viewOnceMessage?.message ?? body.viewOnceMessageV2?.message ?? body.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    body = wrapped;
  }
  if (body?.protocolMessage || body?.editedMessage || body?.reactionMessage || body?.senderKeyDistributionMessage) return gap('UNSUPPORTED_CONTENT', message);
  const text = body?.conversation ?? body?.extendedTextMessage?.text;
  let content = typeof text === 'string' && text.length > 0 && text.length <= 4096 ? { type: 'TEXT', text } : null;
  if (!content) {
    const mediaType = [['imageMessage', 'IMAGE'], ['audioMessage', 'AUDIO'], ['videoMessage', 'VIDEO'], ['documentMessage', 'DOCUMENT'], ['stickerMessage', 'STICKER']]
      .find(([field]) => body?.[field])?.[1];
    if (!mediaType) return gap('UNSUPPORTED_CONTENT', message);
    // The host-owned private media journal supplies a persisted reference.
    // Remote URL/key/quoted content never crosses this projection boundary.
    const reference = context.mediaReference?.({ chatJid: key.remoteJid, providerMessageId: key.id, fromMe: key.fromMe, mediaType });
    content = mediaContent(reference, mediaType);
    if (!content) return gap('MEDIA_UNAVAILABLE', message);
  }
  return { kind: 'MESSAGE', recipientKind, chatJid: key.remoteJid, providerMessageId: key.id, fromMe: key.fromMe,
    participantJid, messageTimestamp: timestamp, displayName: name(message.pushName), content,
    state: message.status === 0 ? 'FAILED' : message.status === 3 ? 'DELIVERED' : message.status >= 4 ? 'READ' : 'SENT' };
}

function* projectRecords(batch, context) {
  for (const chat of batch.chats ?? []) {
    const recipientKind = kind(chat?.id);
    yield recipientKind ? { kind: 'CHAT', recipientKind, chatJid: chat.id, displayName: name(chat.name ?? chat.subject),
      lastMessageAt: number(chat.conversationTimestamp), unreadCount: number(chat.unreadCount) ?? 0 } : gap('RECORD_INVALID');
  }
  for (const contact of batch.contacts ?? []) {
    yield kind(contact?.id) === 'INDIVIDUAL' ? { kind: 'CONTACT', jid: contact.id,
      displayName: name(contact.name ?? contact.notify ?? contact.verifiedName) } : gap('RECORD_INVALID');
  }
  for (const message of batch.messages ?? []) yield projectMessage(message, context);
}

/** Streaming socket projection port. The trusted host supplies scope/capture ID.
 * Does not install a host, download media or certify unavailable content.
 */
export function* projectHistoryBatch(binding, events, context) {
  const batch = events?.['messaging-history.set'];
  if (!batch) return;
  if (!context || context.provenance !== 'SOCKET' || !uuid.test(context.captureId) || !(context.capturedAt instanceof Date)
    || !Number.isFinite(context.capturedAt.getTime()) || !Number.isSafeInteger(context.startOrdinal) || context.startOrdinal < 0
    || !binding || !['organizationId', 'channelId', 'instanceId', 'sessionGeneration'].every(field => uuid.test(binding[field]))
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(binding.engineId) || !Number.isSafeInteger(binding.engineGeneration) || binding.engineGeneration < 1
    || !/^[a-f\d]{64}$/u.test(binding.bindingFingerprint)
    || !([binding.identityScopeId, binding.historyAccountIdentity, binding.ownerFingerprint].every(value => value === null)
      || (uuid.test(binding.identityScopeId) && uuid.test(binding.historyAccountIdentity) && /^[a-f\d]{64}$/u.test(binding.ownerFingerprint)))
    || ![batch.chats ?? [], batch.contacts ?? [], batch.messages ?? []].every(Array.isArray)) throw Error('HISTORY_SOURCE_CONTEXT_INVALID');
  const scope = Object.freeze(Object.fromEntries(['organizationId', 'channelId', 'instanceId', 'engineId', 'engineGeneration', 'sessionGeneration',
    'bindingFingerprint', 'identityScopeId', 'historyAccountIdentity', 'ownerFingerprint'].map(field => [field, binding[field]])));
  let ordinal = context.startOrdinal, page = [];
  const chunk = (records, isLast) => {
    const bytes = Buffer.from(sha(`${context.captureId}:${ordinal}`), 'hex');
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex'), chunkId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return { schemaVersion: 2, provenance: 'SOCKET', scope, chunkId, ordinal, capturedAt: context.capturedAt.toISOString(),
      isLast, progress: Number.isInteger(batch.progress) && batch.progress >= 0 && batch.progress <= 100 ? batch.progress : null,
      records, checksum: sha(canonical(records)) };
  };
  let pageBytes = Buffer.byteLength(JSON.stringify(chunk([], false)));
  for (const record of projectRecords(batch, context)) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    if (page.length && (page.length === 100 || pageBytes + recordBytes + 1 > 1048576)) {
      yield chunk(page, false); ordinal++; page = []; pageBytes = Buffer.byteLength(JSON.stringify(chunk([], false)));
    }
    pageBytes += recordBytes + (page.length ? 1 : 0);
    page.push(record);
  }
  // Baileys isLatest marks the first sync, not completion. Its progress is per
  // phase, including ON_DEMAND. No authenticated coverage-close proof exists here.
  yield chunk(page, false);
}
