// Explicit offline laboratory runner mounted read-only into the final image.
// Uses the image's real JRC modules/pg dependency and a fresh synthetic database;
// never imports dist/main, creates a WhatsApp socket, or approves production.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire('/evolution/package.json');
const { Pool } = require('pg');
const { createOriginJournal, installOriginJournal } = await import('/evolution/jrc-origin/journal.mjs');
const { withOriginEngineLabHost, attachOriginEngineInstance, awaitOriginEngineReady, captureOriginBatch, decideOriginWebhook } = await import('/evolution/jrc-origin/engine-host.mjs');
const source = id => ({ 'messages.upsert': { type: 'notify', messages: [{ key: { id, fromMe: false, remoteJid: `${'1'.repeat(11)}@s.whatsapp.net` },
  messageTimestamp: 1700000000, message: { conversation: 'Synthetic artifact custody text', contextInfo: { secret: 'EXCLUDED_SYNTHETIC_SECRET' } } }] },
  'creds.update': { privateKey: 'EXCLUDED_SYNTHETIC_SECRET' } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function connection(raw) {
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.match(url.hostname, /^jrc-engine-provisioned-[a-f0-9]{10}-pg$/u);
  assert.equal(url.pathname, '/jrc_engine_lab');
  assert.equal(process.env.NODE_ENV, 'test');
  return new Pool({ connectionString: url.href, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 });
}

if (process.argv[2] === 'child') {
  process.once('message', async config => {
    let pool;
    try {
      pool = connection(config.databaseUri);
      const realJournal = createOriginJournal({ pool, encryptionKey: Buffer.from(config.key, 'hex') });
      const journal = config.mode === 'source-before-dispatch' ? { ...realJournal, async acceptBatch(...args) {
        await realJournal.acceptBatch(...args);
        process.send({ phase: 'SOURCE_COMMITTED' });
        await new Promise(() => {});
      } } : realJournal;
      let legacyPasses = 0, guardDecisions = 0;
      await withOriginEngineLabHost({ labOnly: true, env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, prepareInstance: async () => ({
        pool, journal, binding: config.binding, encryptionKey: Buffer.from(config.key, 'hex'), resolveBinding: async () => config.binding,
        transport: { endpoint: config.endpoint, bearerToken: config.bearer, allowInsecureLoopbackForTests: true },
        dispatch: { timeoutMs: 2000 }, worker: { maxIterations: 1 },
      }) }, async () => {
        const instance = { instance: { id: config.binding.instanceId, name: config.binding.instanceName }, eventProcessingQueue: Promise.resolve() };
        attachOriginEngineInstance(config.binding, instance);
        const composition = await awaitOriginEngineReady(instance);
        assert.equal(composition.deliveryOwnership, 'UNPROVEN');
        if (config.mode !== 'replay') {
          const events = source(config.providerId);
          await captureOriginBatch(instance, events, () => {
            instance.eventProcessingQueue = instance.eventProcessingQueue.then(async () => {
              legacyPasses++;
              assert.equal(await decideOriginWebhook({ instanceName: config.binding.instanceName, event: 'messages.upsert',
                destination: config.endpoint, data: events['messages.upsert'].messages[0] }), 'SUPPRESS_OWNED');
              guardDecisions++;
            });
          });
          await instance.eventProcessingQueue;
          process.send({ phase: 'SOURCE_PROCESSED', legacyPasses, guardDecisions });
        }
        await composition.start(); await composition.stop();
        process.send({ phase: 'REPLAY_FINISHED', legacyPasses, guardDecisions });
      });
      await pool.end(); pool = undefined; process.disconnect();
    } catch (error) {
      await pool?.end().catch(() => {});
      process.send({ phase: 'CHILD_FAILED', code: /^ORIGIN_[A-Z_]+$/u.test(error.message) ? error.message : 'ARTIFACT_CHILD_FAILURE' }); process.exitCode = 1; process.disconnect();
    }
  });
} else {
  const pool = connection(process.env.DATABASE_CONNECTION_URI), children = new Set(), outputBytes = new Map();
  let server, releaseAck;
  const report = { artifactRuntime: '/evolution/jrc-origin', engineMainImported: false, syntheticSource: true,
    actualWhatsAppSession: false, productionOwnership: 'UNPROVEN', postgresTmpfs: true,
    crashBoundary: 'NODE_CHILD_SIGKILL_WITH_POSTGRES_ALIVE', postgresOrHostCrashTested: false, cases: [] };
  async function kill(child) {
    const exited = once(child, 'exit'), closed = once(child, 'close'); assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await exited, [null, 'SIGKILL']); await closed;
    assert.equal(outputBytes.get(child), 0, 'artifact child must not emit payload, configuration or raw errors'); children.delete(child);
  }
  try {
    report.phase = 'explicit-journal-install';
    const durability = (await pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AS ready")).rows[0].ready;
    assert.equal(durability, true);
    // Both schema changes are explicit gate actions after engine boot/stop; they
    // are not a side effect of the image entrypoint or an automatic host install.
    await installOriginJournal(pool);
    await pool.query('CREATE TABLE public.jrc_origin_lab_receiver(id uuid PRIMARY KEY, body_hash char(64) NOT NULL)');
    const binding = { instanceId: randomUUID(), instanceName: `synthetic-${randomUUID()}`, generation: 1, destinationId: randomUUID(), revision: 1 };
    const key = randomBytes(32), bearer = randomBytes(24).toString('hex');
    let hold = false, committed;
    server = createServer(async (request, response) => {
      try {
        assert.equal(request.url, `/v1/webhooks/whatsapp/${binding.destinationId}`);
        assert.equal(request.headers.authorization, `Bearer ${bearer}`);
        let bytes = Buffer.alloc(0);
        for await (const part of request) { bytes = Buffer.concat([bytes, part]); assert.ok(bytes.length < 65536); }
        const id = request.headers['x-jrc-origin-event-id'], contentHash = hash(bytes);
        assert.equal(request.headers['x-jrc-origin-content-sha256'], contentHash);
        assert.equal(bytes.includes(Buffer.from('EXCLUDED_SYNTHETIC_SECRET')), false);
        const client = await pool.connect(); let inserted;
        try {
          await client.query('BEGIN'); await client.query('SET LOCAL synchronous_commit=on');
          inserted = await client.query('INSERT INTO public.jrc_origin_lab_receiver(id,body_hash) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id', [id, contentHash]);
          assert.equal((await client.query('SELECT body_hash FROM public.jrc_origin_lab_receiver WHERE id=$1', [id])).rows[0].body_hash, contentHash);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        if (hold) { hold = false; committed(); await new Promise(resolve => { releaseAck = resolve; }); }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sourceEventId: id, durablyAccepted: true, status: inserted.rowCount ? 'accepted' : 'duplicate' }));
      } catch { response.writeHead(500); response.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/webhooks/whatsapp/${binding.destinationId}`;
    function start(mode, providerId) {
      const child = fork(new URL(import.meta.url), ['child'], { execArgv: ['--max-old-space-size=96'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.add(child);
      outputBytes.set(child, 0);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => outputBytes.set(child, outputBytes.get(child) + chunk.length));
      const messages = [], waiters = [];
      child.on('message', message => { messages.push(message); waiters.splice(0).forEach(resolve => resolve()); });
      child.send({ mode, providerId, databaseUri: process.env.DATABASE_CONNECTION_URI, key: key.toString('hex'), binding, endpoint, bearer });
      return { child, async phase(expected) {
        const deadline = Date.now() + 15000;
        while (!messages.some(message => message.phase === expected)) {
          assert.equal(messages.some(message => message.phase === 'CHILD_FAILED'), false, 'artifact child failed');
          assert.ok(Date.now() < deadline, 'artifact child phase deadline');
          await Promise.race([new Promise(resolve => waiters.push(resolve)), delay(50)]);
        }
        return messages.find(message => message.phase === expected);
      } };
    }
    for (const [index, boundary] of ['source-before-dispatch', 'recipient-before-ack'].entries()) {
      report.phase = boundary;
      const committedPromise = boundary === 'recipient-before-ack' ? new Promise(resolve => { hold = true; committed = resolve; }) : null;
      const running = start(boundary, `synthetic-${boundary}`);
      const observed = await running.phase(boundary === 'source-before-dispatch' ? 'SOURCE_COMMITTED' : 'SOURCE_PROCESSED');
      if (committedPromise) {
        assert.equal(observed.legacyPasses, 1); assert.equal(observed.guardDecisions, 1);
        let timer;
        try { await Promise.race([committedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('RECEIVER_COMMIT_TIMEOUT')), 15000); })]); }
        finally { clearTimeout(timer); }
      }
      await kill(running.child); releaseAck?.(); releaseAck = undefined;
      const row = (await pool.query("SELECT id,state,lease_until,payload_ciphertext FROM jrc_evolution_origin.events WHERE state <> 'DELIVERED' ORDER BY source_sequence LIMIT 1")).rows[0];
      assert.ok(row); assert.equal(row.payload_ciphertext.includes(Buffer.from('Synthetic artifact custody text')), false);
      assert.equal(row.state, boundary === 'source-before-dispatch' ? 'PENDING' : 'CLAIMED');
      if (row.lease_until) await delay(Math.max(0, new Date(row.lease_until).getTime() - Date.now()) + 50);
      const replay = start('replay', `synthetic-${boundary}`), exited = once(replay.child, 'exit'), closed = once(replay.child, 'close');
      const outcome = await replay.phase('REPLAY_FINISHED');
      assert.equal(outcome.legacyPasses, 0); assert.equal(outcome.guardDecisions, 0);
      assert.deepEqual(await exited, [0, null]); await closed;
      assert.equal(outputBytes.get(replay.child), 0); children.delete(replay.child);
      assert.equal((await pool.query('SELECT state FROM jrc_evolution_origin.events WHERE id=$1', [row.id])).rows[0].state, 'DELIVERED');
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public.jrc_origin_lab_receiver')).rows[0].n), index + 1);
      report.cases.push({ boundary, sigkillObserved: true, sameEventRecovered: true, receiverRows: index + 1, replayLegacyEffects: 0 });
    }
    report.journalEvents = Number((await pool.query('SELECT count(*) AS n FROM jrc_evolution_origin.events')).rows[0].n);
    assert.equal(report.journalEvents, 2);
    report.childOutputBytes = [...outputBytes.values()].reduce((total, bytes) => total + bytes, 0);
    report.gate = 'ARTIFACT_MODULES_CUSTODY_CRASH_VERIFIED';
  } catch (error) {
    report.failureCode = /^ORIGIN_[A-Z_]+$/u.test(error.message) ? error.message : 'ARTIFACT_CUSTODY_ASSERTION_OR_RUNTIME_FAILURE';
    report.gate = 'FAILED_OR_INCONCLUSIVE'; process.exitCode = 1;
  } finally {
    for (const child of children) await kill(child);
    releaseAck?.();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    await pool.end();
    console.log(JSON.stringify(report));
  }
}
