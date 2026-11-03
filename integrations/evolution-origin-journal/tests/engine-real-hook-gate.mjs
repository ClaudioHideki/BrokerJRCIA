// Explicit laboratory entrypoint, mounted read-only into the candidate image.
// Main/controller/handler/Prisma/fanout remain the image's actual compiled code.
// Only the absent WhatsApp socket is replaced by an offline event-emitter port.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { readBuildAdmission } from '/evolution/jrc-image/entrypoint.mjs';
import { fileHash, runtimeInventory } from '/evolution/jrc-image/artifacts.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire('/evolution/package.json');
function poolFor(raw) {
  const url = new URL(raw);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED, 'false');
  assert.equal(url.protocol, 'postgresql:');
  assert.match(url.hostname, /^jrc-engine-provisioned-[a-f0-9]{10}-pg$/u);
  assert.equal(url.pathname, '/jrc_engine_lab');
  const { Pool } = require('pg');
  return new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 });
}
async function until(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) { assert.ok(Date.now() < deadline, label); await delay(50); }
}
const emit = phase => process.send?.(phase);

if (process.argv[2] === 'child') {
  process.once('disconnect', () => process.exit(1));
  const timer = setTimeout(() => process.exit(1), 5000);
  process.once('message', async config => {
    clearTimeout(timer);
    let pool;
    try {
      const admitted = await readBuildAdmission('/evolution');
      assert.equal(admitted.receiptSha256, config.receiptSha256);
      assert.equal(admitted.receipt.sourceManifestSha256, config.sourceManifestSha256);
      assert.equal(admitted.receipt.artifacts.find(file => file.path === 'dist/main.js').sha256,
        await fileHash('/evolution/dist/main.js'));
      pool = poolFor(config.databaseUri);
      const { createOriginJournal } = await import('/evolution/jrc-origin/journal.mjs');
      const { withOriginEngineLabHost, awaitOriginEngineReady } = await import('/evolution/jrc-origin/engine-host.mjs');
      let actualInstance, binding;
      const realJournal = createOriginJournal({ pool, encryptionKey: Buffer.from(config.key, 'hex') });
      const journal = { ...realJournal, async acceptBatch(scope, bodies) {
        const accepted = await realJournal.acceptBatch(scope, bodies);
        if (bodies.some(body => body.data.key.id === config.crashProviderId)) {
          emit({ phase: 'SOURCE_COMMITTED_BEFORE_NATIVE_QUEUE', pid: process.pid });
          await new Promise(() => {});
        }
        return accepted;
      } };
      const directive = kind => new Promise(resolve => {
        const listener = message => { if (message?.directive === kind) { process.off('message', listener); resolve(); } };
        process.on('message', listener);
      });
      await withOriginEngineLabHost({ labOnly: true, env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' },
        prepareInstance: async (authority, instance) => {
          assert.equal(authority.instanceName, config.instanceName);
          if (config.instanceId) assert.equal(authority.instanceId, config.instanceId);
          assert.equal(actualInstance, undefined);
          actualInstance = instance;
          binding = { ...authority, generation: 1, revision: 1, destinationId: config.destinationId };
          return { pool, journal, binding, resolveBinding: async () => binding,
            transport: { endpoint: config.endpoint, bearerToken: config.bearer, allowInsecureLoopbackForTests: true },
            dispatch: { timeoutMs: 2000 }, worker: { maxIterations: 1 } };
        }
      }, async () => {
        await import('/evolution/dist/main.js');
        await until(async () => {
          try {
            const response = await fetch('http://127.0.0.1:8080/instance/fetchInstances',
              { headers: { apikey: process.env.AUTHENTICATION_API_KEY }, signal: AbortSignal.timeout(1000) });
            await response.body?.cancel();
            return response.status === 200;
          }
          catch { return false; }
        }, 60000, 'real main HTTP readiness deadline');
        if (config.mode === 'source') {
          const response = await fetch('http://127.0.0.1:8080/instance/create', {
            method: 'POST', headers: { 'content-type': 'application/json', apikey: process.env.AUTHENTICATION_API_KEY },
            body: JSON.stringify({ instanceName: config.instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: false,
              token: config.instanceToken, webhook: { enabled: true, url: config.endpoint, events: ['MESSAGES_UPSERT'], byEvents: false, base64: false } }),
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(response.status, 201);
          const body = await response.json();
          assert.equal(body.qrcode, undefined);
          assert.equal(body.instance.instanceId, binding?.instanceId);
          assert.equal(body.instance.status, 'close');
        }
        await until(() => !!actualInstance, 10000, 'actual closed instance was not constructed');
        const composition = await awaitOriginEngineReady(actualInstance);
        assert.equal(composition.deliveryOwnership, 'UNPROVEN');
        assert.equal(actualInstance.client, undefined, 'no WhatsApp socket may be created');
        emit({ phase: 'REAL_MAIN_INSTANCE_READY', instanceId: binding.instanceId, pid: process.pid });
        if (config.mode === 'source') {
          let callback;
          actualInstance.client = { ev: { process: handler => { callback = handler; } }, profilePictureUrl: async () => null };
          await actualInstance.loadWebhook();
          assert.equal(actualInstance.localWebhook.enabled, true);
          actualInstance.eventHandler();
          assert.equal(typeof callback, 'function');
          const source = providerId => ({ 'messages.upsert': { type: 'notify', messages: [{
            key: { id: providerId, fromMe: false, remoteJid: `${'1'.repeat(11)}@s.whatsapp.net` },
            pushName: 'Synthetic gate', messageTimestamp: 1700000000,
            message: { conversation: 'Synthetic real main hook text' },
          }] } });
          await callback(source(config.normalProviderId));
          await actualInstance.eventProcessingQueue;
          emit({ phase: 'NATIVE_QUEUE_FINISHED' });
          await directive('DELIVER');
          await composition.start(); await composition.stop();
          emit({ phase: 'NORMAL_DELIVERED' });
          await directive('CRASH');
          await callback(source(config.crashProviderId));
          throw Error('crash barrier returned');
        } else {
          await directive('DELIVER');
          await composition.start(); await composition.stop();
          emit({ phase: 'RECOVERED_WITH_REAL_MAIN' });
          await new Promise(() => {});
        }
      });
    } catch {
      emit({ phase: 'CHILD_FAILED' });
      await pool?.end().catch(() => {});
      process.exit(1);
    }
  });
} else {
  const report = { sourceMainImported: false, recoveryMainImported: false, productionCapture: false,
    productionOwnership: 'UNPROVEN', actualWhatsAppSession: false, syntheticSocketPort: true,
    nativeHandlerReplaced: false, postgresOrHostCrashTested: false, phase: 'integrity' };
  const children = new Set();
  let pool, server;
  const outputs = new Map();
  async function terminate(child, signal, expected) {
    report.terminationObservations ??= [];
    if (child.exitCode !== null || child.signalCode !== null) {
      report.terminationObservations.push({ pid: child.pid, requestedSignal: signal, alreadyExited: true,
        exitCode: child.exitCode, signalCode: child.signalCode });
      children.delete(child);
      if (expected) {
        assert.deepEqual([child.exitCode, child.signalCode], expected, 'child had already exited before the requested signal');
        assert.fail('proof child exited before the controlled signal');
      }
      return;
    }
    const exited = once(child, 'exit'), closed = once(child, 'close');
    assert.equal(child.kill(signal), true);
    let timeout;
    try {
      const result = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('child stop deadline')), 10000); })]);
      report.terminationObservations.push({ pid: child.pid, requestedSignal: signal, alreadyExited: false,
        exitCode: result[0], signalCode: result[1] });
      if (expected) assert.deepEqual(result, expected);
      await closed;
    } catch (error) {
      child.kill('SIGKILL');
      await Promise.race([closed, delay(5000)]);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (child.exitCode !== null || child.signalCode !== null) children.delete(child);
    }
  }
  try {
    const { receipt, receiptSha256 } = await readBuildAdmission('/evolution');
    const began = performance.now(), actual = await runtimeInventory('/evolution');
    assert.deepEqual(actual, receipt.artifacts);
    report.inventoryCount = actual.length; report.inventoryMs = Math.round(performance.now() - began);
    pool = poolFor(process.env.DATABASE_CONNECTION_URI);
    assert.equal((await pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AS ready")).rows[0].ready, true);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public."Instance"')).rows[0].n), 0);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public."Session"')).rows[0].n), 0);
    const { installOriginJournal } = await import('/evolution/jrc-origin/journal.mjs');
    await installOriginJournal(pool);
    await pool.query('CREATE TABLE public.jrc_real_hook_receiver(id uuid PRIMARY KEY, body_hash char(64) NOT NULL)');
    const config = { receiptSha256, sourceManifestSha256: receipt.sourceManifestSha256,
      databaseUri: process.env.DATABASE_CONNECTION_URI, key: randomBytes(32).toString('hex'), bearer: randomBytes(24).toString('hex'),
      instanceToken: randomBytes(24).toString('hex'), destinationId: randomUUID(), instanceName: `synthetic-hook-${randomUUID()}`,
      normalProviderId: `synthetic-normal-${randomUUID()}`, crashProviderId: `synthetic-crash-${randomUUID()}` };
    let legacyRequests = 0, ownedRequests = 0;
    server = createServer(async (request, response) => {
      try {
        let bytes = Buffer.alloc(0);
        for await (const part of request) { bytes = Buffer.concat([bytes, part]); assert.ok(bytes.length < 65536); }
        if (request.url === '/legacy') { legacyRequests++; response.writeHead(200); response.end('{}'); return; }
        assert.equal(request.url, `/v1/webhooks/whatsapp/${config.destinationId}`);
        ownedRequests++;
        assert.equal(request.headers.authorization, `Bearer ${config.bearer}`);
        const id = request.headers['x-jrc-origin-event-id'], bodyHash = sha(bytes);
        assert.equal(request.headers['x-jrc-origin-content-sha256'], bodyHash);
        const client = await pool.connect(); let inserted;
        try {
          await client.query('BEGIN'); await client.query('SET LOCAL synchronous_commit=on');
          inserted = await client.query('INSERT INTO public.jrc_real_hook_receiver(id,body_hash) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id', [id, bodyHash]);
          assert.equal((await client.query('SELECT body_hash FROM public.jrc_real_hook_receiver WHERE id=$1', [id])).rows[0].body_hash, bodyHash);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sourceEventId: id, durablyAccepted: true, status: inserted.rowCount ? 'accepted' : 'duplicate' }));
      } catch { response.writeHead(500); response.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    config.endpoint = `http://127.0.0.1:${server.address().port}/v1/webhooks/whatsapp/${config.destinationId}`;
    function start(mode) {
      const child = fork(new URL(import.meta.url), ['child'], { execArgv: ['--max-old-space-size=256'],
        env: { ...process.env, DATABASE_SAVE_DATA_NEW_MESSAGE: 'true', WEBHOOK_GLOBAL_ENABLED: 'true',
          WEBHOOK_GLOBAL_URL: `http://127.0.0.1:${server.address().port}/legacy`, WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS: 'false',
          WEBHOOK_EVENTS_MESSAGES_UPSERT: 'true', LOG_LEVEL: 'ERROR,WARN' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.add(child); outputs.set(child, '');
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
        const next = outputs.get(child) + bytes.toString('utf8');
        if (next.length > 2 * 1024 * 1024) { report.outputLimitExceeded = true; child.kill('SIGKILL'); return; }
        outputs.set(child, next);
      });
      const messages = [];
      child.on('message', message => messages.push(message));
      child.send({ ...config, mode });
      return { child, async phase(name) {
        await until(() => {
          assert.equal(messages.some(message => message.phase === 'CHILD_FAILED'), false, `child failed during ${name}`);
          assert.equal(child.exitCode, null, `child exited during ${name}`);
          return messages.some(message => message.phase === name);
        }, 90000, `child phase deadline ${name}`);
        return messages.find(message => message.phase === name);
      } };
    }
    report.phase = 'actual-api-create-and-handler';
    const source = start('source');
    const ready = await source.phase('REAL_MAIN_INSTANCE_READY');
    report.sourceMainImported = true;
    config.instanceId = ready.instanceId; report.sourcePid = ready.pid;
    await source.phase('NATIVE_QUEUE_FINISHED');
    await until(() => legacyRequests === 1, 10000, 'unowned actual fanout must finish');
    assert.equal(ownedRequests, 0, 'owned legacy HTTP must be suppressed before dispatcher starts');
    const countNative = async () => Number((await pool.query('SELECT count(*) AS n FROM public."Message" WHERE "instanceId"=$1', [config.instanceId])).rows[0].n);
    assert.equal(await countNative(), 1);
    const scopeKey = sha(JSON.stringify([config.instanceId, 1, config.destinationId, 1]));
    const journalRows = async () => (await pool.query('SELECT id,state,payload_ciphertext FROM jrc_evolution_origin.events WHERE scope_key=$1 ORDER BY source_sequence', [scopeKey])).rows;
    assert.deepEqual((await journalRows()).map(row => row.state), ['PENDING']);
    source.child.send({ directive: 'DELIVER' });
    await source.phase('NORMAL_DELIVERED');
    assert.deepEqual((await journalRows()).map(row => row.state), ['DELIVERED']);
    assert.equal(ownedRequests, 1);
    report.phase = 'real-source-crash-before-native-queue';
    source.child.send({ directive: 'CRASH' });
    await source.phase('SOURCE_COMMITTED_BEFORE_NATIVE_QUEUE');
    await terminate(source.child, 'SIGKILL', [null, 'SIGKILL']);
    const crashed = await journalRows();
    assert.deepEqual(crashed.map(row => row.state), ['DELIVERED', 'PENDING']);
    assert.ok(crashed.every(row => !row.payload_ciphertext.includes(Buffer.from('Synthetic real main hook text'))));
    assert.equal(await countNative(), 1);
    report.sourceExitSignal = 'SIGKILL';
    report.phase = 'restart-real-main-closed-instance';
    const recovered = start('recovery');
    const second = await recovered.phase('REAL_MAIN_INSTANCE_READY');
    report.recoveryMainImported = true;
    report.recoveryPid = second.pid;
    assert.notEqual(second.pid, ready.pid);
    assert.equal(second.instanceId, ready.instanceId);
    recovered.child.send({ directive: 'DELIVER' });
    await recovered.phase('RECOVERED_WITH_REAL_MAIN');
    assert.deepEqual((await journalRows()).map(row => row.state), ['DELIVERED', 'DELIVERED']);
    assert.equal(await countNative(), 1, 'recovery must not replay native message effects');
    assert.equal(legacyRequests, 1, 'recovery must not repeat legacy webhook fanout');
    assert.equal(ownedRequests, 2);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public.jrc_real_hook_receiver')).rows[0].n), 2);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM public."Session"')).rows[0].n), 0);
    await terminate(recovered.child, 'SIGTERM', [1, null]);
    assert.match(outputs.get(recovered.child), /ORIGIN_ENGINE_SESSION_DRAIN_UNPROVEN|ORIGIN_ENGINE_SHUTDOWN_FAILED/u);
    report.recoveryStopExitCode = 1;
    const allOutput = [...outputs.values()].join('');
    assert.notEqual(report.outputLimitExceeded, true);
    for (const secret of [config.databaseUri, process.env.AUTHENTICATION_API_KEY, config.key, config.bearer, config.instanceToken]) {
      assert.equal(allOutput.includes(secret), false, 'candidate emitted a synthetic credential');
    }
    report.syntheticPayloadLoggedByUpstream = allOutput.includes('Synthetic real main hook text');
    assert.equal(report.syntheticPayloadLoggedByUpstream, false, 'ordinary notify text must not be printed by the candidate');
    report.journalEvents = 2; report.receiverRows = 2; report.nativeMessages = 1;
    report.unownedLegacyRequests = legacyRequests; report.ownedDispatcherRequests = ownedRequests;
    report.replayNativeEffects = 0; report.gate = 'REAL_ENGINE_HOOK_AND_SOURCE_CRASH_VERIFIED';
  } catch (error) {
    report.gate = 'FAILED_OR_INCONCLUSIVE'; report.failureCode = 'REAL_HOOK_ASSERTION_OR_RUNTIME_FAILURE';
    report.failureFrames = String(error.stack).split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 3);
    process.exitCode = 1;
  } finally {
    const cleanup = [];
    for (const child of children) {
      try { await terminate(child, 'SIGKILL'); cleanup.push(true); } catch { cleanup.push(false); }
    }
    try { server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve()); cleanup.push(true); } catch { cleanup.push(false); }
    try { await pool?.end(); cleanup.push(true); } catch { cleanup.push(false); }
    report.cleanupConfirmed = cleanup.every(Boolean);
    if (!report.cleanupConfirmed) process.exitCode = 1;
    console.log(JSON.stringify(report));
  }
}
