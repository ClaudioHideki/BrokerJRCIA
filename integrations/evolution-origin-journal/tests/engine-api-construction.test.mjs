import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { compileEngineFixture } from './engine-fixture.mjs';
import { withOriginEngineLabHost, awaitOriginEngineReady } from '../src/engine-host.mjs';

test('real pinned InstanceController assigns one final identity before attaching the Baileys host', async () => {
  const fixture = await compileEngineFixture();
  assert.equal(createHash('sha256').update(fixture.originals['src/api/controllers/instance.controller.ts'].replaceAll('\r\n','\n'))
    .digest('hex'), 'b0921eac4e202344e9c3100754965f1b97db94faf74b7b2089ac7cca16d5713f');
  const name = `synthetic-api-${randomUUID()}`, seen = [];
  let attachedInstance;
  await withOriginEngineLabHost({ labOnly:true, env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},
    prepareInstance: async (authority, candidate) => {
      seen.push(authority);
      attachedInstance = candidate;
      const binding = {...authority,generation:1,destinationId:randomUUID(),revision:1};
      return {binding,pool:{async query(){return {rows:[{ready:true}]};}},journal:{},resolveBinding:async()=>binding,
        transport:{endpoint:`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,bearerToken:'synthetic'},worker:{maxIterations:1}};
    }
  }, async () => {
    const { result, instance } = await fixture.createThroughApi(name);
    await awaitOriginEngineReady(instance);
    assert.equal(attachedInstance, instance, 'explicit lab host must observe the actual constructed object for offline method gates');
    assert.equal(seen.length,1);
    assert.match(seen[0].instanceId,/^[a-f0-9-]{36}$/u);
    assert.equal(result.instance.instanceId,seen[0].instanceId);
    assert.equal(instance.instanceId,seen[0].instanceId);
    assert.deepEqual(fixture.calls.filter(call=>call.kind==='save-instance').map(call=>call.id),[seen[0].instanceId]);
    assert.equal(result.qrcode,undefined);
  });
});

test('an independently evaluated host shares construction and retirement with the bundled engine module', async () => {
  // tsup embeds its own evaluation in main; a lab runner loads the module file.
  // This is the exact cross-evaluation registry boundary, not a final image gate.
  const separate = await import(`../src/engine-host.mjs?independent=${randomUUID()}`);
  const fixture = await compileEngineFixture();
  let observed, instance;
  await separate.withOriginEngineLabHost({ labOnly:true, env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},
    prepareInstance: async (authority, candidate) => {
      observed = candidate;
      const binding = {...authority,generation:1,destinationId:randomUUID(),revision:1};
      return {binding,pool:{async query(){return {rows:[{ready:true}]};}},journal:{},resolveBinding:async()=>binding,
        transport:{endpoint:`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,bearerToken:'synthetic'},worker:{maxIterations:1}};
    }
  }, async () => {
    ({ instance } = await fixture.createThroughApi(`synthetic-dual-${randomUUID()}`));
    const composition = await awaitOriginEngineReady(instance);
    assert.equal(observed, instance, 'the real constructor must see the explicitly installed host across module evaluations');
    assert.equal(composition.deliveryOwnership, 'UNPROVEN');
  });
  await assert.rejects(awaitOriginEngineReady(instance), /ORIGIN_ENGINE_HOST_CLOSED/u);
});
