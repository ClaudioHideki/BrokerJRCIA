import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { normalizeChatwootOrigin } from './chatwoot-destination.js';

// Conservative special-purpose exclusions, based on the IANA IPv4/IPv6 registries.
// Some special-purpose ranges have global exceptions; none are Chatwoot destinations.
const prohibited = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) prohibited.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['2620:4f:8000::', 48]] as const)
  prohibited.addSubnet(ip, bits, 'ipv6');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');

export function assertPublicAddresses(addresses: readonly string[]): void {
  if (!addresses.length || addresses.some(ip => {
    const family = isIP(ip);
    if (!family || ip.includes('%')) return true;
    return family === 4 ? prohibited.check(ip, 'ipv4')
      : !publicV6.check(ip, 'ipv6') || prohibited.check(ip, 'ipv6');
  })) throw new Error('CHATWOOT_UNSAFE_ADDRESS');
}

export interface SafeConnectionInput {
  target: URL;
  approvedAddresses: readonly string[];
  servername: string;
  rejectUnauthorized: true;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array | undefined;
  signal: AbortSignal;
  maxResponseBytes: number;
}

/** Actual socket connector. ca is an explicit dependency used by local TLS contract tests. */
export function connectPinnedHttps(input: SafeConnectionInput, ca?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const address = input.approvedAddresses[0];
    if (!address || !isIP(address)) { reject(new Error('CHATWOOT_UNSAFE_ADDRESS')); return; }
    const family = isIP(address) as 4 | 6;
    // node:https uses this lookup for the socket itself: no second DNS lookup or pooled socket.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const req = httpsRequest(input.target, {
      method: input.method, headers: input.headers, agent: false, family,
      lookup: pinnedLookup, servername: input.servername, rejectUnauthorized: true,
      signal: input.signal, ...(ca ? { ca } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('CHATWOOT_RESPONSE_INTERRUPTED')));
      const encodedLength = Number(res.headers['content-length']);
      if (encodedLength > input.maxResponseBytes ||
        (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        req.destroy(new Error('CHATWOOT_RESPONSE_LIMIT')); return;
      }
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.maxResponseBytes) { req.destroy(new Error('CHATWOOT_RESPONSE_LIMIT')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const status = res.statusCode ?? 502;
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          resolve(new Response(input.method === 'HEAD' || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        } catch {
          reject(new Error('CHATWOOT_INVALID_RESPONSE'));
        }
      });
    });
    req.on('error', reject);
    req.end(input.body);
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createChatwootSafeFetch(options: {
  origin: string;
  mediaOrigins?: readonly string[] | undefined;
  resolve?: ((hostname: string) => Promise<readonly string[]>) | undefined;
  connect?: ((input: SafeConnectionInput) => Promise<Response>) | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): typeof globalThis.fetch {
  const origin = normalizeChatwootOrigin(options.origin);
  const allowed = new Set([origin, ...(options.mediaOrigins ?? []).map(normalizeChatwootOrigin)]);
  const resolveAddresses = options.resolve ?? (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(x => x.address));
  const connect = options.connect ?? connectPinnedHttps;
  return async (input, init) => {
    const req = new Request(input, init);
    const target = new URL(req.url);
    if (!allowed.has(target.origin) || target.username || target.password || target.hash)
      throw new Error('CHATWOOT_ORIGIN_NOT_APPROVED');
    const headers = new Headers(req.headers);
    if (target.origin !== origin && ['api_access_token', 'authorization', 'cookie'].some(name => headers.has(name)))
      throw new Error('CHATWOOT_CREDENTIAL_ORIGIN_MISMATCH');
    headers.delete('host');
    headers.set('accept-encoding', 'identity');
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(options.timeoutMs ?? 15000)]);
    let body: Uint8Array | undefined;
    if (req.body) {
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 18 * 1024 * 1024) throw new Error('CHATWOOT_REQUEST_LIMIT');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      body = Buffer.concat(chunks);
    }
    const approvedAddresses = Object.freeze([...(await abortable(resolveAddresses(target.hostname), signal))]);
    assertPublicAddresses(approvedAddresses);
    const response = await abortable(connect({ target, approvedAddresses, servername: target.hostname,
      rejectUnauthorized: true, headers: Object.fromEntries(headers), method: req.method, body, signal,
      maxResponseBytes: options.maxResponseBytes ?? 16 * 1024 * 1024 }), signal);
    if (response.status >= 300 && response.status < 400 && req.redirect !== 'manual') {
      await response.body?.cancel();
      throw new Error('CHATWOOT_REDIRECT_REJECTED');
    }
    return response;
  };
}
