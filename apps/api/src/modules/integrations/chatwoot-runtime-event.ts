import { createHash } from 'node:crypto';
import { z } from 'zod';
import { classifyChatwootAttendanceEvent, type ChatwootAttendanceEvent } from './chatwoot-attendance-events.js';
import { verifyChatwootSignature } from './secrets.js';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Some documented DTOs encode IDs as strings. Coerce only canonical decimal IDs,
// never whitespace, exponent notation, booleans or integers that lose precision.
const eventId = z.preprocess(value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value, id);
const origin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
  catch { return false; }
});
const bindingSchema = z.strictObject({
  organizationId: z.uuid(), channelId: z.uuid(), integrationId: z.uuid(), origin,
  accountId: id, inboxId: id, destinationRevision: id, credentialVersion: id,
  ownerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['READY', 'FAILED', 'DISABLED', 'PENDING', 'UNKNOWN']), transport: z.literal('CENTRAL_TRANSPORT'),
});
export type CentralRuntimeEventBinding = z.infer<typeof bindingSchema>;
export type CentralRuntimeEcho = CentralRuntimeEventBinding & { remoteConversationId: number; remoteMessageId: number };
const sameBinding = (left: CentralRuntimeEventBinding, right: CentralRuntimeEventBinding) =>
  (Object.keys(left) as (keyof CentralRuntimeEventBinding)[]).every(key => left[key] === right[key]);
const scopedId = z.object({ id: eventId });
const conversation = z.object({
  id: eventId, inbox_id: eventId, account: scopedId.optional(), account_id: eventId.optional(),
  contact_inbox: z.object({ inbox_id: eventId.optional(), contact_id: eventId.optional() }).optional(),
});
const messageSchema = z.object({
  event: z.literal('message_created'), id: eventId, account: scopedId, inbox: scopedId, conversation,
  private: z.boolean(), message_type: z.union([z.enum(['incoming', 'outgoing', 'activity', 'template']), z.number().int().min(0).max(3)]),
  content: z.string().max(4096).nullable().optional(), sender: z.unknown().optional(),
  content_type: z.string().max(100).optional(), attachments: z.array(z.unknown()).max(100).optional(),
  additional_attributes: z.unknown().optional(), content_attributes: z.unknown().optional(),
});
const controlSchema = z.object({
  event: z.enum(['conversation_created', 'conversation_updated', 'conversation_status_changed']),
  id: eventId, account: scopedId, account_id: eventId.optional(), inbox_id: eventId,
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']),
  updated_at: z.number().finite().nonnegative().nullable().optional(), meta: z.unknown().optional(),
});
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
const fail = (code: string): never => { throw new Error(code); };
const scopedKey = (scope: CentralRuntimeEventBinding, identity: unknown) => 'chatwoot-runtime:' + createHash('sha256')
  .update(JSON.stringify([scope.organizationId, scope.channelId, scope.integrationId, scope.origin, scope.accountId, scope.inboxId, identity])).digest('hex');
type Base = { scope: CentralRuntimeEventBinding; mayExecute: false; mayForwardReply: false; requiresCanonicalRead: true; dedupeKey: string | null };
export type CentralRuntimeEvent = Base & (
  { kind: 'CONTACT_TEXT'; remoteConversationId: number; remoteMessageId: number; contactId: number; text: string } |
  { kind: 'ATTENDANCE_OBSERVATION' | 'BROKER_ECHO'; classification: ChatwootAttendanceEvent; observationPayload: unknown; remoteConversationId: number; remoteMessageId?: number } |
  { kind: 'IGNORED' }
);

/** A decoder, not a dispatch authorization. The durable ingress must revalidate
 * this exact scope under its channel lock, and the worker must read canonical
 * remote conversation/message state before allowing any automatic effect.
 * `binding`, `current`, secret and echo must all come from trusted persisted data.
 * Neither payload metadata nor the route ID can supply these authorizations. */
