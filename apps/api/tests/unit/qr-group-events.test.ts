import { describe, expect, it } from 'vitest';
import { normalizeQrGroupEvents } from '../../src/modules/messaging/qr-group-events.js';
import { normalizeQrEvent } from '../../src/modules/messaging/qr-events.js';
import { EvolutionMessagingClient } from '@jrc/providers';
import { vi } from 'vitest';
const instant = '2026-10-08T10:00:00.000Z';
const envelope = (data: unknown, event = 'group-participants.update') => ({
  event, instance: 'synthetic-engine', date_time: instant,
  sender: '15550000001:9@s.whatsapp.net', data,
  apikey: 'synthetic-private-canary', server_url: 'https://private.example.test',
});
describe('authenticated QR group event normalization', () => {
  it('preserves participant JIDs and explicit author without assigning a phone to a LID', () => {
    const events = normalizeQrGroupEvents(envelope({ id: '10000@g.us', action: 'remove',
      author: '15550000003@s.whatsapp.net', participants: ['123456789@lid', '15550000001:2@s.whatsapp.net'],
      participantsData: [{ jid: '123456789@lid', phoneNumber: '15550000001', name: 'Private name' }],
    }), 'synthetic-engine');
    expect(events).toEqual([{ kind: 'group', action: 'REMOVE', groupJid: '10000@g.us',
      providerEmittedAt: instant, senderJid: '15550000001@s.whatsapp.net',
      authorJid: '15550000003@s.whatsapp.net', participants: ['123456789@lid', '15550000001@s.whatsapp.net'], metadata: {},
    }]);
    expect(JSON.stringify(events)).not.toContain('Private name');
    expect(JSON.stringify(events)).not.toContain('synthetic-private-canary');
  });
  it('retains bounded group metadata without promoting owner to event author', () => {
    expect(normalizeQrGroupEvents(envelope([{ id: '10000@g.us', subject: ' Synthetic group ',
      owner: '15550000003@s.whatsapp.net', subjectOwner: '123456789@lid', announce: true,
      participants: [{ id: '15550000001@s.whatsapp.net', admin: 'admin' }], desc: 'private description' }], 'GROUPS_UPSERT'), 'synthetic-engine'))
      .toEqual([{ kind: 'group', action: 'UPSERT', groupJid: '10000@g.us', providerEmittedAt: instant,
        senderJid: '15550000001@s.whatsapp.net', authorJid: null,
        participants: ['15550000001@s.whatsapp.net'], metadata: { subject: 'Synthetic group',
          ownerJid: '15550000003@s.whatsapp.net', subjectAuthorJid: '123456789@lid', announce: true } }]);
  });
  it('accepts partial updates without inventing missing metadata or participant membership', () => {
    expect(normalizeQrGroupEvents(envelope([{ id: '10000@g.us', announce: false }], 'groups.update'), 'synthetic-engine')[0])
      .toMatchObject({ action: 'UPDATE', participants: [], metadata: { announce: false } });
  });
  it('rejects wrong instance, invalid group, malformed participants and unsupported action', () => {
    expect(() => normalizeQrGroupEvents(envelope({ id: '10000@g.us', action: 'add', participants: [] }), 'other')).toThrow('QR_INSTANCE_MISMATCH');
    for (const data of [{ id: '15550000001@s.whatsapp.net', action: 'add', participants: [] },
      { id: '10000@g.us', action: 'leave', participants: [] },
      { id: '10000@g.us', action: 'add', participants: ['arbitrary'] },
      { id: '10000@g.us', action: 'add', participants: ['15550000001@s.whatsapp.net', '15550000001:2@s.whatsapp.net'] }]) {
      expect(() => normalizeQrGroupEvents(envelope(data), 'synthetic-engine')).toThrow('QR_GROUP_EVENT_INVALID');
    }
  });
  it('bounds batches, participant count, subject and timestamp without retaining unknown fields', () => {
    for (const raw of [envelope(Array.from({ length: 101 }, () => ({ id: '10000@g.us' })), 'groups.update'),
      envelope({ id: '10000@g.us', action: 'add', participants: Array.from({ length: 2001 }, (_, n) => `${10000000 + n}@lid`) }),
      envelope([{ id: '10000@g.us', subject: 'x'.repeat(257) }], 'groups.update'),
      { ...envelope([{ id: '10000@g.us' }], 'groups.update'), date_time: 'invalid' }]) {
      expect(() => normalizeQrGroupEvents(raw, 'synthetic-engine')).toThrow('QR_GROUP_EVENT_INVALID');
    }
  });
  it('accepts a 1024-participant group without truncating JIDs or inventing telephone membership', () => {
    const participants = Array.from({ length: 1024 }, (_, n) => `${10000000 + n}@lid`);
    expect(normalizeQrGroupEvents(envelope({ id: '10000@g.us', action: 'add', participants }), 'synthetic-engine')[0]?.participants)
      .toEqual(participants);
  });
  it('recognizes the underscore event spelling but does not create events for unsupported provider kinds', () => {
    expect(normalizeQrGroupEvents(envelope({ id: '10000@g.us', action: 'promote', participants: ['123456789@lid'] }, 'GROUP_PARTICIPANTS_UPDATE'), 'synthetic-engine')[0])
      .toMatchObject({ action: 'PROMOTE' });
    expect(normalizeQrGroupEvents(envelope({}, 'call'), 'synthetic-engine')).toEqual([]);
  });
  it('keeps an opaque LID sender unresolved instead of accepting provider phoneNumber as owner identity', () => {
    expect(normalizeQrGroupEvents({ ...envelope({ id: '10000@g.us', action: 'add', participants: ['123456789@lid'] }),
      sender: '123456789@lid', phoneNumber: '15550000001' }, 'synthetic-engine')[0])
      .toMatchObject({ senderJid: '123456789@lid', participants: ['123456789@lid'] });
  });
  it('feeds group events into the canonical QR normalizer without treating a group as a phone contact', () => {
    expect(normalizeQrEvent(envelope({ id: '10000@g.us', action: 'remove', participants: ['15550000001@s.whatsapp.net'] }), 'synthetic-engine')[0])
      .toMatchObject({ kind: 'group', action: 'REMOVE', groupJid: '10000@g.us' });
  });
  it('registers the group event families with the existing authenticated webhook', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}'));
    const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.example.test', apiKey: 'private-global-canary', instanceKey: 'synthetic', fetch: request });
    await client.configureWebhook('https://broker.example.test/v1/webhooks/whatsapp/synthetic', 'scoped-token');
    const sent = JSON.parse(request.mock.calls[0]![1].body);
    expect(sent.webhook.events).toEqual(['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'GROUPS_UPSERT', 'GROUPS_UPDATE', 'GROUP_PARTICIPANTS_UPDATE']);
    expect(sent.webhook.headers).toEqual({ Authorization: 'Bearer scoped-token' });
    expect(sent.webhook).toMatchObject({ byEvents: false, base64: false });
    expect(sent.webhook.webhookByEvents).toBeUndefined(); expect(sent.webhook.webhookBase64).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('private-global-canary');
  });
  it('reads the pinned Prisma response shape without accepting request keys as configuration evidence', async () => {
    const events = ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','GROUPS_UPSERT','GROUPS_UPDATE','GROUP_PARTICIPANTS_UPDATE'];
    const response = { enabled: true, url: 'https://broker.example.test/qr', headers: { Authorization: 'Bearer scoped' },
      webhookByEvents: false, webhookBase64: false, events };
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, webhookByEvents: undefined, webhookBase64: undefined, byEvents: false, base64: false })))
      .mockResolvedValueOnce(new Response('null')).mockRejectedValueOnce(new Error('private-global-canary'));
    const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.example.test', apiKey: 'private-global-canary', instanceKey: 'synthetic', fetch: request });
    expect(await client.readWebhookConfiguration('https://broker.example.test/qr','scoped')).toBe('MATCHING');
    expect(await client.readWebhookConfiguration('https://broker.example.test/qr','scoped')).toBe('MISMATCHED');
    expect(await client.readWebhookConfiguration('https://broker.example.test/qr','scoped')).toBe('MISSING');
    await expect(client.readWebhookConfiguration('https://broker.example.test/qr','scoped')).rejects.toMatchObject({ code:'QR_CONFIGURATION_UNAVAILABLE' });
    expect(request.mock.calls[0]![0].toString()).toBe('https://engine.example.test/webhook/find/synthetic');
    expect(request.mock.calls[0]![1]).toMatchObject({ method:'GET',redirect:'error' });
  });
});
