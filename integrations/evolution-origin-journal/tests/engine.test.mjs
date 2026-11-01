import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { bindingFingerprint } from '../src/journal.mjs';
import { withOriginEngineLabHost,awaitOriginEngineReady } from '../src/engine-host.mjs';
import { preparePinnedEngineSources } from '../src/engine-overlay.mjs';
import { compileEngineFixture } from './engine-fixture.mjs';
import { binding as template, source } from './fixtures.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function options(binding,endpoint){return {binding,pool:{async query(){return {rows:[{ready:true}]};}},journal:{async acceptBatch(_binding,bodies){return bodies.map(()=>({id:randomUUID()}));},async claim(){return null;},async lookupCommittedOwnership(_binding,body){return {id:randomUUID(),scopeKey:sha(JSON.stringify([binding.instanceId,binding.generation,binding.destinationId,binding.revision])),eventKey:sha(JSON.stringify([body.data.key.id,body.data.key.fromMe,body.data.key.remoteJid])),bindingFingerprint:bindingFingerprint(binding),bodyHash:sha(JSON.stringify(body))};}},resolveBinding:async()=>binding,transport:{endpoint,bearerToken:'synthetic-test-only'},worker:{maxIterations:1}};}
const events=type=>({'messages.upsert':{...source()['messages.upsert'],type}});
async function lab(options,operation){const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';try{return await withOriginEngineLabHost(options,operation);}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}}
test('whole compiled pinned construction/queue/normalization/webhook composition preserves notify/append provenance',async()=>{
 const binding={...template,destinationId:randomUUID()},endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`;
 const fixture=await compileEngineFixture({endpoint});
 await lab({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>options(binding,endpoint)},async()=>{
  const engine=fixture.create(binding);
  await Promise.all([engine.emit(events('notify')),engine.emit(events('append'))]);
  assert.equal(engine.legacyPasses,2);assert.equal(fixture.calls.filter(call=>call.kind==='legacy-http').length,1);
  for(const kind of ['websocket','rabbitmq','nats','sqs','pusher','kafka'])assert.equal(fixture.calls.filter(call=>call.kind===kind).length,2);
  assert.equal((await awaitOriginEngineReady(engine.instance)).deliveryOwnership,'UNPROVEN');
 });
 assert.throws(()=>preparePinnedEngineSources({...fixture.originals,'src/api/services/channel.service.ts':fixture.originals['src/api/services/channel.service.ts']+'\n'}),/ORIGIN_ENGINE_SOURCE_MISMATCH/);
});
test('actual compiled createClient waits for bootstrap before any auth-state access',async()=>{
 const binding={...template,destinationId:randomUUID()},endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`;
 const fixture=await compileEngineFixture({endpoint});let release;const ready=new Promise(resolve=>{release=resolve;});
 await lab({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>{await ready;return options(binding,endpoint);}},async()=>{
  const engine=fixture.create(binding);let authReads=0;
  engine.instance.defineAuthState=async()=>{authReads++;throw Error('LAB_STOP_BEFORE_AUTH');};
  const connecting=engine.instance.createClient();await Promise.resolve();assert.equal(authReads,0);
  release();await assert.rejects(connecting,/LAB_STOP_BEFORE_AUTH/);assert.equal(authReads,1);
 });
});
test('enabled construction without explicit lab host fails closed before returning an engine',async()=>{
 const binding={...template,destinationId:randomUUID()},fixture=await compileEngineFixture({endpoint:`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`});
 const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';
 try{assert.throws(()=>fixture.create(binding),/ORIGIN_ENGINE_OWNERSHIP_UNPROVEN/);}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
});
test('source arrival order survives a slow first COMMIT before a following append registers volatile work',async()=>{
 const binding={...template,destinationId:randomUUID()},endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,fixture=await compileEngineFixture({endpoint});
 let release,entered;const firstCommit=new Promise(resolve=>{release=resolve;}),capturing=new Promise(resolve=>{entered=resolve;});
 const config=options(binding,endpoint);config.journal.acceptBatch=async(_binding,bodies)=>{if(bodies.length){entered();await firstCommit;}return bodies.map(()=>({id:randomUUID()}));};
 await lab({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>config},async()=>{
  const engine=fixture.create(binding),first=engine.emit(events('notify'));await capturing;const second=engine.emit(events('append'));
  await new Promise(resolve=>setTimeout(resolve,20));
  try{assert.equal(engine.legacyPasses,0);}finally{release();await Promise.all([first,second]);}
 });
});
test('registered composition owns notify when process flag is absent or changes after attachment',async()=>{
 const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
 const observed=[];
 try{for(const changeAfterAttach of [false,true]){
  const binding={...template,destinationId:randomUUID()},endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,fixture=await compileEngineFixture({endpoint});
  await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>options(binding,endpoint)},async()=>{
   const engine=fixture.create(binding);
   if(changeAfterAttach)process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='false';
   await engine.emit(events('notify'));
   observed.push(fixture.calls.filter(call=>call.kind==='legacy-http').length);
   assert.equal(fixture.errors.length,0);
  });
 }assert.deepEqual(observed,[0,0]);}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
});
test('actual callback snapshots source type and projected text synchronously before readiness or queue waiting',async()=>{
 const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
 const captures=[];
 try{for(const mutateText of [false,true]){
  const binding={...template,destinationId:randomUUID()},endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`,fixture=await compileEngineFixture({endpoint});
  let ready;const readiness=new Promise(resolve=>{ready=resolve;}),config=options(binding,endpoint);
  config.journal.acceptBatch=async(_binding,bodies)=>{captures.push(bodies.map(body=>body.data.message.conversation));return bodies.map(()=>({id:randomUUID()}));};
  await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>{await readiness;return config;}},async()=>{
   const engine=fixture.create(binding),incoming=events('notify'),pending=engine.emit(incoming);
   if(mutateText)incoming['messages.upsert'].messages[0].message.conversation='Synthetic late mutation';else incoming['messages.upsert'].type='append';
   ready();await pending;
   assert.equal(fixture.calls.filter(call=>call.kind==='legacy-http').length,0);
   assert.equal(fixture.errors.length,mutateText?1:0);
  });
 }assert.deepEqual(captures,[['Synthetic text'],['Synthetic text']]);}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
});
