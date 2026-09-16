import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../infra/web/server.mjs';
const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
it('serves SPA routes, blocks traversal and proxies only API without forged forwarded identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jrc-web-')); cleanups.push(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'index.html'), '<title>JRC</title>');
  let seen;
  const apiOrigin = await listen(createServer((req,res) => { seen=req.headers; res.setHeader('Content-Type','application/json'); res.end('{"ok":true}'); }));
  const origin = await listen(createWebServer({ root, apiOrigin }));
  const home = await fetch(origin+'/');
  expect(home.status).toBe(200);
  expect(home.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  expect(await home.text()).toBe('<title>JRC</title>');
  expect((await fetch(origin+'/jrc')).status).toBe(200);
  expect((await fetch(origin+'/%5c..%5csecret')).status).toBe(404);
  expect((await fetch(origin+'/missing.js')).status).toBe(404);
  expect((await fetch(origin+'/v1/test', {headers: { 'x-forwarded-for': 'spoof', origin:'https://client.example' }})).status).toBe(200);
  expect(seen['x-forwarded-for']).toBeUndefined(); expect(seen.origin).toBe('https://client.example');
});

it('serves only the restricted entry with an uncached per-app policy from the fixed API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jrc-embed-')); cleanups.push(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'index.html'), '<title>Console</title>');
  await writeFile(join(root, 'embed.html'), '<title>Embed</title>');
  const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
  let available = true, seen = [];
  const apiOrigin = await listen(createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (!available) { res.writeHead(403); res.end('{}'); return; }
    res.end(JSON.stringify({ origin: req.url.includes(a) ? 'https://a.example.com' : 'https://b.example.com' }));
  }));
  const origin = await listen(createWebServer({ root, apiOrigin }));
  for (const [id, parent] of [[a, 'a'], [b, 'b']]) {
    const response = await fetch(`${origin}/embed/chatwoot/${id}`, { headers: { cookie: 'must-not-relay=fixture', authorization: 'Bearer fixture' } });
    expect(response.status).toBe(200); expect(await response.text()).toBe('<title>Embed</title>');
    expect(response.headers.get('content-security-policy')).toContain(`frame-ancestors https://${parent}.example.com`);
    expect(response.headers.has('x-frame-options')).toBe(false); expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(seen.map(r => r.url)).toEqual([`/v1/embed/apps/${a}/policy`, `/v1/embed/apps/${b}/policy`]);
  expect(seen.every(r => !r.headers.cookie && !r.headers.authorization)).toBe(true);
  for (const path of ['/jrc', '/login', '/dashboard', '/embed/authorize']) {
    const response = await fetch(origin + path);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  }
  available = false;
  const revoked = await fetch(`${origin}/embed/chatwoot/${a}`);
  expect(revoked.status).toBe(403); expect(revoked.headers.get('x-frame-options')).toBe('DENY');
  expect(await revoked.text()).not.toContain('<title>Embed</title>');
  expect((await fetch(`${origin}/embed/chatwoot/${a}?origin=https://evil.example`)).status).toBe(403);
  expect((await fetch(`${origin}/embed/chatwoot/not-an-id`)).status).toBe(403);
});

it('fails closed on redirected, oversized, malformed or unavailable policy responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jrc-embed-')); cleanups.push(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'embed.html'), '<title>Restricted</title>');
  const id = '00000000-0000-4000-8000-000000000001'; let mode = 'redirect';
  const apiOrigin = await listen(createServer((_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1' }); res.end(); }
    else if (mode === 'large') res.end('x'.repeat(9000));
    else if (mode === 'origin') res.end(JSON.stringify({ origin: 'https://*.example.com' }));
    else if (mode === 'schema') res.end(JSON.stringify({ origin: 'https://a.example.com', accountId: 7 }));
    else if (mode === 'down') res.destroy();
    else if (mode === 'timeout') { /* The production web server must bound this request. */ }
    else res.end('broken');
  }));
  const origin = await listen(createWebServer({ root, apiOrigin }));
  for (mode of ['redirect', 'large', 'origin', 'schema', 'down', 'malformed', 'timeout']) {
    const response = await fetch(`${origin}/embed/chatwoot/${id}`);
    expect(response.status).toBe(403); expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});
