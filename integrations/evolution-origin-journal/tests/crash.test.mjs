import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import { createOriginJournal, installOriginJournal } from '../src/journal.mjs';
import { createOriginHttpTransport } from '../src/http-transport.mjs';
import { createOriginDispatcher } from '../src/dispatcher.mjs';
import { projectTextBatch } from '../src/projection.mjs';
import { binding as template, source } from './fixtures.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

let pool, admin, database, connectionString, created = false;
const key = randomBytes(32), children = new Set();
const env = { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' };
const binding = () => ({ ...template, destinationId: randomUUID() });
const journal = () => createOriginJournal({ pool, encryptionKey: key });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
before(async () => {
  const target = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL);
  admin = new Pool({ connectionString: target.href, max: 1 });
  database = `jrc_test_origin_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  target.pathname = `/${database}`; connectionString = target.href;
  pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 6000 });
  assert.equal((await pool.query('SHOW fsync')).rows[0].fsync, 'on');
  assert.equal((await pool.query('SHOW full_page_writes')).rows[0].full_page_writes, 'on');
  assert.equal((await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'on');
  await installOriginJournal(pool);
  await pool.query('CREATE TABLE jrc_evolution_origin.synthetic_crash_receiver(event_id uuid PRIMARY KEY, effect_count integer NOT NULL DEFAULT 1)');
});
async function kill(child) {
  const exited = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true);
  const [code, signal] = await exited;
  assert.equal(signal, 'SIGKILL'); assert.equal(code, null); children.delete(child);
}
after(async () => {
  for (const child of children) await kill(child);
  await pool?.end();
  try { if (created && /^jrc_test_origin_[a-f0-9]{32}$/u.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
  finally { await admin?.end(); }
});
function child(config) {
  const process = fork(new URL('./crash-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.add(process);
  process.send({ connectionString, key: key.toString('hex'), ...config });
  return process;
}
async function phase(process, expected) {
  const [message] = await once(process, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(message.phase, expected); return message;
}
async function awaitLeaseExpiry(id) {
  const row = (await pool.query('SELECT lease_until FROM jrc_evolution_origin.events WHERE id=$1', [id])).rows[0];
  await sleep(Math.max(0, new Date(row.lease_until).getTime() - Date.now()) + 40);
}
test('SIGKILL after source COMMIT before dispatch preserves one encrypted obligation', async () => {
  const current = binding(), process = child({ mode: 'capture', binding: current });
  await phase(process, 'SOURCE_COMMITTED'); await kill(process);
  const claim = await journal().claim(current);
  assert.ok(claim); assert.equal(claim.attempt, 1);
  assert.equal(claim.body.data.message.conversation, 'Synthetic text');
});
test('SIGKILL after claim COMMIT recovers only after real lease expiration with fencing', async () => {
  const current = binding();
  const [accepted] = await journal().acceptBatch(current, projectTextBatch(current, source()));
  const process = child({ mode: 'claim', binding: current });
  await phase(process, 'LEASE_COMMITTED'); await kill(process);
  assert.equal(await journal().claim(current), null);
  await awaitLeaseExpiry(accepted.id);
  const claim = await journal().claim(current);
  assert.equal(claim.id, accepted.id); assert.equal(claim.attempt, 2);
  const attempts = (await pool.query('SELECT outcome FROM jrc_evolution_origin.attempts WHERE event_id=$1 ORDER BY number', [accepted.id])).rows;
  assert.deepEqual(attempts.map(row => row.outcome), ['LEASE_EXPIRED', 'CLAIMED']);
});
test('SIGKILL after synthetic HTTP recipient COMMIT before ACK retries same ID once without duplicate effect', async () => {
  const current = binding(), store = journal();
  const [accepted] = await store.acceptBatch(current, projectTextBatch(current, source()));
  let committedResolve, calls = 0;
  const committed = new Promise(resolve => { committedResolve = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* consume exact body before transaction */ }
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL synchronous_commit=on');
      await client.query('INSERT INTO jrc_evolution_origin.synthetic_crash_receiver(event_id) VALUES($1) ON CONFLICT DO NOTHING', [request.headers['x-jrc-origin-event-id']]);
      await client.query('COMMIT');
    } finally { client.release(); }
    calls++;
    if (calls === 1) { committedResolve(); return; } // Hold ACK; parent really kills the sender.
    response.end(JSON.stringify({ status: 'duplicate', sourceEventId: request.headers['x-jrc-origin-event-id'], durablyAccepted: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/webhooks/whatsapp/${current.destinationId}`;
    const process = child({ mode: 'dispatch', binding: current, endpoint });
    await Promise.race([committed, sleep(5000).then(() => { throw new Error('RECIPIENT_COMMIT_NOT_OBSERVED'); })]);
    await kill(process);
    assert.equal(await store.claim(current), null);
    await awaitLeaseExpiry(accepted.id);
    const deliver = createOriginHttpTransport({ endpoint, binding: current, bearerToken: 'synthetic-test-only', allowInsecureLoopbackForTests: true });
    const dispatcher = createOriginDispatcher({ env, journal: store, resolveBinding: async () => current, deliver });
    assert.equal((await dispatcher.runOnce(current)).kind, 'DELIVERED');
    assert.equal(calls, 2);
    assert.equal((await pool.query('SELECT sum(effect_count)::int AS n FROM jrc_evolution_origin.synthetic_crash_receiver WHERE event_id=$1', [accepted.id])).rows[0].n, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
