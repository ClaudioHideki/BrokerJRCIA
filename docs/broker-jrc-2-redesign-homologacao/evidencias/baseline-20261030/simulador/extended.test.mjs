import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLabState, openLabReceiver, LAB_ORGANIZATION_ID, LAB_SECRET } from './cclx-receiver.mjs';

const secondTenant = '00000000-0000-4000-8000-000000000910';
const eventId = '00000000-0000-4000-8000-000000250001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('%PDF-1.4\n% synthetic fixture: bytes only, no codec claim\n%%EOF');
function request(organizationId = LAB_ORGANIZATION_ID, cursor = '9223372036854775807') {
  const body = JSON.stringify({ schemaVersion: 1, eventId, cursor, organizationId, type: 'message.received',
    occurredAt: '2026-10-30T00:00:00.000Z', data: { labFixture: true, sequence: 250001 } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-jrc-event-id': eventId,
    'x-jrc-timestamp': timestamp, 'x-jrc-signature': 'sha256=' + createHmac('sha256', LAB_SECRET).update(`${timestamp}.${eventId}.${body}`).digest('hex') }, body };
}
async function harness(t) {
  const state = await createLabState({ labOnly: true });
  let receiver = await openLabReceiver({ labOnly: true, state });
  t.after(async () => { await receiver.close(); await rm(state.directory, { recursive: true, force: true }); });
  return { state, get receiver() { return receiver; },
    restart: async () => { await receiver.close(); receiver = await openLabReceiver({ labOnly: true, state }); } };
}
const mediaOptions = (extra = {}) => ({ eventId, organizationId: LAB_ORGANIZATION_ID,
  mime: 'application/pdf', expectedHash: sha(bytes), maxBytes: 1024,
  chunks: (async function* () { yield bytes; })(), ...extra });

test('250k namespace, BIGINT cursor and two tenants preserve independent inbox effects', async t => {
  const h = await harness(t);
  for (const tenant of [LAB_ORGANIZATION_ID, secondTenant]) assert.equal((await fetch(h.receiver.url, request(tenant))).status, 202);
  assert.deepEqual(h.receiver.stats(), { inbox: 2, projections: 2 });
  await h.restart();
  assert.equal(h.receiver.readEvent(eventId, secondTenant).organizationId, secondTenant);
  assert.equal((await fetch(h.receiver.url, request(LAB_ORGANIZATION_ID, '9223372036854775808'))).status, 400);
});

test('file sync and receipt commit survive restart; duplicate media has one receipt', async t => {
  const h = await harness(t);
  assert.equal((await fetch(h.receiver.url, request())).status, 202);
  assert.equal(typeof h.receiver.persistMedia, 'function');
  const receipt = await h.receiver.persistMedia(mediaOptions());
  assert.equal(receipt.status, 'COPY_PERSISTED_UNVALIDATED');
  assert.equal(receipt.ack, 'ACK_COPY_PERSISTED_LAB');
  assert.equal(receipt.sourceEligibleForDeletion, false);
  assert.deepEqual(await readFile(join(h.state.directory, receipt.objectName)), bytes);
  await h.restart();
  assert.deepEqual(h.receiver.readMediaReceipt(eventId), receipt);
  assert.deepEqual(await h.receiver.persistMedia(mediaOptions()), receipt);
});

test('interruption, bad hash and absent inbox cannot issue a media receipt', async t => {
  const h = await harness(t);
  assert.equal(typeof h.receiver.persistMedia, 'function');
  await assert.rejects(h.receiver.persistMedia(mediaOptions()), /EVENT_NOT_PERSISTED/);
  assert.equal((await fetch(h.receiver.url, request())).status, 202);
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ chunks: (async function* () { yield bytes.subarray(0, 4); throw Error('INTERRUPTED'); })() })), /INTERRUPTED/);
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ expectedHash: '0'.repeat(64) })), /HASH_MISMATCH/);
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ maxBytes: 4 })), /LIMIT_EXCEEDED/);
  assert.equal(h.receiver.readMediaReceipt(eventId), null);
});

test('file sync failure point yields no receipt; retry adopts verified bytes', async t => {
  const h = await harness(t);
  assert.equal((await fetch(h.receiver.url, request())).status, 202);
  assert.equal(typeof h.receiver.persistMedia, 'function');
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ fault: 'afterFileSync' })), /SYNTHETIC_AFTER_FILE_SYNC/);
  assert.equal(h.receiver.readMediaReceipt(eventId), null);
  await h.restart();
  const receipt = await h.receiver.persistMedia(mediaOptions());
  assert.equal(receipt.hash, sha(bytes));
});

test('lost media receipt after commit is recovered idempotently after restart', async t => {
  const h = await harness(t);
  assert.equal((await fetch(h.receiver.url, request())).status, 202);
  assert.equal(typeof h.receiver.persistMedia, 'function');
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ fault: 'afterReceiptCommit' })), /SYNTHETIC_LOST_MEDIA_ACK/);
  await h.restart();
  const receipt = h.receiver.readMediaReceipt(eventId);
  assert.ok(receipt);
  assert.deepEqual(await h.receiver.persistMedia(mediaOptions()), receipt);
  await assert.rejects(h.receiver.persistMedia(mediaOptions({ expectedHash: '1'.repeat(64) })), /MEDIA_CONTENT_CONFLICT/);
});
