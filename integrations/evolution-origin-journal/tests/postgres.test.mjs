import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createOriginJournal, installOriginJournal } from '../src/journal.mjs';
import { createOriginDispatcher } from '../src/dispatcher.mjs';
import { createOriginCaptureHook } from '../src/hook.mjs';
import { projectTextBatch } from '../src/projection.mjs';
import { binding as template, source } from './fixtures.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

let admin, pool, journal, ownDatabase, connectionString, createdDatabase = false;
const key = randomBytes(32);
const env = { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' };
const binding = () => ({ ...template, destinationId: `synthetic-${randomUUID()}` });
const facts = value => projectTextBatch(value, source());
const create = (target = pool) => createOriginJournal({ pool: target, encryptionKey: key });
const ready = async id => pool.query("UPDATE jrc_evolution_origin.events SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
const inspect = async id => (await pool.query('SELECT * FROM jrc_evolution_origin.events WHERE id=$1', [id])).rows[0];
const dispatcher = (deliver, current, options = {}) => createOriginDispatcher({ env, journal, deliver, resolveBinding: async () => current, ...options });

before(async () => {
  const raw = process.env.TEST_DATABASE_ADMIN_URL;
  const url = validateTestAdminUrl(raw);
  ownDatabase = `jrc_test_origin_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: raw, max: 1 });
  await admin.query(`CREATE DATABASE "${ownDatabase}"`);
  createdDatabase = true;
  url.pathname = `/${ownDatabase}`;
  connectionString = url.toString();
  pool = new Pool({ connectionString, max: 4 });
  assert.equal((await pool.query('SHOW fsync')).rows[0].fsync, 'on', 'Lab fsync must be enabled');
  assert.equal((await pool.query('SHOW full_page_writes')).rows[0].full_page_writes, 'on', 'Lab full_page_writes must be enabled');
  assert.equal((await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'on', 'Lab receiver commits must be synchronous');
  await installOriginJournal(pool);
  journal = create();
});

after(async () => {
  await pool?.end();
  try {
    if (createdDatabase && admin && ownDatabase && /^jrc_test_origin_[a-f0-9]{32}$/u.test(ownDatabase)) {
      await admin.query(`DROP DATABASE IF EXISTS "${ownDatabase}"`);
    }
  } finally { await admin?.end(); }
});

test('PG: capture commits one encrypted event and its obligation before returning to the caller', async () => {
  const current = binding();
  const hook = createOriginCaptureHook({ env, journal, binding: current });
  assert.deepEqual(await hook.capture(source()), { captured: 1, enabled: true });
  const rows = (await pool.query('SELECT * FROM jrc_evolution_origin.events')).rows;
  const row = rows.find(value => value.state === 'PENDING');
  assert.ok(row);
  assert.equal(row.payload_ciphertext.includes(Buffer.from('Synthetic text')), false);
  assert.equal(row.payload_ciphertext.includes(Buffer.from('must-not-survive')), false);
  assert.equal(row.attempt_count, 0);
  const claim = await journal.claim(current);
  assert.equal(claim.body.data.message.conversation, 'Synthetic text');
  assert.equal(JSON.stringify(claim.body).includes('must-not-survive'), false);
});

test('PG: stable identity deduplicates and same-key different-content rolls back the entire batch', async () => {
  const current = binding(), first = facts(current);
  const [accepted] = await journal.acceptBatch(current, first);
  assert.equal((await journal.acceptBatch(current, first))[0].id, accepted.id);
  const changed = structuredClone(first[0]); changed.data.message.conversation = 'Conflicting synthetic text';
  const novel = projectTextBatch(current, source('new-before-conflict'))[0];
  await assert.rejects(journal.acceptBatch(current, [novel, changed]), /ORIGIN_EVENT_CONFLICT/);
  const count = await pool.query('SELECT count(*)::int AS n FROM jrc_evolution_origin.events WHERE scope_key=$1', [accepted.scopeKey]);
  assert.equal(count.rows[0].n, 1);
  const unsafe = { ...first[0], creds: 'must-not-survive' };
  await assert.rejects(journal.acceptBatch(current, [unsafe]), /ORIGIN_TEXT_INVALID/);
});

test('PG: concurrent workers cannot claim two live deliveries in the same source scope', async () => {
  const current = binding();
  await journal.acceptBatch(current, [...facts(current), ...projectTextBatch(current, source('second-fact'))]);
  const claims = await Promise.all([journal.claim(current), journal.claim(current)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean);
  assert.equal(await journal.finish(claim, { type: 'DELIVERED', category: 'DURABLE_ACCEPTED', httpStatus: 200, durationMs: 1 }), true);
  assert.ok(await journal.claim(current));
});

test('PG: expired leases are reclaimable and stale claims cannot settle a replacement', async () => {
  const current = binding();
  await journal.acceptBatch(current, facts(current));
  const old = await journal.claim(current);
  await pool.query("UPDATE jrc_evolution_origin.events SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
  const fresh = await journal.claim(current);
  assert.notEqual(fresh.leaseToken, old.leaseToken);
  assert.equal(fresh.attempt, 2);
  assert.equal(await journal.finish(old, { type: 'DELIVERED', category: 'DURABLE_ACCEPTED', httpStatus: 200, durationMs: 1 }), false);
  assert.equal(await journal.finish(fresh, { type: 'DELIVERED', category: 'DURABLE_ACCEPTED', httpStatus: 200, durationMs: 1 }), true);
});

test('PG: lost ACK after receiver commit retries the same event and creates one logical effect', async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS jrc_evolution_origin.synthetic_receiver(event_id uuid PRIMARY KEY, effect_count integer NOT NULL DEFAULT 1)');
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  let calls = 0;
  const ids = [];
  const worker = dispatcher(async delivery => {
    calls++; ids.push(delivery.id);
    const receiver = await pool.connect();
    try {
      await receiver.query('BEGIN');
      await receiver.query('SET LOCAL synchronous_commit=on');
      await receiver.query('INSERT INTO jrc_evolution_origin.synthetic_receiver(event_id) VALUES($1) ON CONFLICT DO NOTHING', [delivery.id]);
      await receiver.query('COMMIT');
    } catch (error) { await receiver.query('ROLLBACK'); throw error; }
    finally { receiver.release(); }
    if (calls === 1) throw new Error('synthetic lost ACK with sensitive text that must not be persisted');
    return { status: 200, sourceEventId: delivery.id, durablyAccepted: true };
  }, current);
  assert.equal((await worker.runOnce(current)).kind, 'RETRY');
  assert.equal((await inspect(accepted.id)).state, 'PENDING');
  await ready(accepted.id);
  assert.equal((await worker.runOnce(current)).kind, 'DELIVERED');
  assert.deepEqual(ids, [accepted.id, accepted.id]);
  assert.equal((await pool.query('SELECT sum(effect_count)::int AS n FROM jrc_evolution_origin.synthetic_receiver WHERE event_id=$1', [accepted.id])).rows[0].n, 1);
  const attempts = (await pool.query('SELECT category FROM jrc_evolution_origin.attempts WHERE event_id=$1 ORDER BY number', [accepted.id])).rows;
  assert.deepEqual(attempts.map(row => row.category), ['DELIVERY_UNCERTAIN', 'DURABLE_ACCEPTED']);
});

test('PG: 200 without exact durable receipt remains uncertain and a terminal 4xx is retained blocked', async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  assert.equal((await dispatcher(async () => ({ status: 200 }), current).runOnce(current)).kind, 'RETRY');
  assert.equal((await inspect(accepted.id)).last_category, 'RECEIPT_UNCONFIRMED');
  await ready(accepted.id);
  assert.equal((await dispatcher(async () => ({ status: 403 }), current).runOnce(current)).kind, 'BLOCKED');
  const blocked = await inspect(accepted.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.payload_ciphertext.length > 0, true);
  assert.equal(await journal.claim(current), null);
});

test('PG: bounded Retry-After persists scheduling and retries stop with a retained terminal record', async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  const worker = dispatcher(async () => ({ status: 429, retryAfterMs: 5000 }), current, { maxAttempts: 2, maxRetryMs: 10000 });
  assert.equal((await worker.runOnce(current)).kind, 'RETRY');
  const remaining = (await pool.query('SELECT extract(epoch FROM next_attempt_at-clock_timestamp())*1000 AS ms FROM jrc_evolution_origin.events WHERE id=$1', [accepted.id])).rows[0].ms;
  assert.ok(Number(remaining) > 4000 && Number(remaining) <= 5000);
  await ready(accepted.id);
  assert.equal((await worker.runOnce(current)).kind, 'BLOCKED');
  assert.equal((await inspect(accepted.id)).last_category, 'RETRY_EXHAUSTED');
});

test('PG: binding changes prevent delivery and are rechecked after an external outcome', async () => {
  const current = binding(); await journal.acceptBatch(current, facts(current));
  let sent = false;
  const changed = { ...current, revision: 2 };
  assert.equal((await dispatcher(async () => { sent = true; }, changed).runOnce(current)).kind, 'BLOCKED');
  assert.equal(sent, false);
  const other = binding(); await journal.acceptBatch(other, facts(other));
  let reads = 0;
  const worker = createOriginDispatcher({ env, journal, resolveBinding: async () => ++reads === 1 ? other : { ...other, revision: 2 }, deliver: async delivery => ({ status: 200, sourceEventId: delivery.id, durablyAccepted: true }) });
  assert.equal((await worker.runOnce(other)).kind, 'BLOCKED');
});

test('PG: pending obligations survive a fresh connection pool and adapter instance', async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  await pool.end();
  pool = new Pool({ connectionString, max: 4 });
  journal = create();
  const claim = await journal.claim(current);
  assert.equal(claim.id, accepted.id);
  assert.equal(claim.body.data.message.conversation, 'Synthetic text');
});

test('PG: strict opt-in dispatcher does not claim or call delivery while disabled', async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  const worker = createOriginDispatcher({ env: {}, journal, deliver: async () => { throw new Error('must not call'); }, resolveBinding: async () => current });
  assert.deepEqual(await worker.runOnce(current), { kind: 'DISABLED' });
  assert.equal((await inspect(accepted.id)).attempt_count, 0);
});

test('PG: source and receipt-defining transactions force synchronous_commit despite an async caller session', async () => {
  await pool.query(`CREATE OR REPLACE FUNCTION jrc_evolution_origin.require_sync_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('synchronous_commit') <> 'on' THEN RAISE EXCEPTION 'ORIGIN_SYNC_REQUIRED'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER origin_test_require_sync BEFORE INSERT OR UPDATE ON jrc_evolution_origin.events FOR EACH ROW EXECUTE FUNCTION jrc_evolution_origin.require_sync_commit()');
  const asynchronousPool = new Pool({ connectionString, max: 1, options: '-c synchronous_commit=off' });
  try {
    assert.equal((await asynchronousPool.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'off');
    const store = create(asynchronousPool), current = binding();
    await store.acceptBatch(current, facts(current));
    const claim = await store.claim(current);
    assert.equal(await store.finish(claim, { type: 'DELIVERED', category: 'DURABLE_ACCEPTED', httpStatus: 200, durationMs: 0 }), true);
    assert.equal((await asynchronousPool.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'off');
  } finally {
    await asynchronousPool.end();
    await pool.query('DROP TRIGGER origin_test_require_sync ON jrc_evolution_origin.events');
  }
});

test('PG: crash/reclaim attempts cannot exceed the delivery budget before a new external call', async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  for (let attempt = 0; attempt < 2; attempt++) {
    await journal.claim(current);
    await pool.query("UPDATE jrc_evolution_origin.events SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.id]);
  }
  let calls = 0;
  const worker = dispatcher(async delivery => { calls++; return { status: 200, sourceEventId: delivery.id, durablyAccepted: true }; }, current, { maxAttempts: 2 });
  assert.equal((await worker.runOnce(current)).kind, 'BLOCKED');
  assert.equal(calls, 0);
  assert.equal((await inspect(accepted.id)).last_category, 'RETRY_EXHAUSTED');
});

for (const stage of ['pre', 'post', 'delivery']) test(`PG: total dispatch deadline bounds a never-resolving ${stage} port and retains the event`, { timeout: 2000 }, async () => {
  const current = binding(), [accepted] = await journal.acceptBatch(current, facts(current));
  let reads = 0, capturedSignal;
  const worker = createOriginDispatcher({ env, journal, timeoutMs: 30,
    resolveBinding: async (_binding, options) => {
      reads++; capturedSignal = options?.signal;
      if ((stage === 'pre' && reads === 1) || (stage === 'post' && reads === 2)) return new Promise(() => {});
      return current;
    },
    deliver: async delivery => {
      if (stage === 'delivery') { capturedSignal = delivery.signal; return new Promise(() => {}); }
      return { status: 200, sourceEventId: delivery.id, durablyAccepted: true };
    },
  });
  assert.equal((await worker.runOnce(current)).kind, 'RETRY');
  assert.equal(capturedSignal?.aborted, true);
  assert.equal((await inspect(accepted.id)).state, 'PENDING');
  assert.equal((await inspect(accepted.id)).last_category, 'DELIVERY_UNCERTAIN');
});

test('PG: a resolver completing after the total deadline cannot start a late external delivery', async () => {
  const current = binding(); await journal.acceptBatch(current, facts(current));
  let resolveAuthority, calls = 0;
  const authority = new Promise(resolve => { resolveAuthority = resolve; });
  const worker = createOriginDispatcher({ env, journal, timeoutMs: 30, resolveBinding: async () => authority, deliver: async () => { calls++; } });
  assert.equal((await worker.runOnce(current)).kind, 'RETRY');
  resolveAuthority(current);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});
