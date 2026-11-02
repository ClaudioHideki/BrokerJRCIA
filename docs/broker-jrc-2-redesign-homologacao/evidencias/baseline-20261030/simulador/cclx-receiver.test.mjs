import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLabState, openLabReceiver, LAB_ORGANIZATION_ID, LAB_SECRET, copySyntheticMedia } from './cclx-receiver.mjs';

const eventId = '00000000-0000-4000-8000-000000000901';
const event = (extra = {}) => ({ schemaVersion: 1, eventId, cursor: '1', organizationId: LAB_ORGANIZATION_ID,
  type: 'message.received', occurredAt: '2026-10-29T00:00:00.000Z', data: { labFixture: true, sequence: 1 }, ...extra });
function request(body = JSON.stringify(event()), options = {}) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const id = options.id ?? eventId;
  const signature = 'sha256=' + createHmac('sha256', LAB_SECRET).update(`${timestamp}.${id}.`).update(body).digest('hex');
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-jrc-event-id': id,
    'x-jrc-timestamp': timestamp, 'x-jrc-signature': signature }, body, ...options.fetchOptions };
}
async function harness(t, options = {}) {
  const state = await createLabState({ labOnly: true });
  let receiver = await openLabReceiver({ labOnly: true, state, ...options });
  t.after(async () => { await receiver.close(); await rm(state.directory, { recursive: true, force: true }); });
  return { get receiver() { return receiver; }, state,
    post: (input = request()) => fetch(receiver.url, input),
    restart: async () => { await receiver.close(); receiver = await openLabReceiver({ labOnly: true, state }); } };
}

test('ACK follows durable inbox and one projection; replay after restart is duplicate', async t => {
  const h = await harness(t);
  const response = await h.post();
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'accepted', duplicate: false });
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
  await h.restart();
  assert.deepEqual(h.receiver.readEvent(eventId), event());
  const replay = await h.post();
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).duplicate, true);
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
});

test('parallel duplicates create exactly one inbox and projection', async t => {
  const h = await harness(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.post()));
  assert.ok(responses.every(r => r.status === 202));
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
});

for (const [name, change, status] of [
  ['tampered raw body', r => ({ ...r, body: r.body + ' ' }), 401],
  ['old signed timestamp', () => request(undefined, { timestamp: '1' }), 401],
  ['future signed timestamp', () => request(undefined, { timestamp: String(Math.floor(Date.now()/1000)+3600) }), 401],
  ['tenant divergence', () => request(JSON.stringify(event({ organizationId: '00000000-0000-4000-8000-000000000902' }))), 403],
  ['event header/body mismatch', () => request(undefined, { id: '00000000-0000-4000-8000-000000000902' }), 400],
  ['non fixture payload', () => request(JSON.stringify(event({ data: { content: 'synthetic but forbidden' } }))), 400],
  ['array cursor coerced to digits', () => request(JSON.stringify(event({ cursor: ['1'] }))), 400],
  ['numeric cursor coerced to digits', () => request(JSON.stringify(event({ cursor: 1 }))), 400],
  ['RFC timestamp with comment', () => request(JSON.stringify(event({ occurredAt: 'Thu, 29 Oct 2026 00:00:00 GMT (free content)' }))), 400],
  ['array occurredAt coerced to date', () => request(JSON.stringify(event({ occurredAt: ['2026-10-29T00:00:00.000Z'] }))), 400],
  ['numeric occurredAt coerced to date', () => request(JSON.stringify(event({ occurredAt: 0 }))), 400],
  ['nonexistent ISO calendar date', () => request(JSON.stringify(event({ occurredAt: '2026-02-30T00:00:00.000Z' }))), 400],
  ['ISO timestamp carrying trailing content', () => request(JSON.stringify(event({ occurredAt: '2026-10-29T00:00:00.000Z (extra)' }))), 400],
  ['body limit', () => request('x'.repeat(2048)), 413],
]) test(`rejects ${name} without persistence`, async t => {
  const h = await harness(t, { maxBodyBytes: 1024 });
  assert.equal((await h.post(change(request()))).status, status);
  assert.deepEqual(h.receiver.stats(), { inbox: 0, projections: 0 });
});

test('same tenant/eventId with different signed content is explicit conflict', async t => {
  const h = await harness(t);
  assert.equal((await h.post()).status, 202);
  const changed = event({ data: { labFixture: true, sequence: 2 } });
  assert.equal((await h.post(request(JSON.stringify(changed)))).status, 409);
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
});

for (const fault of ['http500', 'timeoutBeforeCommit', 'rollbackBeforeCommit']) test(`${fault} does not ACK or persist and retry succeeds`, async t => {
  const h = await harness(t, { faults: [fault] });
  if (fault === 'http500') assert.equal((await h.post()).status, 500);
  else if (fault === 'rollbackBeforeCommit') assert.equal((await h.post()).status, 500);
  else await assert.rejects(h.post(request(undefined, { fetchOptions: { signal: AbortSignal.timeout(50) } })));
  assert.deepEqual(h.receiver.stats(), { inbox: 0, projections: 0 });
  assert.equal((await h.post()).status, 202);
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
});

test('lost ACK after commit survives restart without double projection', async t => {
  const h = await harness(t, { faults: ['lostAckAfterCommit'] });
  await assert.rejects(h.post());
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
  await h.restart();
  const response = await h.post();
  assert.equal(response.status, 202);
  assert.equal((await response.json()).duplicate, true);
  assert.deepEqual(h.receiver.stats(), { inbox: 1, projections: 1 });
});

