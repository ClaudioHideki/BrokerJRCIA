import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {withOriginEngineLabHost,attachOriginEngineInstance,awaitOriginEngineReady,captureOriginBatch,decideOriginWebhook,trackOriginEngineFanout} from '../src/engine-host.mjs';
import {bindingFingerprint} from '../src/journal.mjs';
import {binding as template,source} from './fixtures.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(acceptBatch=async()=>[]){
 const binding={...template,instanceId:randomUUID(),instanceName:randomUUID(),destinationId:randomUUID()};
 const endpoint=`https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`;
 const instance={instance:{id:binding.instanceId,name:binding.instanceName}};
 const options={binding,pool:{async query(){return {rows:[{ready:true}]};}},journal:{acceptBatch,async claim(){return null;},async lookupCommittedOwnership(_binding,body){return {id:randomUUID(),scopeKey:sha([binding.instanceId,binding.generation,binding.destinationId,binding.revision]),eventKey:sha([body.data.key.id,body.data.key.fromMe,body.data.key.remoteJid]),bindingFingerprint:bindingFingerprint(binding),bodyHash:sha(body)};}},resolveBinding:async()=>binding,transport:{endpoint,bearerToken:'synthetic-only'},worker:{maxIterations:1}};
 return {binding,instance,options,webhook:{instanceName:binding.instanceName,event:'messages.upsert',data:source()['messages.upsert'].messages[0],destination:endpoint}};
}
async function withoutGlobalOptIn(work){const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;try{return await work();}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}}

test('lab host drains admitted captures before retiring webhook ownership',async()=>withoutGlobalOptIn(async()=>{
 const entered=deferred(),commit=deferred();
 const setup=fixture(async()=>{entered.resolve();await commit.promise;return [{id:randomUUID()}];});
 let capture,decision,ended=false;
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  capture=captureOriginBatch(setup.instance,source(),async()=>{decision=await decideOriginWebhook(setup.webhook);});
  await entered.promise;
 }).then(()=>{ended=true;});
 await entered.promise;await setImmediate();const retiredBeforeCommit=ended;
 commit.resolve();await capture;await running;
 assert.deepEqual({retiredBeforeCommit,decision},{retiredBeforeCommit:false,decision:'SUPPRESS_OWNED'});
}));

test('a retired engine instance cannot enqueue legacy work after its host exits',async()=>withoutGlobalOptIn(async()=>{
 const setup=fixture();
 await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
 });
 let enqueued=false;
 await assert.rejects(captureOriginBatch(setup.instance,source(),()=>{enqueued=true;}),/ORIGIN_ENGINE_HOST_CLOSED/u);
 await assert.rejects(awaitOriginEngineReady(setup.instance),/ORIGIN_ENGINE_HOST_CLOSED/u);
 await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  assert.throws(()=>attachOriginEngineInstance(setup.binding,setup.instance),/ORIGIN_ENGINE_HOST_CLOSED/u);
 });
 assert.equal(enqueued,false);
}));

test('host teardown drains the upstream eventProcessingQueue after capture registration returns',async()=>withoutGlobalOptIn(async()=>{
 const proceed=deferred(),registered=deferred(),setup=fixture();let decision,ended=false;
 setup.instance.eventProcessingQueue=Promise.resolve();
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  await captureOriginBatch(setup.instance,source(),()=>{
   // The pinned callback only assigns the queue; it does not return its promise.
   setup.instance.eventProcessingQueue=setup.instance.eventProcessingQueue.then(async()=>{await proceed.promise;decision=await decideOriginWebhook(setup.webhook);});
  });
  registered.resolve();
 }).then(()=>{ended=true;});
 await registered.promise;await setImmediate();const retiredBeforeQueue=ended;
 proceed.resolve();await setup.instance.eventProcessingQueue;await running;
 assert.deepEqual({retiredBeforeQueue,decision},{retiredBeforeQueue:false,decision:'SUPPRESS_OWNED'});
}));

test('closing a host blocks new capture admission while admitted capture drains',async()=>withoutGlobalOptIn(async()=>{
 const entered=deferred(),commit=deferred(),setup=fixture(async()=>{entered.resolve();await commit.promise;return [];});
 let first,enqueued=false;
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  first=captureOriginBatch(setup.instance,source(),()=>{});await entered.promise;
 });
 await entered.promise;await setImmediate();
 try{
  await assert.rejects(captureOriginBatch(setup.instance,source('late-provider-id'),()=>{enqueued=true;}),/ORIGIN_ENGINE_HOST_CLOS(?:ING|ED)/u);
  assert.equal(enqueued,false);
 }finally{commit.resolve();await first;await running;}
}));

