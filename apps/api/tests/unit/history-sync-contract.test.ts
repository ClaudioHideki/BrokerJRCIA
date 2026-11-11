import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as contract from '../../src/modules/history-sync/contract.js';
import { hashIdempotencyRequest } from '../../src/modules/instances/idempotency.js';

const scope = () => ({ organizationId: randomUUID(), channelId: randomUUID(), instanceId: randomUUID(),
  engineId: 'synthetic-engine', engineGeneration: 2, sessionGeneration: randomUUID(),
  bindingFingerprint: 'a'.repeat(64), identityScopeId: randomUUID(), historyAccountIdentity: randomUUID(),
  ownerFingerprint: 'b'.repeat(64) });
const now = new Date('2026-11-05T12:00:00Z');
const message = () => ({ kind: 'MESSAGE', recipientKind: 'INDIVIDUAL', chatJid: '15550000001@s.whatsapp.net',
  providerMessageId: 'synthetic-history-id', fromMe: false, participantJid: null,
  messageTimestamp: 1600000000, displayName: 'Synthetic contact', content: { type: 'TEXT', text: 'Historical text' }, state: 'SENT' });
function fixture(records: unknown[] = [message()]) {
  const s = scope();
  return { scope: s, chunk: { schemaVersion: 2, provenance: 'SOCKET', scope: s, chunkId: randomUUID(),
    ordinal: 0, capturedAt: now.toISOString(), isLast: true, progress: 100, records,
    checksum: hashIdempotencyRequest(records) } };
}
const parse = (raw: unknown, s: unknown) => {
  expect(contract).toHaveProperty('parseHistorySyncChunk');
  return (contract as Record<string, Function>).parseHistorySyncChunk(raw, s, now);
};

describe('history source V2 contract', () => {
  it('accepts old content captured by the authenticated current session', () => {
    const f = fixture();
    expect(parse(f.chunk, f.scope).records[0].messageTimestamp).toBe(1600000000);
  });
  it.each(['organizationId', 'channelId', 'instanceId', 'engineId', 'engineGeneration', 'sessionGeneration',
    'bindingFingerprint', 'identityScopeId', 'historyAccountIdentity', 'ownerFingerprint'])('rejects mismatched %s', key => {
    const f = fixture();
    const value = key === 'engineGeneration' ? 3 : key.endsWith('Fingerprint') ? 'c'.repeat(64)
      : key === 'engineId' ? 'other-engine' : randomUUID();
    expect(() => parse(f.chunk, { ...f.scope, [key]: value })).toThrow();
  });
  it('admits durable provisional staging without inventing an owner', () => {
    const f = fixture();
    const provisional = { ...f.scope, identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null };
    expect(parse({ ...f.chunk, scope: provisional }, provisional).scope.ownerFingerprint).toBeNull();
    expect(() => parse({ ...f.chunk, scope: { ...provisional, ownerFingerprint: 'c'.repeat(64) } }, provisional)).toThrow();
  });
  it('rejects cache relabeling and unknown envelope fields rather than accepting signed-looking data', () => {
    const f = fixture();
    expect(() => parse({ ...f.chunk, provenance: 'LEGACY_CACHE' }, f.scope)).toThrow();
    expect(() => parse({ ...f.chunk, credential: 'synthetic-secret' }, f.scope)).toThrow();
  });
  it('accepts group messages with explicit participants and media references', () => {
    const group = { ...message(), recipientKind: 'GROUP', chatJid: '100-200@g.us', participantJid: '15550000002@s.whatsapp.net',
      content: { type: 'MEDIA', referenceId: randomUUID(), mediaType: 'IMAGE', byteSize: 123, sha256: 'd'.repeat(64),
        mimeType: 'image/jpeg', filename: 'synthetic.jpg', caption: 'Synthetic caption' } };
    const f = fixture([group]);
    expect(parse(f.chunk, f.scope).records[0]).toEqual(group);
    const wrong = fixture([{ ...group, recipientKind: 'INDIVIDUAL' }]);
    expect(() => parse(wrong.chunk, wrong.scope)).toThrow();
  });
  it('rejects tampering, unknown media URL/key and oversized batches', () => {
    const f = fixture();
    expect(() => parse({ ...f.chunk, records: [{ ...message(), content: { type: 'TEXT', text: 'tampered' } }] }, f.scope)).toThrow();
    const forbidden = fixture([{ ...message(), content: { type: 'MEDIA', url: 'https://untrusted.invalid', mediaKey: 'private' } }]);
    expect(() => parse(forbidden.chunk, forbidden.scope)).toThrow();
    const large = fixture(Array.from({ length: 101 }, message));
    expect(() => parse(large.chunk, large.scope)).toThrow();
  });
  it('is independent of JSON property order without dropping any records', () => {
    const f = fixture();
    const reordered = Object.fromEntries(Object.entries(message()).reverse());
    expect(parse({ ...f.chunk, records: [reordered] }, f.scope).checksum).toBe(f.chunk.checksum);
    expect(createHash('sha256').update(JSON.stringify([reordered])).digest('hex')).not.toBe(f.chunk.checksum);
  });
  it('keeps the same logical owner fingerprint across reconnections while separating owners and tenants', () => {
    expect(contract).toHaveProperty('historyLogicalOwnerFingerprint');
    const hash = (contract as Record<string, Function>).historyLogicalOwnerFingerprint;
    const org = randomUUID(), channel = randomUUID(), key = 'synthetic-history-signing-key-at-least32';
    expect(hash(key, org, channel, '15550000001')).toBe(hash(key, org, channel, '15550000001'));
    expect(hash(key, org, channel, '15550000001')).not.toBe(hash(key, org, channel, '15550000002'));
    expect(hash(key, org, channel, '15550000001')).not.toBe(hash(key, randomUUID(), channel, '15550000001'));
  });
});
