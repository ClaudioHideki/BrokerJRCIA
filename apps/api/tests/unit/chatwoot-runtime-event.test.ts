import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeChatwootRuntimeEvent } from '../../src/modules/integrations/chatwoot-runtime-event.js';

const binding = {
  organizationId: '11111111-1111-4111-8111-111111111111', channelId: '22222222-2222-4222-8222-222222222222',
  integrationId: '33333333-3333-4333-8333-333333333333', origin: 'https://central.example.test',
  accountId: 1, inboxId: 11, destinationRevision: 3, credentialVersion: 4, ownerRevision: 9,
  status: 'READY' as const, transport: 'CENTRAL_TRANSPORT' as const,
};
const now = 1_800_000_000_000, secret = 'synthetic-webhook-secret', timestamp = String(now / 1000);
const message = {
  event: 'message_created', id: 101, account: { id: 1 }, inbox: { id: 11 },
  conversation: { id: 7, inbox_id: 11, account_id: 1, account: { id: 1 } },
  private: false, message_type: 'incoming', sender: { id: 4, type: 'contact', name: 'Synthetic Contact' },
  content: 'synthetic menu input',
};
const signature = (raw: Buffer, time = timestamp) => 'sha256=' + createHmac('sha256', secret).update(time + '.').update(raw).digest('hex');
const input = (value: unknown = message) => {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, secret, timestamp, signature: signature(raw), binding, current: binding, now };
};
const decode = (value: unknown = message) => decodeChatwootRuntimeEvent(input(value));
const outgoing = { ...message, message_type: 'outgoing', sender: { id: 9, type: 'user' } };
const echo = { ...binding, remoteConversationId: 7, remoteMessageId: 101 };

