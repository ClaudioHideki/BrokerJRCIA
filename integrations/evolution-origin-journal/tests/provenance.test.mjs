import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { bindingFingerprint } from '../src/journal.mjs';
import { projectTextBatch } from '../src/projection.mjs';
import { createOriginEngineComposition } from '../src/engine-composition.mjs';
import { binding as template, source } from './fixtures.mjs';
const binding = { ...template, destinationId: randomUUID() };
const endpoint = `https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const envelope = () => projectTextBatch(binding, source())[0];
function fixture(acceptBatch = async () => [{ id: randomUUID() }]) {
  const journal = { acceptBatch, async lookupCommittedOwnership(_binding, body) {
    return { id: randomUUID(), scopeKey: hash(JSON.stringify([binding.instanceId,binding.generation,binding.destinationId,binding.revision])),
      bindingFingerprint: bindingFingerprint(binding), eventKey: hash(JSON.stringify([body.data.key.id,body.data.key.fromMe,body.data.key.remoteJid])),bodyHash: hash(JSON.stringify(body)) };
  }, async claim() { return null; } };
  return createOriginEngineComposition({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, journal, binding, resolveBinding: async () => binding,
    transport: { endpoint, bearerToken: 'synthetic-test-only' }, worker: { maxIterations: 1 } });
}
const input = () => ({ instanceName: binding.instanceName, event: 'messages.upsert', data: envelope().data, destination: endpoint });
test('committed batch capability carries notify vs append through queued async execution', async () => {
  const composition = fixture();
  const notify = await composition.capture(source());
  const appendEvents = source(); appendEvents['messages.upsert'].type = 'append';
  const append = await composition.capture(appendEvents);
  const decisions = await Promise.all([composition.runCapturedBatch(notify, async () => { await Promise.resolve(); return composition.webhookGuard.decide(input()); }),
    composition.runCapturedBatch(append, async () => { await Promise.resolve(); return composition.webhookGuard.decide(input()); })]);
  assert.deepEqual(decisions, ['SUPPRESS_OWNED','DELIVER_LEGACY']);
  await assert.rejects(composition.webhookGuard.decide(input()), /ORIGIN_ENGINE_PROVENANCE_UNAVAILABLE/);
  assert.equal(composition.deliveryOwnership,'UNPROVEN');
});
test('capability is issued only after durable append and cannot be forged or reused across instances', async () => {
  let release; const commit = new Promise(resolve => { release = resolve; });
  const composition = fixture(async () => { await commit; return [{ id: randomUUID() }]; });
  let completed = false;
  const pending = composition.capture(source()).then(value => { completed = true; return value; });
  await Promise.resolve(); assert.equal(completed,false);
  release(); const captured = await pending;
  assert.throws(() => composition.runCapturedBatch({ ...captured }, () => {}), /ORIGIN_ENGINE_CAPABILITY_INVALID/);
  assert.throws(() => fixture().runCapturedBatch(captured, () => {}), /ORIGIN_ENGINE_CAPABILITY_INVALID/);
});
test('notify provenance refuses transformed or out-of-batch supported facts instead of legacy bypass', async () => {
  const composition = fixture(), captured = await composition.capture(source());
  await composition.runCapturedBatch(captured, async () => {
    const changed = input(); changed.data.message.conversation = 'Synthetic transformed content';
    await assert.rejects(composition.webhookGuard.decide(changed), /ORIGIN_ENGINE_PROVENANCE_INVALID/);
    const absent = input(); absent.data.key.id = 'not-captured-provider-id';
    await assert.rejects(composition.webhookGuard.decide(absent), /ORIGIN_ENGINE_PROVENANCE_INVALID/);
  });
});
test('capture freezes source type before awaiting COMMIT despite caller mutation', async () => {
  let release; const commit = new Promise(resolve => { release = resolve; });
  const composition = fixture(async () => { await commit; return [{ id: randomUUID() }]; });
  const events = source(), pending = composition.capture(events);
  events['messages.upsert'].type = 'append'; release();
  const captured = await pending;
  assert.equal(await composition.runCapturedBatch(captured, () => composition.webhookGuard.decide(input())), 'SUPPRESS_OWNED');
});
