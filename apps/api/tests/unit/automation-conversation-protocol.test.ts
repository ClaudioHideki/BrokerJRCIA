import { expect, it } from 'vitest';
import {
  conversationEffectRequestHash, ConversationEffectRequestSchema, ConversationEffectReceiptSchema,
  ConversationEffectContextSchema,
  matchConversationEffectReceipt,
} from '../../src/modules/automations/conversation-effect-protocol.js';

const organization_id = '11111111-2222-4333-8444-555555555555';
const operation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const dispatch_proof = '12345678-1234-4234-8234-123456789abc';
const common = { organization_id, operation_id, inbox_id: '2', remote_contact_id: '4', expected_control_revision: '5',
  operation: 'note' as const };
const vectors = [
  ['false', '0ba96623db057df8ac5aaa2055c4dbcfcdff3a0960fab0dfb289558bad7b94ad'],
  ['0', 'b59b4b4563b9ee90c6806650388464ddc445a3d9f2d2ee03fffe6ae8ae627c75'],
  ['-12.5', 'f5b70c5595f449aa91a6ad3279a24424b85eccaeafe6aa91cc2069fba804446b'],
  ['1e3', '562750c301b65d2edec70ef5071943df1084ce24f0c7570d02586b92e69763ec'],
  ['"Olá <JRC> 😀\\n\\"teste\\""', '1de74ee5d911121b80414f23ce3f9d00f131f559e55d9e69f76e460b740f910d'],
];
it.each(vectors)('matches the shared Ruby byte vector %s', (value_json, hash) => {
  expect(conversationEffectRequestHash({ accountId: 1, remoteConversationId: 3 }, { ...common, value_json })).toBe(hash);
});

const note = { ...common, dispatch_proof, value_json: '"Nota interna"' };
it('keeps the exact scalar bytes in the hash, including whitespace and exponent spelling', () => {
  const hash = (value_json: string) => conversationEffectRequestHash({ accountId: 1, remoteConversationId: 3 }, { ...common, value_json });
  expect(hash('1e3')).not.toBe(hash('1000'));
  expect(hash(' 0 ')).not.toBe(hash('0'));
});
it('accepts a bounded private note and a typed false/zero attribute', () => {
  expect(ConversationEffectRequestSchema.parse(note)).toEqual(note);
  for (const value_json of ['false', '0', '-12.5', '1e3', 'null', '"texto"']) {
    expect(ConversationEffectRequestSchema.safeParse({ ...note, operation: 'attribute', resource_id: '9',
      resource_revision: 'b'.repeat(64), value_json }).success).toBe(true);
  }
});
it('does not accept graph/client scope, unsafe decimals, missing resources, arrays, or wrong effect values', () => {
  const invalid = [
    { ...note, account_id: '99' }, { ...note, actor_user_id: '9' }, { ...note, inbox_id: '02' },
    { ...note, inbox_id: '9007199254740992' }, { ...note, expected_control_revision: '-1' },
    { ...note, operation: 'tag', value_json: 'null' }, { ...note, operation: 'attribute', value_json: '0' },
    { ...note, value_json: '{}' }, { ...note, value_json: '[]' }, { ...note, value_json: 'false' },
    { ...note, operation: 'resolve', value_json: '"open"' },
    { ...note, operation: 'resolve', value_json: '"RESOLVED"', resource_id: '3' },
    { ...note, dispatch_proof: 'not-a-proof' }, { ...note, value_json: '"' + '😀'.repeat(2200) + '"' },
  ];
  for (const candidate of invalid) expect(ConversationEffectRequestSchema.safeParse(candidate).success).toBe(false);
  expect(ConversationEffectRequestSchema.safeParse({ ...note, operation: 'resolve', value_json: '"RESOLVED"' }).success).toBe(true);
});
const context = { protocol: 'jrc-conversation-effects/2', account_id: 1, inbox_id: 2, conversation_id: 3,
  remote_contact_id: 4, contact_inbox_id: 5, actor_user_id: 6, routing_source_hash: 'c'.repeat(64),
  control_revision: 0, status: 'pending', assignee_id: null, assignee_agent_bot_id: null, team_id: null };
const receipt = { protocol: 'jrc-conversation-effects/2', state: 'CONFIRMED', account_id: 1, inbox_id: 2,
  conversation_id: 3, remote_contact_id: 4, contact_inbox_id: 5, actor_user_id: 6,
  routing_source_hash: 'c'.repeat(64), organization_id, operation_id, operation: 'note',
  resource_id: null, resource_revision: null, request_hash: 'a'.repeat(64), dispatch_proof_hash: 'd'.repeat(64),
  control_revision_before: 1, control_revision_after: 2, message_id: 8 };
