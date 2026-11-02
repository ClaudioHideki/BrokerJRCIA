import { AsyncLocalStorage } from 'node:async_hooks';
import { createOriginJournal } from './journal.mjs';
import { createOriginEngineComposition, snapshotOriginBatch } from './engine-composition.mjs';
const construction = new AsyncLocalStorage(), capturedWork = new AsyncLocalStorage(), instances = new WeakMap(), names = new Map(), retired = new WeakSet();
const enabled = () => process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';

/** Explicit lab-only host. There is intentionally no production ownership installer. */
export async function withOriginEngineLabHost({ labOnly, env, prepareInstance, readyTimeoutMs = 10000 }, operation) {
  if (labOnly !== true || process.env.NODE_ENV === 'production' || env?.NODE_ENV === 'production' || env?.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED !== 'true'
    || typeof prepareInstance !== 'function' || typeof operation !== 'function' || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 30000) throw new Error('ORIGIN_ENGINE_LAB_HOST_REQUIRED');
  const host = { env: Object.freeze({ ...env }), prepareInstance, readyTimeoutMs, entries: new Set(), closing: false };
  return construction.run(host, async () => {
    try { return await operation(); }
    finally {
      host.closing = true;
      for (const entry of host.entries) entry.closing = true;
      await Promise.all([...host.entries].map(async entry => {
        try {
          await entry.captureQueue;
          // The pinned callback registers this promise without returning it.
          // Keep ownership available until its already-admitted work settles.
          await Promise.resolve(entry.instance.eventProcessingQueue).catch(() => undefined);
          // Upstream does not await sendDataWebhook. Its actual fanout may still
          // be blocked in an earlier sink after eventProcessingQueue settles.
          while (entry.fanouts.size) await Promise.allSettled([...entry.fanouts]);
          await entry.ready.then(composition => composition.stop()).catch(() => undefined);
        } finally {
          retired.add(entry.instance); names.delete(entry.name); instances.delete(entry.instance);
        }
      }));
    }
  });
}
export function attachOriginEngineInstance(scope, instance) {
  const host = construction.getStore();
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  if (host?.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  if (!host && !enabled()) return instance;
  if (!host) throw new Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  const name = scope?.instanceName, id = scope?.instanceId;
  if (typeof name !== 'string' || !name || typeof id !== 'string' || !id || names.has(name) || instances.has(instance)) throw new Error('ORIGIN_ENGINE_INSTANCE_INVALID');
  const entry = { name, id, instance, captureQueue: Promise.resolve(), fanouts: new Set() }, authority = Object.freeze({ instanceName: name, instanceId: id });
  let timer, expired = false;
  const preparing = (async () => {
    const options = await host.prepareInstance(authority);
    if (expired) throw new Error();
    if (options.binding?.instanceName !== name || options.binding?.instanceId !== id) throw new Error('ORIGIN_ENGINE_BINDING_CHANGED');
    const result = await options.pool.query("SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AND to_regclass('jrc_evolution_origin.events') IS NOT NULL AS ready");
    if (expired || result.rows[0]?.ready !== true) throw new Error('ORIGIN_ENGINE_DATABASE_NOT_READY');
    const journal = options.journal ?? createOriginJournal({ pool: options.pool, encryptionKey: options.encryptionKey });
    const composition = createOriginEngineComposition({ ...options, journal, env: host.env });
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
  const composition = await admittedEntryReady(instance, entry);
  if (entry.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  return composition;
}
export async function captureOriginBatch(instance, events, enqueue) {
  if (retired.has(instance)) throw new Error('ORIGIN_ENGINE_HOST_CLOSED');
  const entry = instances.get(instance);
  if (entry?.closing) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  if (!entry) { await awaitOriginEngineReady(instance); return enqueue(); }
  const snapshot = snapshotOriginBatch({ instanceId: entry.id, instanceName: entry.name }, events);
  const work = entry.captureQueue.then(async () => {
    const composition = await admittedEntryReady(instance, entry);
    const token = await composition.capturePrepared(snapshot);
    return composition.runCapturedBatch(token, () => capturedWork.run(entry, enqueue));
  });
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
  if (entry.closing && capturedWork.getStore() !== entry) throw new Error('ORIGIN_ENGINE_HOST_CLOSING');
  let promise;
  try { promise = Promise.resolve(operation()); } catch (error) { promise = Promise.reject(error); }
  entry.fanouts.add(promise);
  promise.then(() => entry.fanouts.delete(promise), () => entry.fanouts.delete(promise));
  return promise;
}
export async function decideOriginWebhook(input) {
  const entry = names.get(input?.instanceName);
  if (!entry) {
    if (!enabled() || input?.event !== 'messages.upsert') return 'DELIVER_LEGACY';
    throw new Error('ORIGIN_ENGINE_PROVENANCE_UNAVAILABLE');
  }
  return (await entry.ready).webhookGuard.decide(input);
}
