import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { bindingFingerprint } from './journal.mjs';

/** Fixed trusted host configuration only; event data can never choose the network destination. */
export function createOriginHttpTransport({ endpoint, binding, bearerToken, timeoutMs = 10000, maxResponseBytes = 16384, allowInsecureLoopbackForTests = false }) {
  let target, fingerprint;
  try {
    target = new URL(endpoint); fingerprint = bindingFingerprint(binding);
    if (target.username || target.password || target.search || target.hash
      || !/^\/v1\/webhooks\/whatsapp\/[A-Za-z0-9_-]+$/u.test(target.pathname)
      || target.pathname.split('/').at(-1) !== binding.destinationId
      || !(target.protocol === 'https:' || (allowInsecureLoopbackForTests === true && target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)))
      || typeof bearerToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(bearerToken)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 65536) throw new Error();
  } catch { throw new Error('ORIGIN_TRANSPORT_CONFIGURATION_INVALID'); }
  const fixedTarget = target.href;
  return async ({ id, body, binding: current, signal, deadlineAt }) => {
    try { if (bindingFingerprint(current) !== fingerprint) throw new Error(); }
    catch { throw new Error('ORIGIN_TRANSPORT_BINDING_CHANGED'); }
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) throw new Error('ORIGIN_TRANSPORT_INPUT_INVALID');
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > 65536) throw new Error(); }
    catch { throw new Error('ORIGIN_TRANSPORT_INPUT_INVALID'); }
    const remaining = deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) throw new Error('ORIGIN_TRANSPORT_FAILED');
    return new Promise((resolve, reject) => {
      let timer, req;
      const finish = (error, result) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(new Error('ORIGIN_TRANSPORT_FAILED')); else resolve(result);
      };
      const abort = () => req?.destroy(new Error('ORIGIN_TRANSPORT_FAILED'));
      try {
        req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(fixedTarget, {
          method: 'POST', agent: false, headers: {
            authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json', 'content-length': bytes.length,
            'x-jrc-origin-event-id': id, 'x-jrc-origin-content-sha256': createHash('sha256').update(bytes).digest('hex'),
          },
        }, res => {
          let size = 0; const chunks = [];
          res.on('data', chunk => { size += chunk.length; if (size > maxResponseBytes) req.destroy(); else chunks.push(chunk); });
          res.on('error', () => finish(true));
          res.on('end', () => {
            if (size > maxResponseBytes) return finish(true);
            const result = { status: res.statusCode };
            const retry = res.headers['retry-after'];
            if (typeof retry === 'string') {
              const value = /^\d+$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
              if (Number.isFinite(value)) result.retryAfterMs = Math.min(300000, Math.max(0, Math.round(value)));
            }
            try {
              const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (receipt.sourceEventId === id && receipt.durablyAccepted === true && ['accepted', 'duplicate'].includes(receipt.status)) {
                result.sourceEventId = id; result.durablyAccepted = true;
              }
            } catch { /* An unconfirmed receipt stays recoverable in the dispatcher. */ }
            finish(false, result);
          });
        });
        req.on('error', () => finish(true));
        timer = setTimeout(abort, remaining);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else req.end(bytes);
      } catch { req?.destroy(); finish(true); }
    });
  };
}
