import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { createLabState, openLabReceiver, LAB_ORGANIZATIONS, LAB_SECRET, requireLabOnly } from './cclx-receiver.mjs';

// Fixed tiny functional scenario. There is deliberately no target, rate or load argument.
async function smoke() {
  const state = await createLabState({ labOnly: true });
  let receiver = await openLabReceiver({ labOnly: true, state, faults: ['lostAckAfterCommit'] });
  const eventId = sequence => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const envelopes = Array.from({ length: 8 }, (_, index) => ({ schemaVersion: 1, eventId: eventId(250000 + index),
    cursor: String(9223372036854775800n + BigInt(index)), organizationId: LAB_ORGANIZATIONS[index % 2],
    type: 'message.received', occurredAt: '2026-10-30T00:00:00.000Z', data: { labFixture: true, sequence: index } }));
  const post = envelope => {
    const body = JSON.stringify(envelope), timestamp = String(Math.floor(Date.now() / 1000));
    const target = new URL(receiver.url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/lab/cclx/events') throw Error('LOOPBACK_ONLY');
    return fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: {
      'content-type': 'application/json', 'x-jrc-event-id': envelope.eventId, 'x-jrc-timestamp': timestamp,
      'x-jrc-signature': 'sha256=' + createHmac('sha256', LAB_SECRET).update(`${timestamp}.${envelope.eventId}.${body}`).digest('hex'),
    }, body });
  };
  try {
    await assert.rejects(post(envelopes[0]));
    await receiver.close(); receiver = await openLabReceiver({ labOnly: true, state });
    const duplicate = await post(envelopes[0]); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).duplicate, true);
    for (const envelope of envelopes.slice(1)) assert.equal((await post(envelope)).status, 202);
    const bytes = Buffer.from('%PDF-1.4\n% generated synthetic bytes, no codec claim\n%%EOF');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const media = extra => ({ eventId: envelopes[0].eventId, organizationId: envelopes[0].organizationId,
      mime: 'application/pdf', maxBytes: 1024, expectedHash, chunks: (async function* () { yield bytes; })(), ...extra });
    await assert.rejects(receiver.persistMedia(media({ fault: 'afterReceiptCommit' })), /SYNTHETIC_LOST_MEDIA_ACK/);
    await receiver.close(); receiver = await openLabReceiver({ labOnly: true, state });
    const receipt = receiver.readMediaReceipt(envelopes[0].eventId);
    assert.deepEqual(await receiver.persistMedia(media()), receipt);
    assert.deepEqual(await readFile(join(state.directory, receipt.objectName)), bytes);
    for (const envelope of envelopes) assert.deepEqual(receiver.readEvent(envelope.eventId, envelope.organizationId), envelope);
    return { kind: 'CCLX_LOCAL_FUNCTIONAL_SMOKE', capacityValidated: false, acceptedUnique: 8, ...receiver.stats(),
      mediaReceipts: 1, recoveredLostEventAck: true, recoveredLostMediaAck: true, bytesReadbackVerified: true,
      mediaStatus: receipt.status, sourceEligibleForDeletion: false, storage: 'SQLite WAL FULL + synced local file',
      pgExecuted: false, s3Executed: false, physicalSessions: 0 };
  } finally {
    await receiver.close();
    // Only the marker directory created by this call may be removed.
    const target = await realpath(state.directory);
    if (target !== resolve(state.directory) || dirname(target) !== await realpath(tmpdir()) || !/^cclx-lab-[A-Za-z0-9]+$/.test(basename(target))) throw Error('UNSAFE_CLEANUP');
    await rm(target, { recursive: true, force: true });
  }
}

try {
  requireLabOnly({ labOnly: process.argv[2] === '--lab-only' });
  if (process.argv.length !== 4 || !['--smoke', '--plan'].includes(process.argv[3])) throw Error('LAB_ARGUMENTS_ONLY');
  const daily = 250000;
  const result = process.argv[3] === '--smoke' ? await smoke() : {
    kind: 'BENCHMARK_PREPARATION_ONLY', capacityValidated: false, logicalMessagesPerDay: daily,
    averagePerSecond24h: daily / 86400, averagePerSecond8h: daily / 28800,
    peakMultipliersProposed: [5, 10], peakDurationSecondsProposed: 300, recoveryBetweenPeaksSecondsProposed: 900,
    gates: [50, 100, 200, 400, 900].map(sessions => ({ sessions, state: sessions === 900 ? 'PREPARATION_ONLY' : 'SKIP_LOAD',
      uniformMessagesPerSessionDay: daily / sessions })),
    warmupMinutesProposed: 15, steadyMinutesProposed: 60, repetitionsProposed: 3,
    prerequisite: 'Isolated PG/storage, real contract adapter, resource inventory and accepted SLOs before load',
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }
