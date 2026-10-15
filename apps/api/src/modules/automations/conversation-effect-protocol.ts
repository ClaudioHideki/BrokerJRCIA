import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONVERSATION_EFFECT_PROTOCOL = 'jrc-conversation-effects/2' as const;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const uuid = z.uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  'Use a canonical versioned UUID');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveId = z.number().int().positive().max(MAX_SAFE);
const revision = z.number().int().nonnegative().max(MAX_SAFE);
const decimalId = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine(value => Number.isSafeInteger(Number(value)), 'Unsafe remote ID');
const decimalRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/)
  .refine(value => Number.isSafeInteger(Number(value)), 'Unsafe revision');
const operations = z.enum(['tag', 'attribute', 'note', 'resolve']);

function scalar(value: string): { valid: true; value: string | number | boolean | null } | { valid: false } {
  try {
    const decoded: unknown = JSON.parse(value);
    if (decoded === null || typeof decoded === 'string' || typeof decoded === 'boolean' ||
        typeof decoded === 'number' && Number.isFinite(decoded)) return { valid: true, value: decoded };
  } catch { /* Invalid JSON never becomes an effect. */ }
  return { valid: false };
}
const scalarJson = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 8192, 'Scalar exceeds 8192 bytes')
  .refine(value => scalar(value).valid, 'Use a finite JSON scalar');
const valueIs = (predicate: (value: string | number | boolean | null) => boolean) => scalarJson.refine(raw => {
  const decoded = scalar(raw);
  return decoded.valid && predicate(decoded.value);
}, 'Value is not valid for this effect');
const requestScope = {
  organization_id: uuid, operation_id: uuid, dispatch_proof: uuid,
  inbox_id: decimalId, remote_contact_id: decimalId, expected_control_revision: decimalRevision,
};
export const ConversationEffectRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...requestScope, operation: z.literal('tag'), resource_id: decimalId,
    resource_revision: digest, value_json: valueIs(value => value === null) }),
  z.strictObject({ ...requestScope, operation: z.literal('attribute'), resource_id: decimalId,
    resource_revision: digest, value_json: scalarJson }),
  z.strictObject({ ...requestScope, operation: z.literal('note'),
    value_json: valueIs(value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 4096) }),
  z.strictObject({ ...requestScope, operation: z.literal('resolve'), value_json: valueIs(value => value === 'RESOLVED') }),
]).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384, 'Effect body exceeds 16 KiB');
export type ConversationEffectRequest = z.infer<typeof ConversationEffectRequestSchema>;

const responseScope = {
  protocol: z.literal(CONVERSATION_EFFECT_PROTOCOL), account_id: positiveId, inbox_id: positiveId,
  conversation_id: positiveId, remote_contact_id: positiveId, contact_inbox_id: positiveId,
  actor_user_id: positiveId, routing_source_hash: digest,
};
export const ConversationEffectContextSchema = z.strictObject({
  ...responseScope, control_revision: revision, status: z.enum(['open', 'resolved', 'pending', 'snoozed']),
  assignee_id: positiveId.nullable(), assignee_agent_bot_id: positiveId.nullable(), team_id: positiveId.nullable(),
});
export type ConversationEffectContext = z.infer<typeof ConversationEffectContextSchema>;
export const ConversationEffectReceiptSchema = z.strictObject({
  ...responseScope, state: z.literal('CONFIRMED'), organization_id: uuid, operation_id: uuid, operation: operations,
  resource_id: positiveId.nullable(), resource_revision: digest.nullable(), request_hash: digest,
  dispatch_proof_hash: digest, control_revision_before: revision, control_revision_after: revision,
  message_id: positiveId.nullable(),
}).refine(value => value.control_revision_after >= value.control_revision_before, 'Control revision cannot regress')
  .refine(value => (value.operation === 'note') === (value.message_id !== null), 'Only notes have a Message receipt')
  .refine(value => ['tag', 'attribute'].includes(value.operation)
    ? value.resource_id !== null && value.resource_revision !== null
    : value.resource_id === null && value.resource_revision === null, 'Resource does not match this effect');
export type ConversationEffectReceipt = z.infer<typeof ConversationEffectReceiptSchema>;

export type ConversationEffectDigestInput = {
  organization_id: string; operation_id: string; inbox_id: string; remote_contact_id: string;
  expected_control_revision: string; operation: z.infer<typeof operations>; value_json: string;
  resource_id?: string; resource_revision?: string;
};
function routeId(value: number | string): string {
  return decimalId.parse(typeof value === 'number' ? String(positiveId.parse(value)) : value);
}
export function conversationEffectRequestHash(scope: { accountId: number | string; remoteConversationId: number | string },
  input: ConversationEffectDigestInput): string {
  // Hash the original UTF-8 scalar bytes. JSON normalization would change exponent,
  // whitespace and escaping and would disagree with the Ruby receipt ledger.
  const scalarHash = createHash('sha256').update(input.value_json, 'utf8').digest('hex');
  const material = [CONVERSATION_EFFECT_PROTOCOL, uuid.parse(input.organization_id), uuid.parse(input.operation_id),
    routeId(scope.accountId), decimalId.parse(input.inbox_id), routeId(scope.remoteConversationId),
    decimalId.parse(input.remote_contact_id), decimalRevision.parse(input.expected_control_revision),
    operations.parse(input.operation), input.resource_id === undefined ? '' : decimalId.parse(input.resource_id),
    input.resource_revision === undefined ? '' : digest.parse(input.resource_revision), scalarHash].join('\n');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export type ConversationEffectReceiptMatch =
  | { matched: true; receipt: ConversationEffectReceipt }
  | { matched: false };

/** Correlates an authenticated receipt with the persisted admission. This is
 * evidence of one remote fact; it never grants permission for the next node. */
export function matchConversationEffectReceipt(raw: unknown, expected: {
  context: ConversationEffectContext; request: ConversationEffectRequest;
}): ConversationEffectReceiptMatch {
  const parsedContext = ConversationEffectContextSchema.safeParse(expected.context);
  const parsedRequest = ConversationEffectRequestSchema.safeParse(expected.request);
  const parsedReceipt = ConversationEffectReceiptSchema.safeParse(raw);
  if (!parsedContext.success || !parsedRequest.success || !parsedReceipt.success) return { matched: false };
  const context = parsedContext.data, request = parsedRequest.data, receipt = parsedReceipt.data;
  if (request.inbox_id !== String(context.inbox_id) || request.remote_contact_id !== String(context.remote_contact_id) ||
      request.expected_control_revision !== String(context.control_revision)) return { matched: false };
  for (const pin of ['account_id', 'inbox_id', 'conversation_id', 'remote_contact_id', 'contact_inbox_id',
    'actor_user_id', 'routing_source_hash'] as const) {
    if (receipt[pin] !== context[pin]) return { matched: false };
  }
  const requestHash = conversationEffectRequestHash({ accountId: context.account_id, remoteConversationId: context.conversation_id }, request);
  const proofHash = createHash('sha256').update(request.dispatch_proof, 'utf8').digest('hex');
  if (receipt.organization_id !== request.organization_id || receipt.operation_id !== request.operation_id ||
      receipt.operation !== request.operation || receipt.control_revision_before !== context.control_revision ||
      receipt.request_hash !== requestHash || receipt.dispatch_proof_hash !== proofHash) return { matched: false };
  const resource = request.operation === 'tag' || request.operation === 'attribute' ? request : undefined;
  if (receipt.resource_id !== (resource ? Number(resource.resource_id) : null) ||
      receipt.resource_revision !== (resource?.resource_revision ?? null)) return { matched: false };
  return { matched: true, receipt };
}
