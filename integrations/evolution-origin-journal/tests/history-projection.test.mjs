import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { projectHistoryBatch } from '../src/history-projection.mjs';

const individual = `${'1'.repeat(11)}@s.whatsapp.net`, group = '100-200@g.us';
const scope = () => ({ organizationId: randomUUID(), channelId: randomUUID(), instanceId: randomUUID(),
  engineId: 'synthetic-engine', engineGeneration: 1, sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64),
  identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null });
const context = () => ({ captureId: randomUUID(), capturedAt: new Date('2026-11-11T12:00:00Z'), startOrdinal: 0, provenance: 'SOCKET' });
const message = (id = 'synthetic-message', extra = {}) => ({ key: { id, remoteJid: individual, fromMe: false },
  messageTimestamp: { low: 1600000000, high: 0, unsigned: true }, message: { conversation: 'Synthetic text' }, ...extra });
const payload = (messages, extra = {}) => ({ 'messaging-history.set': { messages, chats: [], contacts: [], isLatest: true, progress: 100, ...extra } });
const records = chunks => chunks.flatMap(chunk => chunk.records);

test('chunks a mixed authenticated history of more than 100 records without dropping text, outbound, chats or contacts', () => {
  const input = Array.from({ length: 205 }, (_, i) => message(`synthetic-${i}`, { key: { id: `synthetic-${i}`, remoteJid: individual, fromMe: i % 2 === 0 } }));
  const chunks = [...projectHistoryBatch(scope(), payload(input, { chats: [{ id: individual, name: 'Synthetic', unreadCount: 2 }],
    contacts: [{ id: individual, name: 'Synthetic contact' }] }), context())];
  assert.deepEqual(chunks.map(chunk => chunk.records.length), [100, 100, 7]);
  assert.deepEqual(chunks.map(chunk => chunk.isLast), [false, false, false]);
  assert.equal(records(chunks).filter(record => record.kind === 'MESSAGE').length, 205);
  assert.equal(records(chunks).filter(record => record.fromMe === true).length, 103);
  assert.equal(records(chunks).find(record => record.kind === 'MESSAGE').messageTimestamp, 1600000000);
});

test('keeps group identity and participant distinct, including chats without messages and LID contacts', () => {
  const input = message('group-message', { key: { id: 'group-message', remoteJid: group, participant: individual, fromMe: false } });
  const result = records([...projectHistoryBatch(scope(), payload([input], { chats: [{ id: group, name: 'Synthetic group' }],
    contacts: [{ id: '1000@lid', notify: 'Synthetic LID' }] }), context())]);
  assert.deepEqual(result.map(record => record.kind), ['CHAT', 'CONTACT', 'MESSAGE']);
  assert.equal(result[0].recipientKind, 'GROUP');
  assert.equal(result[2].participantJid, individual);
  assert.equal(result[1].jid, '1000@lid');
});

test('records an explicit gap for an incoming group without participant or unsupported content', () => {
  const result = records([...projectHistoryBatch(scope(), payload([
    message('missing-participant', { key: { id: 'missing-participant', remoteJid: group, fromMe: false } }),
    message('protocol-only', { message: { protocolMessage: { secret: 'must-not-survive' } } }),
  ]), context())]);
  assert.deepEqual(result.map(record => record.reason), ['IDENTITY_UNRESOLVED', 'UNSUPPORTED_CONTENT']);
});

test('captures only private verified media references and never remote URLs, media keys or raw context', () => {
  const input = message('media-message', { message: { imageMessage: { url: 'https://remote.invalid/private', mediaKey: Buffer.from('must-not-survive'),
    mimetype: 'image/jpeg', caption: 'Synthetic caption' }, contextInfo: { quotedMessage: 'must-not-survive' } } });
  const reference = { referenceId: randomUUID(), mediaType: 'IMAGE', byteSize: 123, sha256: 'd'.repeat(64),
    mimeType: 'image/jpeg', filename: 'synthetic.jpg', caption: 'Synthetic caption' };
  const [chunk] = [...projectHistoryBatch(scope(), payload([input]), { ...context(), mediaReference: () => reference })];
  assert.deepEqual(chunk.records[0].content, { type: 'MEDIA', ...reference });
  assert.doesNotMatch(JSON.stringify(chunk), /remote\.invalid|mediaKey|must-not-survive|quotedMessage/u);
  const [missing] = [...projectHistoryBatch(scope(), payload([input]), context())];
  assert.equal(missing.records[0].reason, 'MEDIA_UNAVAILABLE');
});

