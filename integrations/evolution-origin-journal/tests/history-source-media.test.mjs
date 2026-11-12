import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createOriginJournal, installOriginJournal } from '../src/journal.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

const key = Buffer.alloc(32, 94), now = new Date('2026-11-12T12:00:00Z');
const bytes = Buffer.from('synthetic-private-media-bytes');
const scope = () => ({ organizationId: randomUUID(), channelId: randomUUID(), instanceId: randomUUID(), engineId: 'synthetic-engine',
  engineGeneration: 1, sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64),
  identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null });
const fixture = () => ({ 'messaging-history.set': { messages: [{ key: {
  id: 'synthetic-history-image', remoteJid: `${'1'.repeat(11)}@s.whatsapp.net`, fromMe: false,
}, messageTimestamp: 1600000000, message: { imageMessage: { mimetype: 'image/png', fileLength: bytes.length,
  fileSha256: createHash('sha256').update(bytes).digest(), mediaKey: Buffer.alloc(32, 23),
  directPath: '/v/synthetic-private-object.enc', url: 'https://attacker.invalid/never-fetch', caption: 'Synthetic caption',
  unrelatedSecret: 'SYNTHETIC_RAW_EVENT_CANARY' } } }], chats: [], contacts: [] } });
const context = () => ({ captureId: randomUUID(), capturedAt: now, provenance: 'SOCKET', startOrdinal: 0 });
let admin, pool, database;
const journal = (captureMedia = true) => createOriginJournal({ pool, encryptionKey: key,
  history: { maxStagedBytes: 2000000, captureMedia } }).history;