it('requires real scope pins, monotonic control revisions and a note Message in receipts', () => {
  expect(ConversationEffectContextSchema.parse(context)).toEqual(context);
  expect(ConversationEffectReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const candidate of [
    { ...receipt, control_revision_after: 0 }, { ...receipt, message_id: null },
    { ...receipt, message_id: '8' }, { ...receipt, inbox_id: 9007199254740992 },
    { ...receipt, operation: 'resolve', message_id: 8 }, { ...receipt, content: 'not part of the receipt' },
  ]) expect(ConversationEffectReceiptSchema.safeParse(candidate).success).toBe(false);
});
it('counts the serialized UTF-8 body separately from the original scalar bound', () => {
  const value_json = JSON.stringify('\\'.repeat(4095));
  expect(Buffer.byteLength(value_json, 'utf8')).toBe(8192);
  expect(ConversationEffectRequestSchema.safeParse({ ...note, value_json }).success).toBe(false);
});
it('rejects nonfinite JSON, noncanonical proofs and invalid route IDs before hashing', () => {
  const attribute = { ...note, operation: 'attribute', resource_id: '9', resource_revision: 'b'.repeat(64) };
  for (const value_json of ['NaN', 'Infinity', '1e999', 'undefined']) {
    expect(ConversationEffectRequestSchema.safeParse({ ...attribute, value_json }).success).toBe(false);
  }
  expect(ConversationEffectRequestSchema.safeParse({ ...note, dispatch_proof: dispatch_proof.toUpperCase() }).success).toBe(false);
  expect(() => conversationEffectRequestHash({ accountId: '01', remoteConversationId: 3 }, note)).toThrow();
  expect(() => conversationEffectRequestHash({ accountId: 1, remoteConversationId: '9007199254740992' }, note)).toThrow();
});
it('keeps noop revisions valid but requires resource evidence for tag and attribute', () => {
  expect(ConversationEffectReceiptSchema.safeParse({ ...receipt, operation: 'tag', resource_id: 9,
    resource_revision: 'e'.repeat(64), message_id: null, control_revision_after: 1 }).success).toBe(true);
  expect(ConversationEffectReceiptSchema.safeParse({ ...receipt, operation: 'attribute', message_id: null }).success).toBe(false);
});
it('bounds decoded note text to 4096 UTF-8 bytes, matching the Rails builder contract', () => {
  expect(ConversationEffectRequestSchema.safeParse({ ...note, value_json: JSON.stringify('x'.repeat(4096)) }).success).toBe(true);
  for (const text of ['x'.repeat(4097), '😀'.repeat(1025)]) {
    expect(ConversationEffectRequestSchema.safeParse({ ...note, value_json: JSON.stringify(text) }).success).toBe(false);
  }
});
it('requires canonical UUID versions and rejects nil and max UUIDs', () => {
  for (const dispatch_proof of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    expect(ConversationEffectRequestSchema.safeParse({ ...note, dispatch_proof }).success).toBe(false);
  }
});

const admitted = { ...context, control_revision: 5 };
const confirmed = { ...receipt, request_hash: conversationEffectRequestHash({ accountId: 1, remoteConversationId: 3 }, note),
  dispatch_proof_hash: '232a373eb43ab309c1c264ae7c42826bc6ca4afb5a5ea2fc416dc67d866079a7',
  control_revision_before: 5, control_revision_after: 6 };
it('matches only the immutable request, proof and destination pins of an authenticated receipt', () => {
  expect(matchConversationEffectReceipt(confirmed, { context: admitted, request: note })).toEqual({ matched: true, receipt: confirmed });
});
it('rejects every changed identity or routing pin even when the operation ID is unchanged', () => {
  for (const changed of [
    { account_id: 10 }, { inbox_id: 20 }, { conversation_id: 30 }, { remote_contact_id: 40 },
    { contact_inbox_id: 50 }, { actor_user_id: 60 }, { routing_source_hash: 'e'.repeat(64) },
    { organization_id: dispatch_proof }, { operation_id: dispatch_proof },
  ]) expect(matchConversationEffectReceipt({ ...confirmed, ...changed }, { context: admitted, request: note }).matched).toBe(false);
});
it('never accepts a different scalar hash, proof, effect, resource or admission revision', () => {
  for (const changed of [
    { request_hash: 'e'.repeat(64) }, { dispatch_proof_hash: 'e'.repeat(64) },
    { control_revision_before: 4 }, { operation: 'resolve', message_id: null },
    { operation: 'attribute', message_id: null, resource_id: 9, resource_revision: 'b'.repeat(64) },
  ]) expect(matchConversationEffectReceipt({ ...confirmed, ...changed }, { context: admitted, request: note }).matched).toBe(false);
  const attribute = { ...note, operation: 'attribute' as const, resource_id: '9', resource_revision: 'b'.repeat(64), value_json: 'false' };
  const effect = { ...confirmed, operation: 'attribute', resource_id: 9, resource_revision: 'b'.repeat(64), message_id: null,
    request_hash: conversationEffectRequestHash({ accountId: 1, remoteConversationId: 3 }, attribute) };
  expect(matchConversationEffectReceipt(effect, { context: admitted, request: attribute }).matched).toBe(true);
  expect(matchConversationEffectReceipt({ ...effect, resource_id: 10 }, { context: admitted, request: attribute }).matched).toBe(false);
  expect(matchConversationEffectReceipt({ ...effect, resource_revision: 'c'.repeat(64) }, { context: admitted, request: attribute }).matched).toBe(false);
});
it('does not correlate a receipt against malformed or differently scoped expected input', () => {
  for (const request of [ { ...note, inbox_id: '20' }, { ...note, remote_contact_id: '40' },
    { ...note, expected_control_revision: '4' }, { ...note, value_json: '{}' } ]) {
    expect(matchConversationEffectReceipt(confirmed, { context: admitted, request: request as typeof note }).matched).toBe(false);
  }
  expect(matchConversationEffectReceipt(null, { context: admitted, request: note }).matched).toBe(false);
  expect(matchConversationEffectReceipt({ ...confirmed, content: 'not receipt data' }, { context: admitted, request: note }).matched).toBe(false);
});
it('returns only a confirmed fact and never grants execution after a newer human revision', () => {
  const result = matchConversationEffectReceipt({ ...confirmed, control_revision_after: 8 }, { context: admitted, request: note });
  expect(result.matched).toBe(true);
  expect(result).not.toHaveProperty('mayContinue');
  expect(result).not.toHaveProperty('allowed');
});
