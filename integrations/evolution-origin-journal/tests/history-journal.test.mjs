import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createOriginJournal, installOriginJournal } from '../src/journal.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';
import { projectHistoryBatch } from '../src/history-projection.mjs';

const key = Buffer.alloc(32, 93), now = new Date('2026-11-11T12:00:00Z');
const binding = () => ({ organizationId: randomUUID(), channelId: randomUUID(), instanceId: randomUUID(), engineId: 'synthetic-engine',
  engineGeneration: 1, sessionGeneration: randomUUID(), bindingFingerprint: 'a'.repeat(64),
  identityScopeId: null, historyAccountIdentity: null, ownerFingerprint: null });
const source = () => ({ 'messaging-history.set': { isLatest: true, progress: 100, messages: [{
  key: { id: 'synthetic-journal-history', remoteJid: `${'1'.repeat(11)}@s.whatsapp.net`, fromMe: false },
  messageTimestamp: 1600000000, message: { conversation: 'Synthetic historical private text', secret: 'must-not-survive' },
}], chats: [], contacts: [] } });
const context = () => ({ captureId: randomUUID(), capturedAt: now, provenance: 'SOCKET', startOrdinal: 0 });
let admin, pool, database, connectionString;
const journal = (target = pool, maxBytes = 2000000) => createOriginJournal({ pool: target, encryptionKey: key, history: { maxStagedBytes: maxBytes } }).history;

