import { expect, it } from 'vitest';
import { ConversationViewSchema, LocalConversationContextSchema } from '../src/index.js';
const id = '11111111-2222-4333-8444-555555555555', channel = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const scope = { organizationId: id, channelId: channel, conversationId: id };
const facts = { scope, revision: '9007199254740993', status: 'RESOLVED', labels: [{ id, name: 'Suporte' }],
  attributes: [{ key: 'active', name: 'Ativo', value: false }, { key: 'amount', name: 'Valor', value: 0 }],
  privateNotes: [{ id, text: 'Nota privada', createdAt: '2026-10-15T12:00:00.000Z' }], notesTruncated: false };
it('keeps exact SQL revisions and typed false/zero in the private local projection', () => {
  expect(LocalConversationContextSchema.parse(facts)).toEqual(facts);
  expect(ConversationViewSchema.parse({ id, channelId: channel, contactId: id, mode: 'HUMAN', localContext: facts }).localContext).toEqual(facts);
});
it('does not accept a private note shaped as an outbound transport receipt or hidden command', () => {
  expect(LocalConversationContextSchema.safeParse({ ...facts, privateNotes: [{ ...facts.privateNotes[0], direction: 'OUTGOING', state: 'SENT' }] }).success).toBe(false);
  expect(LocalConversationContextSchema.safeParse({ ...facts, credential: 'forbidden-fixture' }).success).toBe(false);
});
it('bounds a local context page and rejects untyped nested attribute payloads', () => {
  expect(LocalConversationContextSchema.safeParse({ ...facts, privateNotes: Array(101).fill(facts.privateNotes[0]) }).success).toBe(false);
  expect(LocalConversationContextSchema.safeParse({ ...facts, attributes: [{ key: 'x', name: 'X', value: { nested: 'data' } }] }).success).toBe(false);
});
