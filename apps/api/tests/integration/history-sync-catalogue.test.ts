import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncStore } from '../../src/modules/history-sync/store.js';
import { historySyncRecordsDigest, type HistorySyncScope, type HistorySyncRecord } from '../../src/modules/history-sync/contract.js';

let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => { db = await attendanceDatabase(); }, 180000);
afterAll(async () => { await db?.dispose(); });
const now = new Date('2026-11-11T12:00:00Z');
const selection = { mode: 'FULL_AVAILABLE', categories: ['INDIVIDUAL', 'GROUP', 'MEDIA'] };
const chat: HistorySyncRecord = { kind: 'CHAT', recipientKind: 'INDIVIDUAL', chatJid: '15550000001@s.whatsapp.net',
  displayName: 'Synthetic source chat', lastMessageAt: 1600000000, unreadCount: 2 };
async function fixture() {
  const t = await seedAttendanceTenant(db.database), instanceId = randomUUID();
  await db.database.pool.query(`INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key)
    SELECT $1::uuid,organization_id,provider_account_id,($1::uuid)::text,($1::uuid)::text FROM messaging_channels WHERE id=$2`, [instanceId,t.channel]);
  const scope: HistorySyncScope = { organizationId: t.org, channelId: t.channel, instanceId, engineId: 'synthetic-engine', engineGeneration: 1,
    sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64), historyAccountIdentity: randomUUID(),
    identityScopeId: randomUUID(), ownerFingerprint: 'b'.repeat(64) };
  let revoked = false;
  const options = { transact: db.transact, encryptionKey: Buffer.alloc(32,72), maxStagedBytes: 4000000,
    assertCurrentScope: async () => { if (revoked) throw Error('HISTORY_SYNC_AUTHORITY_REVOKED'); } };
  const store = createHistorySyncStore(options);
  const chunk = (records: HistorySyncRecord[], ordinal = 0) => ({ schemaVersion: 2, provenance: 'SOCKET', scope,
    chunkId: randomUUID(), ordinal, capturedAt: now.toISOString(), isLast: false, progress: null, records, checksum: historySyncRecordsDigest(records) });
  return { t, scope, store, options, chunk, revoke: () => { revoked = true; } };
}

it('catalogues chats, contacts and group message envelopes without claiming message or media persistence', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  const records: HistorySyncRecord[] = [chat, { kind: 'CONTACT', jid: '123456789012345@lid', displayName: 'Synthetic unresolved LID' },
    { kind: 'MESSAGE', recipientKind: 'GROUP', chatJid: '100-200@g.us', displayName: 'Synthetic group', providerMessageId: 'synthetic-group',
      participantJid: '15550000002@s.whatsapp.net', fromMe: false, messageTimestamp: 1600000001, state: 'SENT',
      content: { type: 'TEXT', text: 'Synthetic private text not materialized by the catalogue' } },
    { kind: 'GAP', chatJid: null, providerMessageId: null, reason: 'MEDIA_UNAVAILABLE' }];
  await f.store.acceptChunk(f.scope,run.id,f.chunk(records),now);
  const result = await f.store.catalogNext(f.scope,run.id,now);
  expect(result).toMatchObject({ kind: 'CATALOGUED', peers: 3, recordCount: 4, chats: 2 });
  expect((await db.transact(f.t.org,tx=>tx.query(`SELECT recipient_kind,peer_jid,discovered_as_chat FROM history_sync_peers
    WHERE channel_id=$1 ORDER BY peer_jid`,[f.t.channel]))).rows).toEqual([
    { recipient_kind: 'GROUP', peer_jid: '100-200@g.us', discovered_as_chat: true },
    { recipient_kind: 'INDIVIDUAL', peer_jid: '123456789012345@lid', discovered_as_chat: false },
    { recipient_kind: 'INDIVIDUAL', peer_jid: chat.chatJid, discovered_as_chat: true }]);
  const progress = (await db.transact(f.t.org,tx=>tx.query(`SELECT next_ordinal,persistence,persisted_messages,pending_media,state
    FROM history_sync_runs WHERE id=$1`,[run.id]))).rows[0];
  expect(progress).toEqual({ next_ordinal: '0', persistence: 'PENDING', persisted_messages: '0', pending_media: '0', state: 'RUNNING' });
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM messaging_messages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('0');
  expect(await f.store.catalogNext(f.scope,run.id,now)).toEqual({ kind: 'IDLE' });
});