export function decodeChatwootRuntimeEvent(input: {
  raw: Buffer; secret: string; timestamp: string | undefined; signature: string | undefined;
  binding: unknown; current: unknown; echo?: CentralRuntimeEcho; now?: number;
}): CentralRuntimeEvent {
  const parsed = bindingSchema.safeParse(input.binding);
  if (!parsed.success) return fail('CENTRAL_SCOPE_INVALID');
  const scope = parsed.data;
  if (scope.status !== 'READY') return fail('CENTRAL_BINDING_NOT_READY');
  const current = bindingSchema.safeParse(input.current);
  if (!current.success || !sameBinding(scope, current.data)) return fail('CENTRAL_CONTEXT_CHANGED');
  if (!Buffer.isBuffer(input.raw) || input.raw.length > 256 * 1024) return fail('CENTRAL_EVENT_INVALID');
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || !input.secret || input.secret.length > 4096 ||
    !verifyChatwootSignature(input.secret, input.raw, input.timestamp, input.signature, now)) return fail('CENTRAL_SIGNATURE_INVALID');
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.raw)); } catch { return fail('CENTRAL_EVENT_INVALID'); }
  const header = z.object({ event: z.string().min(1).max(128) }).safeParse(payload);
  if (!header.success) return fail('CENTRAL_EVENT_INVALID');
  const base: Base = { scope, mayExecute: false, mayForwardReply: false, requiresCanonicalRead: true, dedupeKey: null };
  const requireScope = (accountId: number, inboxId: number) => {
    if (accountId !== scope.accountId || inboxId !== scope.inboxId) fail('CENTRAL_EVENT_SCOPE_MISMATCH');
  };
  if (header.data.event === 'message_created') {
    const parsedMessage = messageSchema.safeParse(payload);
    if (!parsedMessage.success) return fail('CENTRAL_EVENT_INVALID');
    const message = parsedMessage.data, conv = message.conversation;
    requireScope(message.account.id, message.inbox.id);
    requireScope(conv.account?.id ?? scope.accountId, conv.inbox_id);
    requireScope(conv.account_id ?? scope.accountId, conv.contact_inbox?.inbox_id ?? scope.inboxId);
    const identity = { remoteConversationId: conv.id, remoteMessageId: message.id };
    base.dedupeKey = scopedKey(scope, ['message', conv.id, message.id]);
    if (message.message_type === 'incoming' || message.message_type === 0) {
      const sender = record(message.sender), contactId = eventId.safeParse(sender.id);
      if (message.private || sender.type !== 'contact' || !contactId.success || !message.content?.trim() ||
        (message.content_type !== undefined && message.content_type !== 'text') || message.attachments?.length) return { ...base, kind: 'IGNORED' };
      if (conv.contact_inbox?.contact_id !== undefined && conv.contact_inbox.contact_id !== contactId.data) return fail('CENTRAL_EVENT_SCOPE_MISMATCH');
      return { ...base, kind: 'CONTACT_TEXT', ...identity, contactId: contactId.data, text: message.content };
    }
    // The existing classifier accepts numeric IDs. Normalize only the safely
    // parsed sender ID; do not infer a sender type or trust claimed echo metadata.
    const sender = record(message.sender), senderId = eventId.safeParse(sender.id);
    const senderType = z.enum(['user', 'agent_bot', 'contact']).safeParse(sender.type);
    const attributes = record(message.additional_attributes), contentAttributes = record(message.content_attributes);
    const marker = z.uuid().safeParse(contentAttributes.jrc_broker_message_id);
    const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(contentAttributes.jrc_broker_dispatch_proof);
    // The store needs a normalized control DTO, never private text, attachments,
    // actor metadata or arbitrary attributes from the original callback.
    const normalized = { event: message.event, id: message.id, account: message.account, inbox: message.inbox,
      conversation: conv, message_type: message.message_type, private: message.private,
      sender: senderId.success ? { id: senderId.data, ...(senderType.success ? { type: senderType.data } : {}) } : undefined,
      additional_attributes: attributes.campaign_id != null ? { campaign_id: true } : {},
      content_attributes: { ...(contentAttributes.automation_rule_id != null ? { automation_rule_id: true } : {}),
        ...(marker.success ? { jrc_broker_message_id: marker.data } : {}),
        ...(proof.success ? { jrc_broker_dispatch_proof: proof.data } : {}) } };
    const echo = input.echo && bindingSchema.safeParse(Object.fromEntries(Object.entries(input.echo)
      .filter(([key]) => key !== 'remoteConversationId' && key !== 'remoteMessageId')));
    const evidence = echo && echo.success && sameBinding(scope, echo.data) ? input.echo : undefined;
    const classified = classifyChatwootAttendanceEvent(normalized, scope, evidence);
    if (!classified || classified.kind === 'SYSTEM_MESSAGE') return { ...base, kind: 'IGNORED' };
    return { ...base, ...identity, kind: classified.kind === 'BROKER_ECHO' ? 'BROKER_ECHO' : 'ATTENDANCE_OBSERVATION',
      classification: { ...classified, mayForwardReply: false }, observationPayload: normalized };
  }
  if (['conversation_created', 'conversation_updated', 'conversation_status_changed'].includes(header.data.event)) {
    const control = controlSchema.safeParse(payload);
    if (!control.success) return fail('CENTRAL_EVENT_INVALID');
    requireScope(control.data.account.id, control.data.inbox_id);
    requireScope(control.data.account_id ?? scope.accountId, control.data.inbox_id);
    let classification: ChatwootAttendanceEvent | null;
    try { classification = classifyChatwootAttendanceEvent(control.data, scope); } catch { return fail('CENTRAL_EVENT_INVALID'); }
    if (!classification || classification.kind !== 'CONVERSATION_CONTROL') return fail('CENTRAL_EVENT_INVALID');
    const assigned = classification.assignee;
    const observationPayload = { event: control.data.event, id: control.data.id, account: control.data.account,
      inbox_id: control.data.inbox_id, status: classification.status, updated_at: classification.remoteUpdatedAt,
      meta: { ...(assigned.kind === 'NONE' ? { assignee: null } : assigned.kind === 'HUMAN' || assigned.kind === 'EXTERNAL_BOT'
        ? { assignee: { id: assigned.id, type: assigned.kind === 'HUMAN' ? 'user' : 'agent_bot' } } : {}),
        team: classification.teamId === null ? null : { id: classification.teamId } } };
    return { ...base, kind: 'ATTENDANCE_OBSERVATION', remoteConversationId: control.data.id, classification, observationPayload,
      dedupeKey: scopedKey(scope, ['control', classification]) };
  }
  return { ...base, kind: 'IGNORED' };
}