test('abrupt process death after committed lost ACK preserves WAL inbox on new process', { timeout: 10000 }, async t => {
  const state = await createLabState({ labOnly: true });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await rm(state.directory, { recursive: true, force: true });
  });
  async function start(faults) {
    const moduleUrl = new URL('cclx-receiver.mjs', import.meta.url).href;
    const code = `import { openLabReceiver } from ${JSON.stringify(moduleUrl)};
      process.once('message', async options => {
        const receiver = await openLabReceiver(options);
        process.send({url:receiver.url});
        process.on('message', message => {
          if(message === 'stats') process.send(receiver.stats());
          if(message === 'readback') {
            try { process.send(receiver.readEvent('00000000-0000-4000-8000-000000000901')); }
            catch { process.send({error:'READBACK_UNAVAILABLE'}); }
          }
        });
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_ENV: 'test' },
    });
    children.push(child);
    const ready = once(child, 'message');
    child.send({ labOnly: true, state, faults });
    const [message] = await ready;
    return { child, url: message.url };
  }
  const first = await start(['lostAckAfterCommit']);
  await assert.rejects(fetch(first.url, request()));
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const restarted = await start([]);
  const recovered = once(restarted.child, 'message'); restarted.child.send('readback');
  assert.deepEqual((await recovered)[0], event());
  const replay = await fetch(restarted.url, request());
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).duplicate, true);
  const stats = once(restarted.child, 'message'); restarted.child.send('stats');
  assert.deepEqual((await stats)[0], { inbox: 1, projections: 1 });
});

test('fixture guards refuse public binding, production, arbitrary database and missing lab flag', async t => {
  const state = await createLabState({ labOnly: true });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  await assert.rejects(openLabReceiver({ state, labOnly: true, host: '0.0.0.0' }), /LOOPBACK_ONLY/);
  await assert.rejects(openLabReceiver({ state, labOnly: true, environment: 'production' }), /PRODUCTION_REFUSED/);
  await assert.rejects(openLabReceiver({ state }), /LAB_ONLY_REQUIRED/);
  await assert.rejects(openLabReceiver({ labOnly: true, state: { directory: tmpdir(), token: state.token } }), /INVALID_LAB_STATE/);
  const arbitrary = await mkdtemp(join(tmpdir(), 'cclx-arbitrary-'));
  t.after(() => rm(arbitrary, { recursive: true, force: true }));
  await writeFile(join(arbitrary, 'inbox.sqlite'), 'DO NOT MODIFY');
  await assert.rejects(openLabReceiver({ labOnly: true, state: { directory: arbitrary, token: state.token } }), /INVALID_LAB_STATE/);
  assert.equal(await readFile(join(arbitrary, 'inbox.sqlite'), 'utf8'), 'DO NOT MODIFY');
});

test('CLI and safe runner refuse ambiguous or production invocation', () => {
  for (const file of ['cclx-receiver.mjs', 'run-safe-tests.mjs']) {
    const path = new URL(file, import.meta.url);
    const missing = spawnSync(process.execPath, [fileURLToPath(path)], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    const production = spawnSync(process.execPath, [fileURLToPath(path), '--lab-only'], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, timeout: 5000 });
    assert.notEqual(production.status, 0);
    assert.match(production.stderr, /PRODUCTION_REFUSED/);
  }
});

const mediaFixtures = [
  ['image/png', Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')],
  ['audio/wav', Buffer.from('524946460400000057415645', 'hex')],
  ['video/mp4', Buffer.from('000000186674797069736f6d0000020069736f6d', 'hex')],
  ['application/pdf', Buffer.from('%PDF-1.4\n% synthetic fixture\n%%EOF')],
];
for (const [mime, source] of mediaFixtures) test(`synthetic ${mime}: interrupted/limits/hash/MIME preserve source`, async () => {
  const original = Buffer.from(source);
  async function* complete() { yield source; }
  async function* interrupted() { yield source.subarray(0, 4); throw new Error('SYNTHETIC_INTERRUPTION'); }
  const partial = await copySyntheticMedia({ labOnly: true, chunks: interrupted(), mime, expected: source, maxBytes: 1024 });
  assert.equal(partial.status, 'INTERRUPTED');
  assert.equal(partial.sourceEligibleForDeletion, false);
  const unvalidated = await copySyntheticMedia({ labOnly: true, chunks: complete(), mime, expected: source, maxBytes: 1024 });
  assert.equal(unvalidated.status, 'COPIED_UNVALIDATED');
  assert.equal(unvalidated.hashMatches, true);
  assert.equal(unvalidated.sourceEligibleForDeletion, false);
  const limited = await copySyntheticMedia({ labOnly: true, chunks: complete(), mime, expected: source, maxBytes: 4 });
  assert.equal(limited.status, 'LIMIT_EXCEEDED');
  const mismatch = await copySyntheticMedia({ labOnly: true, chunks: complete(), mime: 'application/octet-stream', expected: source, maxBytes: 1024 });
  assert.equal(mismatch.status, 'MIME_REJECTED');
  const wrongHash = await copySyntheticMedia({ labOnly: true, chunks: complete(), mime, expected: Buffer.from('different'), maxBytes: 1024 });
  assert.equal(wrongHash.status, 'HASH_MISMATCH');
  assert.deepEqual(source, original);
});
