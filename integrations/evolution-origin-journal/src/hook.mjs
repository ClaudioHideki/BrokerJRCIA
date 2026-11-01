import { projectTextBatch } from './projection.mjs';

/** Explicitly installed by a future engine bootstrap; never starts a worker or sends a message. */
export function createOriginCaptureHook({ env = {}, journal, binding }) {
  const enabled = env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';
  return Object.freeze({
    deliveryOwnership: 'INTEGRATION_ONLY',
    async capture(events) {
      if (!enabled) return { captured: 0, enabled: false };
      if (!journal || typeof journal.acceptBatch !== 'function') throw new Error('ORIGIN_JOURNAL_UNAVAILABLE');
      const rows = await journal.acceptBatch(binding, projectTextBatch(binding, events));
      return { captured: rows.length, enabled: true };
    },
  });
}
