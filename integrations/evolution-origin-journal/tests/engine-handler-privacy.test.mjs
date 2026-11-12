import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { compileEngineFixture } from './engine-fixture.mjs';

test('actual pinned on-demand history branch never prints private message payloads',async()=>{
  const logged=[],fixture=await compileEngineFixture({endpoint:'https://broker.invalid/synthetic',onConsole:(...values)=>logged.push(values),
    baileysModule:{proto:{HistorySync:{HistorySyncType:{ON_DEMAND:'SYNTHETIC_ON_DEMAND'}}}}});
  const engine=fixture.create({instanceId:randomUUID(),instanceName:`Synthetic-history-privacy-${randomUUID()}`});
  await engine.instance.messageHandle['messaging-history.set']({syncType:'SYNTHETIC_ON_DEMAND',chats:[],contacts:[],messages:[{
    key:{id:'synthetic-private-history',remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`,fromMe:false},
    messageTimestamp:1600000000,message:{conversation:'SYNTHETIC_PRIVATE_HISTORY_CANARY'},
  }]});
  assert.equal(logged.some(values=>String(values[0]).startsWith('recv 0 chats')),true,'the native history branch must actually execute');
  assert.equal(JSON.stringify(logged).includes('SYNTHETIC_PRIVATE_HISTORY_CANARY'),false);
});

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
