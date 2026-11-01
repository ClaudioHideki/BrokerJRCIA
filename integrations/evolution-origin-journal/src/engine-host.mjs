import { AsyncLocalStorage } from 'node:async_hooks';
import { createOriginJournal } from './journal.mjs';
import { createOriginEngineComposition, snapshotOriginBatch } from './engine-composition.mjs';
const construction = new AsyncLocalStorage(), instances = new WeakMap(), names = new Map();
const enabled = () => process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';

/** Explicit lab-only host. There is intentionally no production ownership installer. */
export async function withOriginEngineLabHost({ labOnly, env, prepareInstance, readyTimeoutMs = 10000 }, operation) {
  if (labOnly !== true || process.env.NODE_ENV === 'production' || env?.NODE_ENV === 'production' || env?.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED !== 'true'
    || typeof prepareInstance !== 'function' || typeof operation !== 'function' || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 30000) throw new Error('ORIGIN_ENGINE_LAB_HOST_REQUIRED');
  const host = { env: Object.freeze({ ...env }), prepareInstance, readyTimeoutMs, entries: new Set() };
  return construction.run(host, async () => {
    try { return await operation(); }
    finally { for (const entry of host.entries) {
      names.delete(entry.name); instances.delete(entry.instance);
      await entry.ready.then(composition => composition.stop()).catch(() => undefined);
    } }
  });
}
export function attachOriginEngineInstance(scope, instance) {
  const host = construction.getStore();
  if (!host && !enabled()) return instance;
  if (!host) throw new Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  const name = scope?.instanceName, id = scope?.instanceId;
  if (typeof name !== 'string' || !name || typeof id !== 'string' || !id || names.has(name) || instances.has(instance)) throw new Error('ORIGIN_ENGINE_INSTANCE_INVALID');
  const entry = { name, id, instance, captureQueue: Promise.resolve() }, authority = Object.freeze({ instanceName: name, instanceId: id });
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
export async function awaitOriginEngineReady(instance) {
  const entry = instances.get(instance);
  if (!entry && !enabled()) return null;
  if (!entry) throw new Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  const composition = await entry.ready;
  if (instance.instance?.name !== entry.name || instance.instance?.id !== entry.id) throw new Error('ORIGIN_ENGINE_BINDING_CHANGED');
  return composition;
}
export async function captureOriginBatch(instance, events, enqueue) {
  const entry = instances.get(instance);
  if (!entry) { await awaitOriginEngineReady(instance); return enqueue(); }
  const snapshot = snapshotOriginBatch({ instanceId: entry.id, instanceName: entry.name }, events);
  const work = entry.captureQueue.then(async () => {
    const composition = await awaitOriginEngineReady(instance);
    const token = await composition.capturePrepared(snapshot);
    return composition.runCapturedBatch(token, enqueue);
  });
  entry.captureQueue = work.catch(() => undefined);
  return work;
}
export async function decideOriginWebhook(input) {
  const entry = names.get(input?.instanceName);
  if (!entry) {
    if (!enabled() || input?.event !== 'messages.upsert') return 'DELIVER_LEGACY';
    throw new Error('ORIGIN_ENGINE_PROVENANCE_UNAVAILABLE');
  }
  return (await entry.ready).webhookGuard.decide(input);
}