it('keeps the same logical chat across duplicate pages, a restarted store and a reconnected capture', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([chat]),now);
  const results = await Promise.all([f.store.catalogNext(f.scope,run.id,now),f.store.catalogNext(f.scope,run.id,now)]);
  expect(results.map(value=>value.kind).sort()).toEqual(['CATALOGUED','IDLE']);
  const first = (await db.transact(f.t.org,tx=>tx.query('SELECT * FROM history_sync_peers WHERE channel_id=$1',[f.t.channel]))).rows[0];
  const reconnect = { ...f.scope, identityScopeId: randomUUID(), sessionGeneration: randomUUID(), engineGeneration: 2 };
  const restarted = createHistorySyncStore(f.options), next = await restarted.admit(reconnect,randomUUID(),selection,now);
  const old = { ...chat, chatJid: '15550000001:2@s.whatsapp.net', lastMessageAt: 1500000000, displayName: 'Stale source name' };
  const chunk = { ...f.chunk([old]), scope: reconnect };
  await restarted.acceptChunk(reconnect,next.id,chunk,now);
  expect(await restarted.catalogNext(reconnect,next.id,now)).toMatchObject({ kind: 'CATALOGUED', peers: 1 });
  const rows = (await db.transact(f.t.org,tx=>tx.query('SELECT * FROM history_sync_peers WHERE channel_id=$1',[f.t.channel]))).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: first.id, last_message_at: '1600000000', display_name: chat.displayName });
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_catalogue_pages WHERE channel_id=$1',[f.t.channel]))).rows[0].count).toBe('2');
});

it('keeps provisional chunks invisible and catalogues them only after same-capture promotion', async () => {
  const f = await fixture(), provisional = { ...f.scope, historyAccountIdentity: null, identityScopeId: null, ownerFingerprint: null };
  const run = await f.store.admit(provisional,randomUUID(),selection,now), chunk = { ...f.chunk([chat]), scope: provisional };
  await f.store.acceptChunk(provisional,run.id,chunk,now);
  expect(await f.store.catalogNext(provisional,run.id,now)).toEqual({ kind: 'WAITING_IDENTITY' });
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_peers'))).rows[0].count).toBe('0');
  await f.store.promote(run.id,f.scope,now);
  expect(await f.store.catalogNext(f.scope,run.id,now)).toMatchObject({ kind: 'CATALOGUED', peers: 1 });
});

it('rolls back catalogue records and its checkpoint together and safely resumes', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([chat]),now);
  const crashing = createHistorySyncStore({ ...f.options, transact: (org,work) => db.transact(org,async tx=>{
    const result = await work(tx);
    throw Object.assign(Error('SYNTHETIC_BEFORE_COMMIT'),{ result });
  }) });
  await expect(crashing.catalogNext(f.scope,run.id,now)).rejects.toThrow('SYNTHETIC_BEFORE_COMMIT');
  const counts = (await db.transact(f.t.org,tx=>tx.query(`SELECT (SELECT count(*) FROM history_sync_peers) AS peers,
    (SELECT count(*) FROM history_sync_catalogue_pages) AS pages`))).rows[0];
  expect(counts).toEqual({ peers: '0', pages: '0' });
  expect(await f.store.catalogNext(f.scope,run.id,now)).toMatchObject({ kind: 'CATALOGUED', peers: 1 });
});

it('does not expose a different owner or another tenant catalogue and fences pause and revocation', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([chat]),now);
  await f.store.command(f.scope,run.id,1,'PAUSE');
  await expect(f.store.catalogNext(f.scope,run.id,now)).rejects.toThrow('HISTORY_SYNC_NOT_RUNNING');
  await f.store.command(f.scope,run.id,2,'RESUME');
  await expect(f.store.catalogNext({ ...f.scope, historyAccountIdentity: randomUUID(), ownerFingerprint: 'c'.repeat(64) },run.id,now))
    .rejects.toThrow('HISTORY_SYNC_SCOPE_CHANGED');
  const foreign = await seedAttendanceTenant(db.database);
  await expect(f.store.catalogNext({ ...f.scope, organizationId: foreign.org },run.id,now)).rejects.toThrow('HISTORY_SYNC_NOT_FOUND');
  f.revoke();
  await expect(f.store.catalogNext(f.scope,run.id,now)).rejects.toThrow('HISTORY_SYNC_AUTHORITY_REVOKED');
  expect((await db.transact(foreign.org,tx=>tx.query('SELECT * FROM history_sync_peers'))).rows).toEqual([]);
});