test('an inherited asynchronous host context cannot attach a new instance during teardown',{timeout:1000},async()=>withoutGlobalOptIn(async()=>{
 const entered=deferred(),commit=deferred(),later=deferred(),setup=fixture(async()=>{entered.resolve();await commit.promise;return [];}),lateSetup=fixture();
 let first,attachment,prepares=0;
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>{prepares++;return setup.options;}},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  attachment=later.promise.then(()=>attachOriginEngineInstance(lateSetup.binding,lateSetup.instance));attachment.catch(()=>undefined);
  first=captureOriginBatch(setup.instance,source(),()=>{});await entered.promise;
 });
 await entered.promise;await setImmediate();later.resolve();
 try{await assert.rejects(attachment,/ORIGIN_ENGINE_HOST_CLOSING/u);assert.equal(prepares,1);}
 finally{commit.resolve();await first;await running;}
}));

test('a rejected upstream queue settles teardown and releases the name for a fresh instance',{timeout:1000},async()=>withoutGlobalOptIn(async()=>{
 const setup=fixture();
 await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  setup.instance.eventProcessingQueue=Promise.reject(new Error('SYNTHETIC_UPSTREAM_QUEUE_REJECTION'));
 });
 await assert.rejects(awaitOriginEngineReady(setup.instance),/ORIGIN_ENGINE_HOST_CLOSED/u);
 const replacement={instance:{id:setup.binding.instanceId,name:setup.binding.instanceName}};
 await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,replacement);assert.equal((await awaitOriginEngineReady(replacement)).deliveryOwnership,'UNPROVEN');
 });
}));

test('closing host refuses fresh readiness before a reconnect can access auth',{timeout:1000},async()=>withoutGlobalOptIn(async()=>{
 const entered=deferred(),commit=deferred(),setup=fixture(async()=>{entered.resolve();await commit.promise;return [];});
 let first,authReads=0;
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  first=captureOriginBatch(setup.instance,source(),()=>{});await entered.promise;
 });
 await entered.promise;await setImmediate();
 try{
  await assert.rejects(awaitOriginEngineReady(setup.instance).then(()=>{authReads++;}),/ORIGIN_ENGINE_HOST_CLOSING/u);
  assert.equal(authReads,0);
 }finally{commit.resolve();await first;await running;}
}));

test('unattached channel fanout retains its legacy contract with either global flag value',async()=>{
 const previous=process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
 try{for(const value of ['false','true']){
  process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=value;
  assert.equal(await trackOriginEngineFanout({},()=>Promise.resolve('UNMANAGED_LEGACY')),'UNMANAGED_LEGACY');
 }}finally{if(previous===undefined)delete process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;else process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=previous;}
});

test('rejected tracked fanout settles teardown while new fanout admission stays closed',{timeout:1000},async()=>withoutGlobalOptIn(async()=>{
 const setup=fixture(),entered=deferred(),proceed=deferred();let pending,ended=false,newEffects=0;
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  pending=trackOriginEngineFanout(setup.instance,async()=>{entered.resolve();await proceed.promise;throw new Error('SYNTHETIC_FANOUT_REJECTION');});pending.catch(()=>undefined);
  await entered.promise;
 }).then(()=>{ended=true;});
 await entered.promise;await setImmediate();
 try{
  assert.equal(ended,false);
  assert.throws(()=>trackOriginEngineFanout(setup.instance,()=>{newEffects++;}),/ORIGIN_ENGINE_HOST_CLOSING/u);
  assert.equal(newEffects,0);
 }finally{proceed.resolve();await assert.rejects(pending,/SYNTHETIC_FANOUT_REJECTION/u);await running;}
 assert.throws(()=>trackOriginEngineFanout(setup.instance,()=>{}),/ORIGIN_ENGINE_HOST_CLOSED/u);
}));

test('already captured upstream work may register its fanout during queue drain',{timeout:1000},async()=>withoutGlobalOptIn(async()=>{
 const setup=fixture(),entered=deferred(),proceed=deferred();let effects=0,ended=false;
 setup.instance.eventProcessingQueue=Promise.resolve();
 const running=withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>setup.options},async()=>{
  attachOriginEngineInstance(setup.binding,setup.instance);await awaitOriginEngineReady(setup.instance);
  await captureOriginBatch(setup.instance,source(),()=>{
   setup.instance.eventProcessingQueue=setup.instance.eventProcessingQueue.then(async()=>{entered.resolve();await proceed.promise;await trackOriginEngineFanout(setup.instance,async()=>{effects++;});});
  });await entered.promise;
 }).then(()=>{ended=true;});
 await entered.promise;await setImmediate();assert.equal(ended,false);
 proceed.resolve();await running;assert.equal(effects,1);
}));
