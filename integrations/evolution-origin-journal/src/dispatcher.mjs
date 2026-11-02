import { performance } from 'node:perf_hooks';
import { bindingFingerprint } from './journal.mjs';

/** An injected integration delivery port only. Never runs the source/legacy handler on replay. */
export function createOriginDispatcher({ env = {}, journal, resolveBinding, deliver, maxAttempts = 10, timeoutMs = 10000, maxRetryMs = 300000 }) {
  const enabled = env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';
  if (![maxAttempts, timeoutMs, maxRetryMs].every(Number.isSafeInteger) || maxAttempts < 1 || maxAttempts > 100 || timeoutMs < 1 || timeoutMs > 30000 || maxRetryMs < 1 || maxRetryMs > 300000) throw new Error('ORIGIN_DISPATCH_CONFIGURATION_INVALID');
  return Object.freeze({
    async runOnce(binding) {
      if (!enabled) return { kind: 'DISABLED' };
      if (!journal || typeof resolveBinding !== 'function' || typeof deliver !== 'function') throw new Error('ORIGIN_DISPATCH_UNAVAILABLE');
      const claim = await journal.claim(binding, { leaseMs: timeoutMs + 5000 });
      if (!claim) return { kind: 'IDLE' };
      const start = performance.now();
      let outcome, timer;
      const controller = new AbortController();
      const deadlineAt = Date.now() + timeoutMs;
      const assertBudget = () => { if (controller.signal.aborted) throw new Error('ORIGIN_DELIVERY_TIMEOUT'); };
      const current = async () => {
        const value = await resolveBinding(binding, { signal: controller.signal, deadlineAt });
        assertBudget();
        return bindingFingerprint(value) === claim.bindingFingerprint;
      };
      const work = async () => {
        if (!await current()) return { type: 'BLOCKED', category: 'BINDING_CHANGED' };
        assertBudget();
        const response = await deliver({ id: claim.id, body: claim.body, binding: { ...binding }, signal: controller.signal, deadlineAt });
        assertBudget();
        if (!await current()) return { type: 'BLOCKED', category: 'BINDING_CHANGED' };
        const status = response?.status;
        if (!Number.isSafeInteger(status) || status < 100 || status > 599) return { type: 'RETRY', category: 'DELIVERY_UNCERTAIN' };
        if (status >= 200 && status < 300) return response.sourceEventId === claim.id && response.durablyAccepted === true
          ? { type: 'DELIVERED', category: 'DURABLE_ACCEPTED', httpStatus: status }
          : { type: 'RETRY', category: 'RECEIPT_UNCONFIRMED', httpStatus: status };
        if (status === 429) return { type: 'RETRY', category: 'RATE_LIMITED', httpStatus: status,
          retryAfterMs: Number.isSafeInteger(response.retryAfterMs) && response.retryAfterMs >= 0 ? Math.min(response.retryAfterMs, maxRetryMs) : undefined };
        if (status >= 300 && status < 500 && status !== 408) return { type: 'BLOCKED', category: status < 400 ? 'REDIRECT_REFUSED' : 'DELIVERY_REJECTED', httpStatus: status };
        return { type: 'RETRY', category: 'DELIVERY_UNCERTAIN', httpStatus: status };
      };
      try {
        if (claim.attempt > maxAttempts) outcome = { type: 'BLOCKED', category: 'RETRY_EXHAUSTED' };
        else {
          const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ORIGIN_DELIVERY_TIMEOUT')); }, timeoutMs); });
          outcome = await Promise.race([work(), timedOut]);
        }
      } catch { outcome = { type: 'RETRY', category: 'DELIVERY_UNCERTAIN' }; }
      finally { clearTimeout(timer); }
      if (outcome.type === 'RETRY') {
        if (claim.attempt >= maxAttempts) outcome = { ...outcome, type: 'BLOCKED', category: 'RETRY_EXHAUSTED' };
        else outcome.retryAfterMs ??= Math.min(1000 * 2 ** Math.min(claim.attempt - 1, 16), maxRetryMs);
      }
      const settled = await journal.finish(claim, { ...outcome, durationMs: Math.min(2147483647, Math.max(0, Math.round(performance.now() - start))) });
      return { kind: settled ? outcome.type : 'STALE', eventId: claim.id };
    },
  });
}
