import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectPinnedHttps, type SafeConnectionInput } from '../../src/modules/integrations/chatwoot-safe-http.js';

let server: Server, folder: string, ca: string, port: number;
const observed: { host: string; localAddress: string | undefined }[] = [];
beforeAll(async () => {
  folder = await mkdtemp(resolve(tmpdir(), 'jrc-safe-http-'));
  const winOpenSsl = resolve(process.env.LOCALAPPDATA ?? '', 'Programs/Git/usr/bin/openssl.exe');
  const openssl = process.platform === 'win32' && existsSync(winOpenSsl) ? winOpenSsl : 'openssl';
  // Ephemeral synthetic certificate: no private key is committed or retained after the test.
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(folder, 'key.pem'),
    '-out', resolve(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=chatwoot.transport.test',
    '-addext', 'subjectAltName=DNS:chatwoot.transport.test'], { stdio: 'ignore', timeout: 10000 });
  ca = await readFile(resolve(folder, 'cert.pem'), 'utf8');
  server = createServer({ key: await readFile(resolve(folder, 'key.pem')), cert: ca }, (req, res) => {
    observed.push({ host: req.headers.host ?? '', localAddress: req.socket.localAddress });
    if (req.url === '/slow') return;
    if (req.url === '/invalid-status') { res.writeHead(700); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/large') { res.write('123456789'); res.end('0123456789'); return; }
    res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
}, 20000);
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  if (folder) {
    if (!resolve(folder).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test path');
    await rm(folder, { recursive: true, force: true });
  }
});
function connection(path = '/'): SafeConnectionInput {
  return { target: new URL(`https://chatwoot.transport.test:${port}${path}`),
    // This connector-only fixture uses loopback; the public boundary separately rejects it.
    approvedAddresses: ['127.0.0.1'], servername: 'chatwoot.transport.test', rejectUnauthorized: true,
    method: 'GET', headers: {}, signal: AbortSignal.timeout(2000), maxResponseBytes: 1024 };
}
it('connects only to the supplied IP while verifying TLS against the original hostname', async () => {
  const response = await connectPinnedHttps(connection(), ca);
  expect(await response.json()).toEqual({});
  expect(observed.at(-1)).toEqual({ host: `chatwoot.transport.test:${port}`, localAddress: '127.0.0.1' });
});
it('rejects an untrusted certificate and a mismatched hostname', async () => {
  await expect(connectPinnedHttps(connection())).rejects.toThrow();
  await expect(connectPinnedHttps({ ...connection(), servername: 'other.transport.test' }, ca)).rejects.toThrow();
});
it('bounds chunked bodies and cancels a stalled response', async () => {
  await expect(connectPinnedHttps({ ...connection('/large'), maxResponseBytes: 5 }, ca)).rejects.toThrow('CHATWOOT_RESPONSE_LIMIT');
  await expect(connectPinnedHttps({ ...connection('/slow'), signal: AbortSignal.timeout(50) }, ca)).rejects.toThrow();
});
it('rejects malformed remote status without an uncaught callback exception', async () => {
  await expect(connectPinnedHttps(connection('/invalid-status'), ca)).rejects.toThrow('CHATWOOT_INVALID_RESPONSE');
});
