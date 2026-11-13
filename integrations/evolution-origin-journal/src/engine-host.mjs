import { AsyncLocalStorage } from 'node:async_hooks';
import { createOriginJournal } from './journal.mjs';
import { createOriginEngineComposition, snapshotOriginBatch } from './engine-composition.mjs';
import {createPostgresOriginAuthority} from './postgres-authority.mjs';
import {setTimeout as retryDelay} from 'node:timers/promises';
// tsup embeds this module in main while the explicit lab loader imports the
// inventoried module file. Share only process-local host state across those
// evaluations; no host is installed until withOriginEngineLabHost is invoked.
const stateKey = Symbol.for('jrc.evolution.origin.engine-host.v1');
const state = globalThis[stateKey] ??= Object.freeze({
  construction: new AsyncLocalStorage(), capturedWork: new AsyncLocalStorage(),
  instances: new WeakMap(), names: new Map(), retired: new WeakSet(),socketProofs:new WeakMap(),
  database: {host:null},
});
const { construction, capturedWork, instances, names, retired } = state;
const enabled = () => process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';

function retryableSourceDatabaseError(error){
  const code=typeof error?.code==='string'?error.code:'';
  // pg Client and pg-pool also emit these exact connection errors without a
  // code. Do not retry arbitrary domain errors, conflicting captures or the
  // native enqueue operation; only persistence of the frozen batch is retried.
  return /^08/u.test(code)||['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','57P01','57P02','57P03','53300','40001','40P01','55P03'].includes(code)
    ||(!code&&error instanceof Error&&['Connection terminated unexpectedly','timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout'].includes(error.message))||error?.message==='HISTORY_SOURCE_QUOTA';
}

export async function retireOriginEngineInstance(instance){
  const entry=instances.get(instance);if(!entry)return;
  if(entry.retirement)return entry.retirement;
  entry.closing=true;entry.retryAbort.abort();
  entry.retirement=(async()=>{
    try{
      await entry.captureQueue;
      await Promise.resolve(entry.instance.eventProcessingQueue).catch(()=>undefined);
      while(entry.fanouts.size)await Promise.allSettled([...entry.fanouts]);
      await entry.ready?.then(composition=>composition?.stop()).catch(()=>undefined);
    }finally{retired.add(instance);if(names.get(entry.name)===entry)names.delete(entry.name);instances.delete(instance);entry.host.entries.delete(entry);}
  })();return entry.retirement;
}
async function drainHost(host){
  host.closing=true;
  await Promise.all([...host.entries].map(entry=>retireOriginEngineInstance(entry.instance)));
}

/** Private process host; no HTTP caller can install it. PostgreSQL verifies the
 * dedicated engine principal, scope and durability before constructors attach.
 * The loader must register close as a drain, after verifying inventoried bytes. */