before(async () => {
  const url = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL);
  database = `jrc_test_history_media_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url.href, max: 1 });
  await admin.query(`CREATE DATABASE "${database}"`); url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.href, max: 3 }); await installOriginJournal(pool);
});
after(async () => {
  await pool?.end();
  try { if (admin && database) await admin.query(`DROP DATABASE "${database}"`); }
  finally { await admin?.end(); }
});

test('commits encrypted minimal media obligations with the source page and recovers them after restart', async () => {
  const s = scope(), run = randomUUID(), input = fixture(), capture = context(), store = journal();
  const token = store.prepare(s, run, input, capture);
  input['messaging-history.set'].messages[0].message.imageMessage.mediaKey.fill(99);
  await store.append(token);
  const restarted = journal(), [page] = await restarted.pending(s);
  const media = page.chunk.records[0].content;
  assert.equal(media.type, 'MEDIA', 'a recoverable source attachment must not become an irreversible GAP');
  const claimed = await restarted.claimMedia(s, run, now);
  assert.equal(claimed.reference.referenceId, media.referenceId);
  assert.equal(claimed.descriptor.mediaKey, Buffer.alloc(32, 23).toString('base64'));
  assert.doesNotMatch(JSON.stringify(claimed), /attacker|unrelatedSecret|SYNTHETIC_RAW_EVENT_CANARY/u);
  assert.equal(await journal().claimMedia(s, run, now), null, 'another worker cannot use an active lease');
  assert.equal(await journal().claimMedia({ ...s, sessionGeneration: randomUUID() }, run, now), null);
  const rows = (await pool.query('SELECT descriptor_ciphertext FROM jrc_evolution_origin.history_media WHERE run_id=$1', [run])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].descriptor_ciphertext.includes(Buffer.from(claimed.descriptor.mediaKey)), false);
  await restarted.append(restarted.prepare(s, run, fixture(), capture));
  assert.equal((await restarted.pending(s)).length, 1, 'lost source ACK keeps the same page and attachment identity');
  assert.equal((await pool.query('SELECT count(*) FROM jrc_evolution_origin.history_media WHERE run_id=$1', [run])).rows[0].count, '1');
});

test('media staging is atomic with pages and respects the explicitly disabled default', async () => {
  const s = scope(), run = randomUUID(), disabled = journal(false);
  await disabled.append(disabled.prepare(s, run, fixture(), context()));
  assert.equal((await disabled.pending(s))[0].chunk.records[0].reason, 'MEDIA_UNAVAILABLE');
  assert.equal(await disabled.claimMedia(s, run, now), null);
  const invalid = fixture(); invalid['messaging-history.set'].messages[0].message.imageMessage.fileSha256 = Buffer.alloc(1);
  const other = scope(), otherRun = randomUUID(), store = journal();
  await store.append(store.prepare(other, otherRun, invalid, context()));
  assert.equal((await store.pending(other))[0].chunk.records[0].reason, 'MEDIA_UNAVAILABLE');
  assert.equal(await store.claimMedia(other, otherRun, now), null);
  const unsupported=fixture();unsupported['messaging-history.set'].messages[0].message.imageMessage.mimetype='image/svg+xml';
  const rejected=scope(),rejectedRun=randomUUID();await store.append(store.prepare(rejected,rejectedRun,unsupported,context()));
  assert.equal((await store.pending(rejected))[0].chunk.records[0].reason,'MEDIA_UNAVAILABLE');
  assert.equal(await store.claimMedia(rejected,rejectedRun,now),null);
});

test('a repeatedly failing media item does not starve unattempted files from the same source page',async()=>{
  const s=scope(),run=randomUUID(),store=journal(),input=fixture();
  const other=fixture()['messaging-history.set'].messages[0];other.key.id='synthetic-next-image';
  input['messaging-history.set'].messages.push(other);
  await store.append(store.prepare(s,run,input,context()));
  const first=await store.claimMedia(s,run,now);await store.retryMedia(s,first,'PERSISTENCE_UNCERTAIN',now);
  const second=await store.claimMedia(s,run,new Date(now.getTime()+60000));
  assert.notEqual(second.reference.referenceId,first.reference.referenceId);
});

test('normalizes Opus MIME parameters before freezing the cross-system media reference',async()=>{
  const s=scope(),run=randomUUID(),store=journal(),input=fixture();
  const message=input['messaging-history.set'].messages[0],raw=message.message.imageMessage;
  message.message={audioMessage:{...raw,mimetype:'audio/ogg; codecs=opus'}};
  await store.append(store.prepare(s,run,input,context()));
  const [page]=await store.pending(s),claim=await store.claimMedia(s,run,now);
  assert.equal(page.chunk.records[0].content.mimeType,'audio/ogg');
  assert.equal(claim.reference.mimeType,'audio/ogg');
});

test('requires original scope, current lease, authority and exact physical custody before settling; KEEP survives', async () => {
  const s = scope(), run = randomUUID(), store = journal();
  await store.append(store.prepare(s, run, fixture(), context()));
  const claimed = await store.claimMedia(s, run, now);
  const receipt = { protocol: 'jrc-history-media/2', persisted: true, scopeKey: claimed.scopeKey, runId: run,
    referenceId: claimed.reference.referenceId, sha256: claimed.reference.sha256, byteSize: bytes.length };
  assert.equal(await store.settleMedia(s, claimed, { status: 200 }, now, async () => {}), false);
  assert.equal(await store.settleMedia(s, claimed, { ...receipt, sha256: 'b'.repeat(64) }, now, async () => {}), false);
  await assert.rejects(store.settleMedia(s, claimed, receipt, now, async () => { throw Error('AUTHORITY_REVOKED'); }), /AUTHORITY_REVOKED/u);
  const later = new Date(now.getTime() + 61000), replacement = await journal().claimMedia(s, run, later);
  assert.notEqual(replacement.leaseToken, claimed.leaseToken);
  assert.equal(await store.settleMedia(s, claimed, receipt, later, async () => {}), false);
  assert.equal(await store.settleMedia(s, replacement, receipt, later, async () => {}), true);
  assert.equal(await journal().claimMedia(s, run, later), null);
  assert.equal((await pool.query('SELECT state,descriptor_ciphertext IS NOT NULL AS retained FROM jrc_evolution_origin.history_media WHERE run_id=$1', [run])).rows[0].retained, true);
});

test('freezes receipt correlation before the authority await and validates the retained descriptor rather than caller metadata',async()=>{
  const s=scope(),run=randomUUID(),store=journal();await store.append(store.prepare(s,run,fixture(),context()));
  const claim=await store.claimMedia(s,run,now),receipt={protocol:'jrc-history-media/2',persisted:true,scopeKey:claim.scopeKey,runId:run,
    referenceId:claim.reference.referenceId,sha256:claim.reference.sha256,byteSize:claim.reference.byteSize};
  const forged={...claim,reference:{...claim.reference,sha256:'b'.repeat(64)}};
  assert.equal(await store.settleMedia(s,forged,{...receipt,sha256:'b'.repeat(64)},now,async()=>{}),false);
  assert.equal(await store.settleMedia(s,claim,receipt,now,async()=>{receipt.referenceId=randomUUID();receipt.sha256='c'.repeat(64);}),true);
});

test('SIGKILL after source COMMIT retains the encrypted page and recoverable media obligation without duplicating recapture',{timeout:15000},async t=>{
  const s=scope(),run=randomUUID(),capture=context(),event=fixture();
  const child=fork(new URL('./fixtures/history-media-crash-child.mjs',import.meta.url),[],{
    execArgv:['--max-old-space-size=128'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],
  });
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const committed=once(child,'message');
  child.send({connectionString:pool.options.connectionString,scope:s,runId:run,captureId:capture.captureId,capturedAt:now.toISOString(),event});
  assert.equal((await committed)[0].kind,'COMMITTED');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const restarted=journal(),pages=await restarted.pending(s,{runId:run});
  assert.equal(pages.length,1);assert.equal(pages[0].chunk.records[0].content.type,'MEDIA');
  await restarted.append(restarted.prepare(s,run,event,capture));
  const claim=await restarted.claimMedia(s,run,now);
  assert.equal(claim.reference.referenceId,pages[0].chunk.records[0].content.referenceId);
  assert.equal(claim.reference.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await pool.query('SELECT count(*) FROM jrc_evolution_origin.history_media WHERE run_id=$1',[run])).rows[0].count,'1');
});