it('processes one bounded committed chunk at a time while preserving separate group and contact identities', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  const contacts = Array.from({ length: 100 },(_,index): HistorySyncRecord => ({ kind: 'CONTACT',
    jid: `${15550000000+index}@s.whatsapp.net`, displayName: null }));
  await f.store.acceptChunk(f.scope,run.id,f.chunk(contacts),now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{ ...chat, recipientKind: 'GROUP', chatJid: '100-200@g.us' }],1),now);
  expect(await f.store.catalogNext(f.scope,run.id,now)).toMatchObject({ kind: 'CATALOGUED', peers: 100, chats: 0 });
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_peers'))).rows[0].count).toBe('100');
  expect(await f.store.catalogNext(f.scope,run.id,now)).toMatchObject({ kind: 'CATALOGUED', peers: 1, chats: 1 });
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT count(*) FROM history_sync_peers'))).rows[0].count).toBe('101');
});

it('preserves old owner catalogue separately and refuses retargeting or reversing a persisted peer clock', async () => {
  const f = await fixture(), first = await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,first.id,f.chunk([chat]),now);
  await f.store.catalogNext(f.scope,first.id,now);
  const changed = { ...f.scope, historyAccountIdentity: randomUUID(), ownerFingerprint: 'd'.repeat(64), identityScopeId: randomUUID() };
  const second = await f.store.admit(changed,randomUUID(),selection,now);
  await f.store.acceptChunk(changed,second.id,{ ...f.chunk([chat]), scope: changed },now);
  await f.store.catalogNext(changed,second.id,now);
  const peers = (await db.transact(f.t.org,tx=>tx.query('SELECT id,history_account_identity FROM history_sync_peers ORDER BY id'))).rows;
  expect(new Set(peers.map(row=>row.history_account_identity))).toEqual(new Set([f.scope.historyAccountIdentity,changed.historyAccountIdentity]));
  await expect(db.transact(f.t.org,tx=>tx.query('UPDATE history_sync_peers SET history_account_identity=$2 WHERE id=$1',
    [peers[0].id,randomUUID()]))).rejects.toMatchObject({ code: '42501' });
  await expect(db.transact(f.t.org,tx=>tx.query('UPDATE history_sync_peers SET last_message_at=1 WHERE id=$1',[peers[0].id])))
    .rejects.toMatchObject({ code: '23514' });
  await expect(db.transact(f.t.org,tx=>tx.query('DELETE FROM history_sync_peers WHERE id=$1',[peers[0].id])))
    .rejects.toMatchObject({ code: '42501' });
});

it('does not label a group or outgoing chat with the message sender pushName before authoritative chat metadata arrives', async () => {
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  const messages: HistorySyncRecord[] = [
    { kind: 'MESSAGE', recipientKind: 'GROUP', chatJid: '100-200@g.us', displayName: 'Synthetic participant',
      participantJid: '15550000002@s.whatsapp.net', providerMessageId: 'synthetic-name-group', fromMe: false,
      messageTimestamp: 1600000000, state: 'SENT', content: { type: 'TEXT', text: 'Synthetic group text' } },
    { kind: 'MESSAGE', recipientKind: 'INDIVIDUAL', chatJid: chat.chatJid, displayName: 'Synthetic own number name',
      participantJid: null, providerMessageId: 'synthetic-name-outbound', fromMe: true,
      messageTimestamp: 1600000000, state: 'SENT', content: { type: 'TEXT', text: 'Synthetic outgoing text' } }];
  await f.store.acceptChunk(f.scope,run.id,f.chunk(messages),now);
  await f.store.catalogNext(f.scope,run.id,now);
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT display_name FROM history_sync_peers ORDER BY peer_jid'))).rows)
    .toEqual([{ display_name: null },{ display_name: null }]);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{ ...chat, recipientKind: 'GROUP', chatJid: '100-200@g.us', displayName: 'Synthetic team subject' },
    { kind: 'CONTACT', jid: chat.chatJid, displayName: 'Synthetic contact name' }],1),now);
  await f.store.catalogNext(f.scope,run.id,now);
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT display_name FROM history_sync_peers ORDER BY peer_jid'))).rows)
    .toEqual([{ display_name: 'Synthetic team subject' },{ display_name: 'Synthetic contact name' }]);
});

it('treats blank source names as absent so a later contact record can fill the display name',async()=>{
  const f = await fixture(), run = await f.store.admit(f.scope,randomUUID(),selection,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{ ...chat,displayName: '  ' }]),now);
  await f.store.catalogNext(f.scope,run.id,now);
  await f.store.acceptChunk(f.scope,run.id,f.chunk([{ kind: 'CONTACT',jid: chat.chatJid,displayName: 'Synthetic contact name' }],1),now);
  await f.store.catalogNext(f.scope,run.id,now);
  expect((await db.transact(f.t.org,tx=>tx.query('SELECT display_name FROM history_sync_peers'))).rows)
    .toEqual([{ display_name: 'Synthetic contact name' }]);
});
