import { createHash } from 'node:crypto';
import { bindingFingerprint } from './journal.mjs';
import { projectTextBatch } from './projection.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

/** A suppression decision requires an exact row visible through the journal's committed-read port. */
export function createOriginWebhookOwnershipGuard({ env = {}, journal, binding, endpoint, resolveBinding, timeoutMs = 1000, allowInsecureLoopbackForTests = false }) {
  let target, fingerprint;
  const fixed = Object.freeze({ ...binding });
  try {
    fingerprint = bindingFingerprint(fixed); target = new URL(endpoint);
    if (target.username || target.password || target.search || target.hash
      || !/^\/v1\/webhooks\/whatsapp\/[A-Za-z0-9_-]+$/u.test(target.pathname) || target.pathname !== `/v1/webhooks/whatsapp/${fixed.destinationId}`
      || !(target.protocol === 'https:' || (allowInsecureLoopbackForTests === true && target.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname)))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error();
  } catch { throw new Error('ORIGIN_WEBHOOK_CONFIGURATION_INVALID'); }
  const enabled = env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true';
  return Object.freeze({ async decide({ instanceName, event, data, destination }) {
    if (!enabled || event !== 'messages.upsert') return 'DELIVER_LEGACY';
    let currentTarget;
    try { currentTarget = new URL(destination); } catch { throw new Error('ORIGIN_WEBHOOK_DESTINATION_INVALID'); }
    if (currentTarget.href !== target.href) {
      if (currentTarget.origin === target.origin && currentTarget.pathname.startsWith('/v1/webhooks/whatsapp/')) throw new Error('ORIGIN_WEBHOOK_DESTINATION_CHANGED');
      return 'DELIVER_LEGACY';
    }
    if (instanceName !== fixed.instanceName) throw new Error('ORIGIN_WEBHOOK_BINDING_CHANGED');
    const [body] = projectTextBatch(fixed, { 'messages.upsert': { type: 'notify', messages: [data] } });
    if (!body) return 'DELIVER_LEGACY';
    if (typeof journal?.lookupCommittedOwnership !== 'function' || typeof resolveBinding !== 'function') throw new Error('ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE');
    const controller = new AbortController(), deadlineAt = Date.now() + timeoutMs;
    let timer;
    const authority = async () => {
      const current = await resolveBinding(fixed, { signal: controller.signal, deadlineAt });
      if (controller.signal.aborted) throw new Error('ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE');
      if (bindingFingerprint(current) !== fingerprint) throw new Error('ORIGIN_WEBHOOK_BINDING_CHANGED');
    };
    const work = async () => {
      await authority();
      const row = await journal.lookupCommittedOwnership(fixed, body);
      await authority();
      if (row === null) return 'DELIVER_LEGACY';
      const expected = { scopeKey: hash(JSON.stringify([fixed.instanceId,fixed.generation,fixed.destinationId,fixed.revision])), bindingFingerprint: fingerprint,
        eventKey: hash(JSON.stringify([body.data.key.id,body.data.key.fromMe,body.data.key.remoteJid])), bodyHash: hash(JSON.stringify(body)) };
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(row.id)
        || Object.keys(expected).some(key => row[key] !== expected[key])) throw new Error('ORIGIN_WEBHOOK_OWNERSHIP_INVALID');
      return 'SUPPRESS_OWNED';
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE')); }, timeoutMs); })]);
    } catch (error) {
      if (['ORIGIN_WEBHOOK_BINDING_CHANGED','ORIGIN_WEBHOOK_OWNERSHIP_INVALID'].includes(error?.message)) throw error;
      throw new Error('ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  } });
}
