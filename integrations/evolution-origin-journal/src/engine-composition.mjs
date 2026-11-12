import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createOriginLabBootstrap } from './bootstrap.mjs';
import { bindingFingerprint } from './journal.mjs';
import { projectTextBatch } from './projection.mjs';
import { historyCaptureScopeKey } from './history-projection.mjs';
const digest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const snapshots = new WeakMap();

/** Synchronous allowlisted arrival snapshot. No raw event, quoted content or auth material is retained. */
export function snapshotOriginBatch(scope, events, historyToken = null) {
  if (typeof scope?.instanceId !== 'string' || typeof scope?.instanceName !== 'string') throw new Error('ORIGIN_ENGINE_SNAPSHOT_INVALID');
  const type = events?.['messages.upsert']?.type ?? 'other';
  const bodies = projectTextBatch(scope, events);
  for (const body of bodies) { Object.freeze(body.data.key); Object.freeze(body.data.message); Object.freeze(body.data); Object.freeze(body); }
  Object.freeze(bodies);
  const token = Object.freeze({});
  snapshots.set(token, Object.freeze({ instanceId: scope.instanceId, instanceName: scope.instanceName, type, bodies, hashes: new Set(bodies.map(digest)), historyToken }));
  return token;
}

/** Laboratory engine composition. The opaque capability is minted only after acceptBatch COMMIT. */
export function createOriginEngineComposition(options) {
  const binding = Object.freeze({ ...options.binding }), fingerprint = bindingFingerprint(binding);
  const base = createOriginLabBootstrap({ ...options, binding });
  const storage = new AsyncLocalStorage(), capabilities = new WeakMap();
  const endpoint = new URL(options.transport.endpoint).href;
  const enabled = options.env?.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';
  const historyEnabled = options.env?.HISTORY_SYNC_V2_ENABLED === 'true';
  const historyScope = options.history?.scope ? Object.freeze({ ...options.history.scope }) : null;
  const historyRunId = options.history?.runId;
  const resolveMediaReference = options.history?.mediaReference;
  if (historyEnabled && (!enabled || !historyScope || historyScope.instanceId !== binding.instanceId
    || historyScope.engineGeneration !== binding.generation || historyScope.bindingFingerprint !== fingerprint
    || typeof options.journal.history?.prepare !== 'function' || typeof options.journal.history?.append !== 'function'))
    throw Error('HISTORY_SOURCE_BINDING_CHANGED');
  if (historyEnabled && resolveMediaReference !== undefined && typeof resolveMediaReference !== 'function')
    throw Error('HISTORY_SOURCE_MEDIA_RESOLVER_INVALID');
  const mediaReference = request => {
    if (!resolveMediaReference) return null;
    // This port accepts an already durable private object from the attached
    // host. It cannot turn an arbitrary URL/key or another capture's object
    // into a historical media receipt.
    const reference = resolveMediaReference(Object.freeze({ ...request, scope: historyScope }));
    return reference?.persisted === true && reference.scopeKey === historyCaptureScopeKey(historyScope) ? reference : null;
  };
  const snapshot = events => {
    const historical = historyEnabled && events?.['messaging-history.set']
      ? options.journal.history.prepare(historyScope, historyRunId, events,
        { provenance: 'SOCKET', captureId: randomUUID(), capturedAt: new Date(), startOrdinal: 0, mediaReference }) : null;
    return snapshotOriginBatch(binding, events, historical);
  };
  const capturePrepared = async snapshot => {
    if (!enabled) return Object.freeze({ enabled: false, captured: 0 });
    const prepared = snapshots.get(snapshot);
    if (!prepared || prepared.instanceId !== binding.instanceId || prepared.instanceName !== binding.instanceName) throw new Error('ORIGIN_ENGINE_SNAPSHOT_INVALID');
    await options.journal.acceptBatch(binding, prepared.bodies);
    if (prepared.historyToken) {
      if (!historyEnabled) throw Error('HISTORY_SOURCE_BINDING_CHANGED');
      await options.journal.history.append(prepared.historyToken);
    }
    const token = Object.freeze({ enabled: true, captured: prepared.bodies.length });
    capabilities.set(token, Object.freeze({ fingerprint, type: prepared.type, hashes: prepared.hashes }));
    return token;
  };
  return Object.freeze({
    deliveryOwnership: 'UNPROVEN', start: base.start, stop: base.stop, capturePrepared, snapshot,
    async capture(events) {
      if (!enabled) return Object.freeze({ enabled: false, captured: 0 });
      return capturePrepared(snapshot(events));
    },
    runCapturedBatch(token, operation) {
      const context = capabilities.get(token);
      if (!context || context.fingerprint !== fingerprint || typeof operation !== 'function') throw new Error('ORIGIN_ENGINE_CAPABILITY_INVALID');
      return storage.run(context, operation);
    },
    webhookGuard: Object.freeze({ async decide(input) {
      let destination;
      try { destination = new URL(input.destination).href; } catch { return base.webhookGuard.decide(input); }
      if (input.event !== 'messages.upsert' || destination !== endpoint) return base.webhookGuard.decide(input);
      const [body] = projectTextBatch(binding, { 'messages.upsert': { type: 'notify', messages: [input.data] } });
      if (!body) return base.webhookGuard.decide(input);
      const context = storage.getStore();
      if (!context || context.fingerprint !== fingerprint) throw new Error('ORIGIN_ENGINE_PROVENANCE_UNAVAILABLE');
      if (context.type !== 'notify') return 'DELIVER_LEGACY';
      if (!context.hashes.has(digest(body))) throw new Error('ORIGIN_ENGINE_PROVENANCE_INVALID');
      const decision = await base.webhookGuard.decide(input);
      if (decision !== 'SUPPRESS_OWNED') throw new Error('ORIGIN_ENGINE_OWNERSHIP_MISSING');
      return decision;
    } }),
  });
}
