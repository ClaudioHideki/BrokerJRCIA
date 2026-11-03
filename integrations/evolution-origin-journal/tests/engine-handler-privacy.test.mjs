import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { compileEngineFixture } from './engine-fixture.mjs';

test('actual pinned notify handler does not print message text to unconditional console output', async () => {
  const logged = [];
  const fixture = await compileEngineFixture({ preserveMessageHandler: true, endpoint: 'https://broker.invalid/synthetic',
    onConsole: (...values) => logged.push(values) });
  const binding = { instanceId: randomUUID(), instanceName: `synthetic-log-${randomUUID()}` };
  const engine = fixture.create(binding);
  await engine.emit({ 'messages.upsert': { type: 'notify', messages: [{
    key: { id: 'synthetic-privacy-event', fromMe: false, remoteJid: `${'1'.repeat(11)}@s.whatsapp.net` },
    pushName: 'Synthetic', messageTimestamp: 1700000000, message: { conversation: 'SYNTHETIC_PRIVATE_TEXT_CANARY' },
  }] } });
  await new Promise(setImmediate);
  assert.deepEqual(fixture.errors.map(error => String(error)), [], 'the whole native handler must finish rather than skip the log path by failing');
  assert.equal(fixture.calls.filter(call => call.kind === 'legacy-http').length, 1);
  assert.equal(JSON.stringify(logged).includes('SYNTHETIC_PRIVATE_TEXT_CANARY'), false);
});
