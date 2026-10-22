import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../infra/web/server.mjs';
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jrc-docs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'documentation'));
  await writeFile(join(root, 'index.html'), '<title>Console JRC</title>');
  const server = createWebServer({ root, apiOrigin: 'http://127.0.0.1:1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  return { root, origin: `http://127.0.0.1:${server.address().port}` };
}
it('serves documentation independently from the SPA and API, including HEAD', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'documentation/index.html'), '<title>API JRC</title>');
  for (const route of ['/documentation', '/documentation/']) {
    const response = await fetch(f.origin + route);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<title>API JRC</title>');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  }
  const head = await fetch(f.origin + '/documentation/', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
});
it('never falls back to the console for missing documentation', async () => {
  const f = await fixture();
  expect((await fetch(f.origin + '/documentation/')).status).toBe(503);
  const missing = await fetch(f.origin + '/documentation/nonexistent');
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain('Console JRC');
});
it('serves JSON contracts with the correct MIME and denies undocumented files', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'documentation/openapi-instances.json'), '{"openapi":"3.0.3"}');
  await writeFile(join(f.root, 'documentation/private.txt'), 'not public');
  const response = await fetch(f.origin + '/documentation/openapi-instances.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect((await response.json()).openapi).toBe('3.0.3');
  expect((await fetch(f.origin + '/documentation/private.txt')).status).toBe(404);
  expect((await fetch(f.origin + '/documentation/%5csecret')).status).toBe(404);
});
it('serves the integration PDF with its binary MIME independently of the API', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'documentation/guia-api-jrc.pdf'), '%PDF-1.4\nfixture');
  const response = await fetch(f.origin + '/documentation/guia-api-jrc.pdf');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(await response.text()).toContain('%PDF-');
  expect((await fetch(f.origin + '/documentation/guia-api-jrc.pdf?token=no')).status).toBe(404);
});