describe('central runtime authenticated event boundary', () => {
  it('returns scoped contact text without trusting payload organization or copying personal metadata', () => {
    const event = decode({ ...message, organizationId: 'foreign', sender: { ...message.sender, email: 'private@example.test' } });
    expect(event).toMatchObject({ kind: 'CONTACT_TEXT', scope: binding, remoteConversationId: 7, remoteMessageId: 101,
      contactId: 4, text: message.content, requiresCanonicalRead: true, mayExecute: false });
    expect(JSON.stringify(event)).not.toMatch(/foreign|private@example|Synthetic Contact|synthetic-webhook-secret/);
  });
  it.each(['incoming', 0])('accepts documented incoming representation %s', message_type => {
    expect(decode({ ...message, message_type })).toMatchObject({ kind: 'CONTACT_TEXT' });
  });
  it('bot and integration callbacks dedupe independently of delivery/timestamp/revision', () => {
    const first = decode(message);
    const otherTime = String(now / 1000 - 2), other = input({ ...message, delivery_id: 'another-delivery' });
    const nextBinding = { ...binding, credentialVersion: 5, ownerRevision: 10 };
    const second = decodeChatwootRuntimeEvent({ ...other, timestamp: otherTime, signature: signature(other.raw, otherTime),
      binding: nextBinding, current: nextBinding });
    expect(first.dedupeKey).toEqual(second.dedupeKey);
    for (const patch of [{ origin: 'https://other.example.test' }, { organizationId: '44444444-4444-4444-8444-444444444444' },
      { integrationId: '55555555-5555-4555-8555-555555555555' }, { channelId: '66666666-6666-4666-8666-666666666666' }]) {
      const scoped = { ...binding, ...patch };
      expect(decodeChatwootRuntimeEvent({ ...input(), binding: scoped, current: scoped }).dedupeKey).not.toEqual(first.dedupeKey);
    }
    expect(decode({ ...message, id: 102 }).dedupeKey).not.toEqual(first.dedupeKey);
  });
  it.each([{ signature: undefined }, { timestamp: undefined }, { signature: 'sha256=' + '0'.repeat(64) },
    { timestamp: String(now / 1000 - 301) }, { timestamp: String(now / 1000 + 301) }])('rejects unauthenticated/stale input %j', patch => {
    expect(() => decodeChatwootRuntimeEvent({ ...input(), ...patch })).toThrow('CENTRAL_SIGNATURE_INVALID');
  });
  it('authenticates raw bytes without parsing and reserializing', () => {
    const original = input();
    expect(() => decodeChatwootRuntimeEvent({ ...original, raw: Buffer.from(' ' + original.raw.toString()) })).toThrow('CENTRAL_SIGNATURE_INVALID');
    const spaced = Buffer.from('  ' + JSON.stringify(message) + '\n');
    expect(decodeChatwootRuntimeEvent({ ...original, raw: spaced, signature: signature(spaced) }).kind).toBe('CONTACT_TEXT');
  });
  it.each(['FAILED', 'DISABLED', 'PENDING', 'UNKNOWN'])('rejects binding %s', status => {
    expect(() => decodeChatwootRuntimeEvent({ ...input(), binding: { ...binding, status } })).toThrow('CENTRAL_BINDING_NOT_READY');
  });
  it.each([{ organizationId: '44444444-4444-4444-8444-444444444444' }, { origin: 'https://other.example.test' },
    { accountId: 2 }, { inboxId: 12 }, { destinationRevision: 4 }, { credentialVersion: 5 }, { ownerRevision: 10 },
    { channelId: '66666666-6666-4666-8666-666666666666' }, { status: 'DISABLED' }])('rejects current context change %j', patch => {
    expect(() => decodeChatwootRuntimeEvent({ ...input(), current: { ...binding, ...patch } })).toThrow('CENTRAL_CONTEXT_CHANGED');
  });
  it.each([{ origin: 'http://central.example.test' }, { origin: 'https://central.example.test/path' },
    { origin: 'https://user:secret@central.example.test' }, { transport: 'BROKER_TRANSPORT' }, { accountId: Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects invalid persisted scope without leaking the input %j', patch => {
      expect(() => decodeChatwootRuntimeEvent({ ...input(), binding: { ...binding, ...patch } })).toThrow('CENTRAL_SCOPE_INVALID');
    });
  it.each([{ account: { id: 2 } }, { inbox: { id: 12 } }, { conversation: { ...message.conversation, inbox_id: 12 } },
    { conversation: { ...message.conversation, account_id: 2 } }, { conversation: { ...message.conversation, account: { id: 2 } } },
    { conversation: { ...message.conversation, contact_inbox: { inbox_id: 12, contact_id: 4 } } }])(
    'rejects divergent outer/nested account or inbox %j', patch => expect(() => decode({ ...message, ...patch })).toThrow('CENTRAL_EVENT_SCOPE_MISMATCH'));
  it.each([Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '01', '1e2', -1, 0, 1.5])('rejects ambiguous/unsafe ID %s', id => {
    expect(() => decode({ ...message, id })).toThrow('CENTRAL_EVENT_INVALID');
  });
  it('accepts only canonical safe decimal strings for documented IDs', () => {
    expect(decode({ ...message, id: '101', account: { id: '1' }, inbox: { id: '11' }, sender: { id: '4', type: 'contact' },
      conversation: { id: '7', inbox_id: '11', account_id: '1' } })).toMatchObject({ kind: 'CONTACT_TEXT', remoteMessageId: 101 });
  });
  it.each([{ private: true }, { sender: { id: 4, type: 'user' } }, { sender: null }, { sender: { id: 4 } },
    { content: null, attachments: [{ id: 1 }] }, { content: '' }, { content: ' '.repeat(5) }, { message_type: 'activity' }])(
    'does not trigger automation from unsupported/private/noncontact input %j', patch => {
      expect(decode({ ...message, ...patch })).toMatchObject({ kind: 'IGNORED', mayExecute: false });
    });
  it('a public human reply is only a control observation and cannot be sent twice', () => {
    expect(decode(outgoing)).toMatchObject({ kind: 'ATTENDANCE_OBSERVATION', classification: { kind: 'HUMAN_PUBLIC', interruptsBot: true },
      mayExecute: false, mayForwardReply: false, requiresCanonicalRead: true });
  });
  it('a private note interrupts without exposing its content', () => {
    const event = decode({ ...outgoing, private: true, content: 'synthetic private note',
      sender: { id: 12, type: 'user', extra: 'synthetic private note' },
      additional_attributes: { unrelated: 'synthetic private note' }, content_attributes: { unrelated: 'synthetic private note' } });
    expect(event).toMatchObject({ kind: 'ATTENDANCE_OBSERVATION', classification: { kind: 'HUMAN_PRIVATE', interruptsBot: true } });
    expect(JSON.stringify(event)).not.toContain('synthetic private note');
  });
  it('does not trust claimed Broker echo metadata', () => {
    expect(decode({ ...outgoing, content_attributes: { jrc_broker_message_id: 'forged', origin: 'broker' } }))
      .toMatchObject({ kind: 'ATTENDANCE_OBSERVATION', classification: { kind: 'HUMAN_PUBLIC', interruptsBot: true } });
  });
  it('recognizes only persisted echo evidence with exact complete scope', () => {
    expect(decodeChatwootRuntimeEvent({ ...input(outgoing), echo })).toMatchObject({ kind: 'BROKER_ECHO', mayExecute: false });
    for (const patch of [{ origin: 'https://other.example.test' }, { credentialVersion: 3 }, { channelId: '66666666-6666-4666-8666-666666666666' },
      { organizationId: '44444444-4444-4444-8444-444444444444' }, { remoteConversationId: 8 }, { remoteMessageId: 102 }]) {
      expect(decodeChatwootRuntimeEvent({ ...input(outgoing), echo: { ...echo, ...patch } }).kind).toBe('ATTENDANCE_OBSERVATION');
    }
  });
  it('an unknown sender/external bot can block but cannot impersonate a human or release a bot', () => {
    expect(decode({ ...outgoing, sender: { id: 9, type: 'agent_bot' } }))
      .toMatchObject({ classification: { kind: 'EXTERNAL_BOT', interruptsBot: true }, mayForwardReply: false });
    expect(decode({ ...outgoing, sender: null })).toMatchObject({ classification: { kind: 'UNVERIFIED_REPLY', interruptsBot: true } });
  });
  it('pending control cannot resume a bot after a human takeover', () => {
    expect(decode({ event: 'conversation_status_changed', id: 7, account: { id: 1 }, inbox_id: 11, status: 'pending',
      updated_at: 1_800_000_000, meta: { assignee: null, assignee_type: null } })).toMatchObject({
      kind: 'ATTENDANCE_OBSERVATION', classification: { kind: 'CONVERSATION_CONTROL', status: 'pending' },
      mayExecute: false, requiresCanonicalRead: true,
    });
  });
  it('unknown events are authenticated before they are ignored', () => {
    expect(decode({ event: 'other_event' })).toMatchObject({ kind: 'IGNORED', mayExecute: false });
    expect(() => decodeChatwootRuntimeEvent({ ...input({ event: 'other_event' }), signature: undefined })).toThrow('CENTRAL_SIGNATURE_INVALID');
  });
  it('rejects malformed or oversized authenticated bytes without echoing payload', () => {
    for (const raw of [Buffer.from('{"invalid"'), Buffer.alloc(262145, 32)]) {
      expect(() => decodeChatwootRuntimeEvent({ ...input(), raw, signature: signature(raw) })).toThrow('CENTRAL_EVENT_INVALID');
    }
  });
  it.each([{ content_type: 'cards' }, { content_type: 'input_select' }, { attachments: [{ id: 1, file_type: 'image' }] },
    { attachments: [{ id: 2, file_type: 'document' }], content: 'synthetic attachment caption' }])(
    'does not misclassify structured/media content as a text turn %j', patch => {
      expect(decode({ ...message, ...patch })).toMatchObject({ kind: 'IGNORED', mayExecute: false });
    });
  it('accepts explicit plain text with an empty attachment list', () => {
    expect(decode({ ...message, content_type: 'text', attachments: [] }).kind).toBe('CONTACT_TEXT');
  });
  it('rejects invalid UTF-8 instead of replacing signed customer text silently', () => {
    const raw = Buffer.from(JSON.stringify(message).replace('synthetic menu input', ''));
    const prefix = Buffer.from(JSON.stringify(message).split('synthetic menu input')[0]);
    const suffix = Buffer.from(JSON.stringify(message).split('synthetic menu input')[1]!);
    const invalid = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    expect(() => decodeChatwootRuntimeEvent({ ...input(), raw: invalid, signature: signature(invalid) })).toThrow('CENTRAL_EVENT_INVALID');
    expect(decodeChatwootRuntimeEvent({ ...input(), raw, signature: signature(raw) }).kind).toBe('IGNORED');
  });
});