test('does not certify unverified media metadata or accept async references as physical receipts', () => {
  const input = payload([message('audio', { message: { audioMessage: { mimetype: 'audio/ogg' } } })]);
  for (const mediaReference of [() => ({ referenceId: randomUUID(), byteSize: 0 }), () => Promise.resolve({})]) {
    const result = records([...projectHistoryBatch(scope(), input, { ...context(), mediaReference })]);
    assert.equal(result[0].reason, 'MEDIA_UNAVAILABLE');
  }
});

test('uses stable chunk IDs and checksums for replay of an already admitted capture', () => {
  const binding = scope(), capture = context(), input = payload([message()]);
  const first = [...projectHistoryBatch(binding, input, capture)];
  assert.deepEqual([...projectHistoryBatch(binding, input, capture)], first);
  assert.notEqual([...projectHistoryBatch(binding, input, { ...capture, startOrdinal: 1 })][0].chunkId, first[0].chunkId);
  assert.equal(first[0].capturedAt, capture.capturedAt.toISOString());
});

test('bounds both record count and encoded bytes, and supports over ten thousand records in pages', () => {
  const binding = scope(), capture = context();
  const chunks = [...projectHistoryBatch(binding, payload(Array.from({ length: 10001 }, (_, i) => message(`large-${i}`))), capture)];
  assert.equal(records(chunks).length, 10001);
  assert.ok(chunks.every(chunk => chunk.records.length <= 100 && Buffer.byteLength(JSON.stringify(chunk)) <= 1048576));
  const unicode = Array.from({ length: 100 }, (_, i) => message(`unicode-${i}`, { message: { conversation: '字'.repeat(4096) } }));
  const pages = [...projectHistoryBatch(binding, payload(unicode), capture)];
  assert.ok(pages.length > 1);
  assert.equal(records(pages).length, 100);
  assert.ok(pages.every(page => Buffer.byteLength(JSON.stringify(page)) <= 1048576));
});

test('never treats Baileys isLatest or a per-phase progress value as proof of complete source history', () => {
  // isLatest denotes the first history sync in the pinned Baileys, not the last page.
  assert.equal([...projectHistoryBatch(scope(), payload([]), context())][0].isLast, false);
  const [partial] = [...projectHistoryBatch(scope(), payload([message()], { isLatest: false, progress: 40 }), context())];
  assert.equal(partial.isLast, false); assert.equal(partial.progress, 40);
  for (const capture of [{ ...context(), provenance: 'CACHE' }, { ...context(), capturedAt: new Date('invalid') },
    { ...context(), captureId: 'not-a-uuid' }]) {
    assert.throws(() => [...projectHistoryBatch(scope(), payload([message()]), capture)], /HISTORY_SOURCE_CONTEXT_INVALID/u);
  }
});

test('rejects partial owner claims and keeps yielded scope immutable across pages', () => {
  assert.throws(() => [...projectHistoryBatch({ ...scope(), identityScopeId: randomUUID() }, payload([message()]), context())], /HISTORY_SOURCE_CONTEXT_INVALID/u);
  const binding = scope(), capture = context();
  const iterator = projectHistoryBatch(binding, payload(Array.from({ length: 101 }, (_, i) => message(`snapshot-${i}`))), capture);
  const first = iterator.next().value;
  assert.throws(() => { first.scope.channelId = randomUUID(); }, TypeError);
  const channel = binding.channelId;
  binding.channelId = randomUUID();
  assert.equal(iterator.next().value.scope.channelId, channel);
});

test('does not reinterpret protocol, edit or reaction envelopes as normal historical text', () => {
  for (const field of ['protocolMessage', 'editedMessage', 'reactionMessage', 'senderKeyDistributionMessage']) {
    const result = records([...projectHistoryBatch(scope(),payload([message('control-event', { message: {
      conversation: 'Text next to a control event', [field]: { secret: 'must-not-survive' },
    } })]),context())]);
    assert.equal(result[0].kind,'GAP');
    assert.equal(result[0].reason,'UNSUPPORTED_CONTENT');
  }
});
