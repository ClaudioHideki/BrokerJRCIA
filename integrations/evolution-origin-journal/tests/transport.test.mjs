import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createOriginHttpTransport } from '../src/http-transport.mjs';
import { createOriginWorker } from '../src/worker.mjs';
import { createOriginLabBootstrap } from '../src/bootstrap.mjs';
import { binding as template } from './fixtures.mjs';
const binding = { ...template, destinationId: randomUUID() };

async function server(work, handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${http.address().port}/v1/webhooks/whatsapp/${binding.destinationId}`); }
  finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
}
const configured = endpoint => ({ endpoint, binding, bearerToken: 'synthetic-test-only', allowInsecureLoopbackForTests: true, timeoutMs: 3000, maxResponseBytes: 512 });
const delivery = () => ({ id: randomUUID(), body: { event: 'messages.upsert', text: 'Synthetic ü' }, binding });

test('HTTP sends exact JSON hash, stable UUID and existing Bearer auth to a fixed endpoint', async () => {
  let observed;
  await server(async endpoint => {
    const input = delivery();
    const result = await createOriginHttpTransport(configured(endpoint))(input);
    assert.equal(result.status, 200); assert.equal(result.sourceEventId, input.id); assert.equal(result.durablyAccepted, true);
    assert.equal(observed.headers.authorization, 'Bearer synthetic-test-only');
    assert.equal(observed.headers['x-jrc-origin-event-id'], input.id);
    assert.equal(observed.body, JSON.stringify(input.body));
    assert.equal(observed.headers['x-jrc-origin-content-sha256'], createHash('sha256').update(observed.body).digest('hex'));
  }, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    observed = { headers: req.headers, body };
    res.end(JSON.stringify({ sourceEventId: req.headers['x-jrc-origin-event-id'], durablyAccepted: true, status: 'accepted' }));
  });
});

test('HTTP refuses redirect without calling its target and never promotes legacy/invalid receipts', async () => {
  for (const receipt of [{ status: 'accepted' }, { sourceEventId: randomUUID(), durablyAccepted: true, status: 'accepted' }, { sourceEventId: 'MATCH', durablyAccepted: true, status: 'arbitrary' }]) {
    await server(async endpoint => {
      const result = await createOriginHttpTransport(configured(endpoint))(delivery());
      assert.equal(result.durablyAccepted, undefined);
    }, (req, res) => res.end(JSON.stringify({ ...receipt, sourceEventId: receipt.sourceEventId === 'MATCH' ? req.headers['x-jrc-origin-event-id'] : receipt.sourceEventId })));
  }
  let requests = 0;
  await server(async endpoint => {
    const result = await createOriginHttpTransport(configured(endpoint))(delivery());
    assert.equal(result.status, 302); assert.equal(requests, 1);
  }, (_req, res) => { requests++; res.writeHead(302, { location: '/must-never-follow' }).end(); });
});

test('HTTP accepts duplicate receipt, bounds Retry-After and honors caller abort without I/O', async () => {
  let calls = 0;
  await server(async endpoint => {
    const send = createOriginHttpTransport(configured(endpoint)), input = delivery();
    assert.equal((await send(input)).durablyAccepted, true);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(send({ ...input, signal: controller.signal }), /ORIGIN_TRANSPORT_FAILED/);
    assert.equal(calls, 1);
  }, (req, res) => { calls++; res.end(JSON.stringify({ sourceEventId: req.headers['x-jrc-origin-event-id'], durablyAccepted: true, status: 'duplicate' })); });
  await server(async endpoint => {
    assert.deepEqual(await createOriginHttpTransport(configured(endpoint))(delivery()), { status: 429, retryAfterMs: 300000 });
  }, (_req, res) => res.writeHead(429, { 'retry-after': '99999999' }).end());
});

test('HTTP bounds response and wall time, sanitizes errors and fences the configured binding', async () => {
  await server(async endpoint => {
    const send = createOriginHttpTransport(configured(endpoint));
    await assert.rejects(send({ ...delivery(), binding: { ...binding, revision: 2 } }), /^Error: ORIGIN_TRANSPORT_BINDING_CHANGED$/);
    await assert.rejects(send(delivery()), /^Error: ORIGIN_TRANSPORT_FAILED$/);
  }, (_req, res) => res.end('private-error'.repeat(200)));
  await server(async endpoint => {
    const start = Date.now();
    await assert.rejects(createOriginHttpTransport({ ...configured(endpoint), timeoutMs: 150 })(delivery()), /^Error: ORIGIN_TRANSPORT_FAILED$/);
    assert.ok(Date.now() - start < 1500);
  }, () => {});
  for (const endpoint of ['http://example.invalid/v1/webhooks/whatsapp/a', 'https://trusted.invalid/other', 'https://u:p@trusted.invalid/v1/webhooks/whatsapp/a', 'https://trusted.invalid/v1/webhooks/whatsapp/a?redirect=x']) {
    assert.throws(() => createOriginHttpTransport(configured(endpoint)), /ORIGIN_TRANSPORT_CONFIGURATION_INVALID/);
  }
});

test('worker serializes bounded passes and cooperative stop waits for in-flight dispatch', async () => {
  let calls = 0, release;
  const dispatcher = { async runOnce() { calls++; await new Promise(resolve => { release = resolve; }); return { kind: 'IDLE' }; } };
  const worker = createOriginWorker({ dispatcher, binding, pollMs: 5, maxIterations: 3 });
  const running = worker.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  const stopped = worker.stop();
  assert.equal(calls, 1); release(); await stopped; await running;
  assert.equal(calls, 1);
  const finite = createOriginWorker({ dispatcher: { async runOnce() { calls++; } }, binding, pollMs: 1, maxIterations: 2 });
  await finite.start(); assert.equal(calls, 3);
});

test('HTTP configuration refuses a trusted host path pointing at a different destination channel', () => {
  assert.throws(() => createOriginHttpTransport(configured(`https://broker.invalid/v1/webhooks/whatsapp/${randomUUID()}`)), /ORIGIN_TRANSPORT_CONFIGURATION_INVALID/);
});

test('laboratory bootstrap never asserts engine ownership or auto-starts a worker', async () => {
  let claims = 0;
  const bootstrap = createOriginLabBootstrap({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, journal: { async claim() { claims++; return null; } }, binding,
    resolveBinding: async () => binding, transport: configured(`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`), worker: { pollMs: 1, maxIterations: 2 } });
  assert.equal(bootstrap.deliveryOwnership, 'UNPROVEN'); assert.equal(claims, 0);
  assert.equal(typeof bootstrap.webhookGuard?.decide, 'function');
  await bootstrap.start(); assert.equal(claims, 2); await bootstrap.stop();
});