export async function installOriginEngineDatabaseHost(options){
  if(state.database.host||options.env?.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED!=='true'||options.env?.HISTORY_SYNC_V2_ENABLED!=='true')
    throw Error('ORIGIN_ENGINE_DATABASE_HOST_INVALID');
  const origin=new URL(options.brokerOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw Error('ORIGIN_ENGINE_DATABASE_HOST_INVALID');
  const authority=createPostgresOriginAuthority(options);await authority.verify();
  const host={operational:true,authority,origin:origin.origin,env:Object.freeze({...options.env}),entries:new Set(),closing:false};
  state.database.host=host;
  return Object.freeze({async close(){try{await drainHost(host);}finally{if(state.database.host===host)state.database.host=null;}}});
}

export async function prepareOriginEngineSocket(instance){
  const entry=instances.get(instance);
  if(!entry?.host?.operational){await awaitOriginEngineReady(instance);return;}
  if(entry.closing)throw Error('ORIGIN_ENGINE_HOST_CLOSING');
  // Invalidate the old socket before the first asynchronous admission read.
  entry.socketMarker=Symbol();entry.socketPrepared=false;
  // Authentication is initialized now, before makeWASocket can emit a batch.
  // Re-read policy for every reconnect: provisioning may precede admission.
  const options=await entry.host.authority.prepare({instanceName:entry.name,instanceId:entry.id},instance);
  entry.legacy=options.mode==='LEGACY';entry.socketPrepared=true;
  if(entry.legacy){entry.ready=Promise.resolve(null);entry.snapshot=null;return;}
  const {admission,journal}=options;
  const composition=createOriginEngineComposition({binding:admission.binding,journal,env:entry.host.env,brokerPull:true,
    resolveBinding:options.assert,transport:{endpoint:`${entry.host.origin}/v1/webhooks/whatsapp/${admission.scope.channelId}`},
    history:{scope:admission.scope,runId:admission.runId,canonicalInstanceId:admission.scope.instanceId,
      configurationFingerprint:admission.scope.bindingFingerprint}});
  entry.observeOwner=options.observeOwner;entry.snapshot=composition.snapshot;entry.historyEnabled=true;
  entry.ready=Promise.resolve(composition);
  await options.observeOwner();
}

/** Explicit lab-only host. There is intentionally no production ownership installer. */
export async function withOriginEngineLabHost({ labOnly, env, prepareInstance, readyTimeoutMs = 10000 }, operation) {
  if (labOnly !== true || process.env.NODE_ENV === 'production' || env?.NODE_ENV === 'production' || env?.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED !== 'true'
    || typeof prepareInstance !== 'function' || typeof operation !== 'function' || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 30000) throw new Error('ORIGIN_ENGINE_LAB_HOST_REQUIRED');
  const host = { env: Object.freeze({ ...env }), prepareInstance, readyTimeoutMs, entries: new Set(), closing: false };
  return construction.run(host, async () => {
    try { return await operation(); }
    finally {await drainHost(host);}
  });
}
export function attachOriginEngineInstance(scope, instance) {
  const host = construction.getStore()??state.database.host;
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  if (host?.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  if (!host && !enabled()) return instance;
  if (!host) throw new Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  const name = scope?.instanceName, id = scope?.instanceId;
  if (typeof name !== 'string' || !name || typeof id !== 'string' || !id || names.has(name) || instances.has(instance)) throw new Error('ORIGIN_ENGINE_INSTANCE_INVALID');
  const entry = { name, id, instance,host,socketMarker:Symbol(),retryAbort:new AbortController(),pendingCaptures:0,captureQueue: Promise.resolve(), fanouts: new Set(),
    historyEnabled: host.env.HISTORY_SYNC_V2_ENABLED === 'true' }, authority = Object.freeze({ instanceName: name, instanceId: id });
  if(host.operational){
    Object.assign(entry,{host,socketPrepared:false,legacy:false,ready:Promise.resolve(null)});
    instances.set(instance,entry);names.set(name,entry);host.entries.add(entry);return instance;
  }
  let timer, expired = false;
  const preparing = (async () => {
    // Only the explicit trusted laboratory host receives the constructed object;
    // this is not an HTTP hook or a production ownership installer.
    const options = await host.prepareInstance(authority, instance);
    if (expired) throw new Error();
    if (options.binding?.instanceName !== name || options.binding?.instanceId !== id) throw new Error('ORIGIN_ENGINE_BINDING_CHANGED');
    const result = await options.pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AND to_regclass('jrc_evolution_origin.events') IS NOT NULL AS ready");
    if (expired || result.rows[0]?.ready !== true) throw new Error('ORIGIN_ENGINE_DATABASE_NOT_READY');
    const journal = options.journal ?? createOriginJournal({ pool: options.pool, encryptionKey: options.encryptionKey,
      history: options.history ? { maxStagedBytes: options.history.maxStagedBytes, captureMedia: options.history.captureMedia === true } : undefined });
    const composition = createOriginEngineComposition({ ...options, journal, env: host.env });
    entry.snapshot = composition.snapshot;
    if (options.startWorker === true) composition.start().catch(() => undefined);
    return composition;
  })();
  entry.ready = Promise.race([preparing, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('ORIGIN_ENGINE_BOOTSTRAP_UNAVAILABLE')); }, host.readyTimeoutMs); })])
    .catch(() => { throw new Error('ORIGIN_ENGINE_BOOTSTRAP_UNAVAILABLE'); }).finally(() => clearTimeout(timer));
  entry.ready.catch(() => undefined);
  instances.set(instance, entry); names.set(name,entry); host.entries.add(entry);
  return instance;
}
async function admittedEntryReady(instance, entry) {
  const composition = await entry.ready;
  if (instance.instance?.name !== entry.name || instance.instance?.id !== entry.id) throw new Error('ORIGIN_ENGINE_BINDING_CHANGED');
  return composition;
}
export async function awaitOriginEngineReady(instance) {
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  const entry = instances.get(instance);
  if (!entry && !enabled()) return null;
  if (!entry) throw new Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  if (entry.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  if(entry.host?.operational)return null;
  const composition = await admittedEntryReady(instance, entry);
  if (entry.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  return composition;
}
/** Capability minted at native ev.process registration, never from event data. */
export function bindOriginEngineSocket(instance){
  if(retired.has(instance))throw Error('ORIGIN_ENGINE_HOST_CLOSED');
  const entry=instances.get(instance);
  if(!entry){if(!enabled())return null;throw Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');}
  if(entry.closing||retired.has(instance))throw Error('ORIGIN_ENGINE_HOST_CLOSED');
  if(entry.host.operational&&!entry.socketPrepared)throw Error('ORIGIN_ENGINE_AUTH_NOT_READY');
  const proof=Object.freeze({});state.socketProofs.set(proof,{entry,marker:entry.socketMarker,ready:entry.ready,
    snapshot:entry.snapshot,observeOwner:entry.observeOwner,socket:instance.client});return proof;
}
export async function captureOriginBatch(instance, events, enqueue,socketProof=null) {
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  const entry = instances.get(instance);
  if (entry?.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  if (!entry) { await awaitOriginEngineReady(instance); return enqueue(); }
  if(entry.host?.operational&&!entry.socketPrepared)throw Error('ORIGIN_ENGINE_AUTH_NOT_READY');
  const socket=socketProof?state.socketProofs.get(socketProof):null;
  const assertSocket=()=>{
    if(entry.closing)throw Error('ORIGIN_ENGINE_HOST_CLOSING');
    if(entry.host.operational&&(!socket||socket.entry!==entry||socket.marker!==entry.socketMarker))throw Error('ORIGIN_ENGINE_SOCKET_CHANGED');
  };assertSocket();
  if(entry.legacy)return enqueue();
  if (entry.historyEnabled && events?.['messaging-history.set'] && !entry.snapshot) throw Error('HISTORY_SOURCE_HOST_NOT_READY');
  if(entry.pendingCaptures>=128)throw Error('ORIGIN_ENGINE_BACKPRESSURE');
  const snapshotter=socket?.snapshot??entry.snapshot;
  const snapshot = snapshotter ? snapshotter(events) : snapshotOriginBatch({ instanceId: entry.id, instanceName: entry.name }, events);
  const ready=socket?.ready??entry.ready,observe=socket?.observeOwner??entry.observeOwner;
  const ownerJid=socket?.socket?.user?.id??instance.instance.authState?.state?.creds?.me?.id;
  entry.pendingCaptures++;
  const work = entry.captureQueue.then(async () => {
    const composition=await ready;let attempt=0;
    for(;;){
      assertSocket();
      let token;
      try{
        await observe?.(ownerJid);assertSocket();
        token=await composition.capturePrepared(snapshot);
      }catch(error){
        if(!entry.host.operational||!retryableSourceDatabaseError(error))throw error;
        entry.lastCaptureError='SOURCE_DATABASE_UNAVAILABLE';
        try{await retryDelay(Math.min(30000,250*2**Math.min(attempt++,7)),undefined,{signal:entry.retryAbort.signal});}
        catch{throw Error('ORIGIN_ENGINE_HOST_CLOSING');}
        continue;
      }
      return composition.runCapturedBatch(token,()=>capturedWork.run({entry,composition},enqueue));
    }
  }).finally(()=>{entry.pendingCaptures--;});
  entry.captureQueue = work.catch(() => undefined);
  return work;
}
/** Track the real base-channel fanout promise without awaiting it at its caller. */
export function trackOriginEngineFanout(instance, operation) {
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  const entry = instances.get(instance);
  // This base class also serves providers outside the attached Baileys host.
  // Their existing fanout must not acquire an origin-ownership requirement.
  if (!entry) return operation();
  if (entry.closing && capturedWork.getStore()?.entry !== entry) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  let promise;
  try { promise = Promise.resolve(operation()); } catch (error) { promise = Promise.reject(error); }
  entry.fanouts.add(promise);
  promise.then(() => entry.fanouts.delete(promise), () => entry.fanouts.delete(promise));
  return promise;
}
export async function decideOriginWebhook(input) {
  if(input?.event!=='messages.upsert')return 'DELIVER_LEGACY';
  const entry = names.get(input?.instanceName);
  if(entry?.legacy)return 'DELIVER_LEGACY';
  if (!entry) {
    if (!enabled() || input?.event !== 'messages.upsert') return 'DELIVER_LEGACY';
    throw new Error('ORIGIN_ENGINE_PROVENANCE_UNAVAILABLE');
  }
  const captured=capturedWork.getStore();
  const composition=captured?.entry===entry?captured.composition:await entry.ready;
  if(!composition)throw Error('ORIGIN_ENGINE_AUTH_NOT_READY');
  return composition.webhookGuard.decide(input);
}
