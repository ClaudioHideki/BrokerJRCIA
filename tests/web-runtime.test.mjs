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