before(async () => {
  const url = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL);
  database = `jrc_test_history_origin_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url.href, max: 1 });
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = `/${database}`;
  connectionString = url.href;
  pool = new Pool({ connectionString: url.href, max: 4 });
  await installOriginJournal(pool);
});
after(async () => {
  await pool?.end();
  try { if (admin && database) await admin.query(`DROP DATABASE "${database}"`); }
  finally { await admin?.end(); }
});

test('source journal seals the snapshot immediately and persists only private canonical pages before returning a staging receipt', async () => {
  const scope = binding(), run = randomUUID(), input = source(), store = journal(), capture = context();
  const token = store.prepare(scope, run, input, capture);
  input['messaging-history.set'].messages[0].message.conversation = 'Changed after capture';
  assert.deepEqual(Object.keys(token), []);
  const receipt = await store.append(token);
  assert.deepEqual(receipt, { kind: 'STAGED', captureId: capture.captureId, chunks: 1 });
  const row = (await pool.query('SELECT payload_ciphertext FROM jrc_evolution_origin.history_chunks WHERE run_id=$1', [run])).rows[0];
  assert.equal(row.payload_ciphertext.includes(Buffer.from('Synthetic historical private text')), false);
  assert.equal(row.payload_ciphertext.includes(Buffer.from('must-not-survive')), false);
  const [pending] = await journal().pending(scope);
  assert.equal(pending.chunk.records[0].content.text, 'Synthetic historical private text');
  assert.doesNotMatch(JSON.stringify(pending), /must-not-survive|Changed after capture/u);
});

test('does not return staging acknowledgement or expose pending pages before the actual COMMIT', async () => {
  let reached, release;
  const beforeCommit = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const paused = { async connect() { const client = await pool.connect(); return {
    async query(sql, params) { if (sql === 'COMMIT') { reached(); await gate; } return client.query(sql, params); }, release: () => client.release(),
  }; } };
  const scope = binding(), store = journal(paused); let acknowledged = false;
  const writing = store.append(store.prepare(scope, randomUUID(), source(), context())).then(value => { acknowledged = true; return value; });
  try { await beforeCommit; assert.equal(acknowledged, false); assert.deepEqual(await journal().pending(scope), []); }
  finally { release(); }
  assert.equal((await writing).kind, 'STAGED');
  assert.equal((await journal().pending(scope)).length, 1);
});

test('deduplicates an admitted batch after source restart and rejects conflicting content for its capture identity', async () => {
  const scope = binding(), run = randomUUID(), capture = context(), store = journal();
  const first = await store.append(store.prepare(scope, run, source(), capture));
  const restarted = journal();
  assert.deepEqual(await restarted.append(restarted.prepare(scope, run, source(), capture)), first);
  const changed = source(); changed['messaging-history.set'].messages[0].message.conversation = 'Different text';
  await assert.rejects(restarted.append(restarted.prepare(scope, run, changed, capture)), /HISTORY_SOURCE_CAPTURE_CONFLICT/u);
  assert.equal((await restarted.pending(scope)).length, 1);
});

test('requires a correlated durable Broker receipt; HTTP acceptance alone cannot settle a source obligation', async () => {
  const scope = binding(), run = randomUUID(), store = journal();
  await store.append(store.prepare(scope, run, source(), context()));
  const [pending] = await store.pending(scope);
  assert.equal(await store.acknowledge(scope, pending, { status: 200 }), false);
  const receipt = { protocol: 'jrc-history-source/2', kind: 'STAGED', durablyAccepted: true, runId: run,
    scopeKey: pending.scopeKey, chunkId: pending.chunk.chunkId, checksum: pending.chunk.checksum,payloadHash:pending.payloadHash };
  assert.equal(await store.acknowledge(scope, pending, { ...receipt, checksum: 'b'.repeat(64) }), false);
  assert.equal(await store.acknowledge(scope, pending, receipt), true);
  assert.deepEqual(await store.pending(scope), []);
  assert.equal((await pool.query('SELECT count(*) FROM jrc_evolution_origin.history_chunks WHERE run_id=$1', [run])).rows[0].count, '1');
});

test('isolates sessions and tenants and fails explicitly at its bounded source quota', async () => {
  const scope = binding(), store = journal();
  await store.append(store.prepare(scope, randomUUID(), source(), context()));
  assert.deepEqual(await store.pending({ ...scope, sessionGeneration: randomUUID() }), []);
  assert.deepEqual(await store.pending({ ...scope, organizationId: randomUUID() }), []);
  assert.throws(() => journal(pool, 100).prepare(scope, randomUUID(), source(), context()), /HISTORY_SOURCE_QUOTA/u);
});

test('recovers an actual killed source process after COMMIT before ACK and does not duplicate its pages', async () => {
  const scope = binding(), run = randomUUID(), capture = context(), events = source();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./history-crash-child.mjs', import.meta.url))], {
    env: { ...process.env, HISTORY_SOURCE_CRASH_DATABASE: connectionString,
      HISTORY_SOURCE_CRASH_FIXTURE: JSON.stringify({ scope, run, events, context: capture }) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('source commit timeout')), 10000);
      child.stdout.on('data', data => { if (String(data).includes('COMMITTED')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(Error(`source exited before commit: ${code}`)); });
    });
  } finally {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await stopped; }
  }
  const restarted = journal();
  const [pending] = await restarted.pending(scope);
  assert.equal(pending.runId, run);
  assert.equal(pending.chunk.records[0].content.text, 'Synthetic historical private text');
  await restarted.append(restarted.prepare(scope, run, events, capture));
  assert.equal((await restarted.pending(scope)).length, 1);
});

test('allocates page ordering transactionally for concurrent socket batches and resumes it after restart', async () => {
  const scope = binding(), run = randomUUID(), store = journal();
  const first = source(), second = source();
  second['messaging-history.set'].messages[0].key.id = 'synthetic-second-batch';
  const captures = [context(), context()];
  await Promise.all([store.append(store.prepare(scope, run, first, captures[0])), store.append(store.prepare(scope, run, second, captures[1]))]);
  const restarted = journal(), rows = await restarted.pending(scope, { limit: 10 });
  assert.deepEqual(rows.map(row => row.chunk.ordinal), [0, 1]);
  const third = source(); third['messaging-history.set'].messages[0].key.id = 'synthetic-third-batch';
  await restarted.append(restarted.prepare(scope, run, third, context()));
  assert.deepEqual((await restarted.pending(scope, { limit: 10 })).map(row => row.chunk.ordinal), [0, 1, 2]);
  await restarted.append(restarted.prepare(scope, run, second, captures[1]));
  assert.equal((await restarted.pending(scope, { limit: 10 })).length, 3);
});

test('counts final ordered envelope bytes against quota and rolls back an over-budget capture', async () => {
  const scope = binding(), run = randomUUID(), store = journal();
  for (let i = 0; i < 10; i++) await store.append(store.prepare(scope,run,source(),context()));
  const usage = Number((await pool.query('SELECT sum(payload_bytes) AS bytes FROM jrc_evolution_origin.history_chunks WHERE run_id=$1',[run])).rows[0].bytes);
  const input = source(), capture = context();
  const originalBytes = Buffer.byteLength(JSON.stringify([...projectHistoryBatch(scope,input,capture)][0]));
  const tight = journal(pool,usage+originalBytes);
  await assert.rejects(tight.append(tight.prepare(scope,run,input,capture)), /HISTORY_SOURCE_QUOTA/u);
  assert.equal((await store.pending(scope,{limit:100})).length,10);
});

test('cannot settle an original source obligation with changed ordinal or completion metadata',async()=>{
  const scope=binding(),run=randomUUID(),store=journal();
  await store.append(store.prepare(scope,run,source(),context()));
  const [pending]=await store.pending(scope), changed={...pending,chunk:{...pending.chunk,ordinal:99,isLast:!pending.chunk.isLast}};
  const receipt={protocol:'jrc-history-source/2',kind:'STAGED',durablyAccepted:true,runId:run,scopeKey:pending.scopeKey,
    chunkId:pending.chunk.chunkId,checksum:pending.chunk.checksum,payloadHash:pending.payloadHash};
  assert.equal(await store.acknowledge(scope,changed,receipt),false);
  assert.equal((await store.pending(scope)).length,1);
});

test('keeps capture ordering across owner confirmation without restarting ordinal zero',async()=>{
  const scope=binding(),run=randomUUID(),store=journal();
  await store.append(store.prepare(scope,run,source(),context()));
  const confirmed={...scope,historyAccountIdentity:randomUUID(),identityScopeId:randomUUID(),ownerFingerprint:'b'.repeat(64)};
  await store.append(store.prepare(confirmed,run,source(),context()));
  assert.deepEqual((await store.pending(confirmed,{limit:10})).map(row=>row.chunk.ordinal),[0,1]);
});

test('snapshots a validated receipt before BEGIN so caller mutation cannot acknowledge a different obligation',async()=>{
  const scope=binding(),run=randomUUID(),store=journal();
  await store.append(store.prepare(scope,run,source(),context()));
  await store.append(store.prepare(scope,run,source(),context()));
  const [first,second]=await store.pending(scope,{limit:10});
  const receipt={protocol:'jrc-history-source/2',kind:'STAGED',durablyAccepted:true,runId:run,scopeKey:first.scopeKey,
    chunkId:first.chunk.chunkId,checksum:first.chunk.checksum,payloadHash:first.payloadHash};
  const changing={async connect(){const client=await pool.connect();return{
    query(sql,params){if(sql==='BEGIN')Object.assign(receipt,{chunkId:second.chunk.chunkId,payloadHash:second.payloadHash});return client.query(sql,params);},
    release:()=>client.release(),
  };}};
  assert.equal(await journal(changing).acknowledge(scope,first,receipt),true);
  assert.equal((await store.pending(scope))[0].chunk.chunkId,second.chunk.chunkId);
});

test('bounds the total encrypted snapshots waiting for PostgreSQL rather than only each individual event',async()=>{
  const scope=binding(),run=randomUUID(),input=source(),capture=context();
  const budget=Buffer.byteLength(JSON.stringify([...projectHistoryBatch(scope,input,capture)][0]));
  const store=journal(pool,budget),token=store.prepare(scope,run,input,capture);
  assert.throws(()=>store.prepare(scope,run,input,context()),/HISTORY_SOURCE_QUOTA/u);
  await store.append(token);
  const [pending]=await store.pending(scope);
  await store.acknowledge(scope,pending,{protocol:'jrc-history-source/2',kind:'STAGED',durablyAccepted:true,runId:run,
    scopeKey:pending.scopeKey,chunkId:pending.chunk.chunkId,checksum:pending.chunk.checksum,payloadHash:pending.payloadHash});
  const next=store.prepare(scope,run,input,context());
  assert.equal((await store.append(next)).kind,'STAGED');
  assert.equal((await store.append(token)).kind,'STAGED');
});

test('retains a failed private append under backpressure and can retry it when PostgreSQL returns',async()=>{
  const scope=binding(),run=randomUUID(),input=source(),capture=context();
  const budget=Buffer.byteLength(JSON.stringify([...projectHistoryBatch(scope,input,capture)][0]));
  let unavailable=true;
  const flaky={connect:async()=>{if(unavailable)throw Error('SYNTHETIC_DATABASE_UNAVAILABLE');return pool.connect();},query:(...args)=>pool.query(...args)};
  const store=journal(flaky,budget);
  await assert.rejects(store.append(store.prepare(scope,run,input,capture)),/SYNTHETIC_DATABASE_UNAVAILABLE/u);
  assert.throws(()=>store.prepare(scope,run,input,context()),/HISTORY_SOURCE_QUOTA/u);
  unavailable=false;
  assert.deepEqual(await store.retryPrepared(),{staged:1});
  assert.equal((await store.pending(scope)).length,1);
  assert.deepEqual(await store.retryPrepared(),{staged:0});
});

test('a headless run reader cannot consume another admitted run from the same socket scope', async () => {
  const scope = binding(), first = randomUUID(), second = randomUUID(), store = journal();
  await store.append(store.prepare(scope, first, source(), context()));
  await store.append(store.prepare(scope, second, source(), context()));
  const pages = await store.pending(scope, { limit: 1, runId: second });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].runId, second);
  await assert.rejects(store.pending(scope, { limit: 1, runId: 'not-a-run' }), /HISTORY_SOURCE_CONTEXT_INVALID/u);
});
