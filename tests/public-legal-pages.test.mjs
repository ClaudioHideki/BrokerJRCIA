import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../infra/web/server.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jrc-legal-'));
  cleanups.push(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'index.html'), '<title>Console fixture</title>');
  const server = createWebServer({ root, apiOrigin: 'http://127.0.0.1:1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  return { root, origin: `http://127.0.0.1:${server.address().port}` };
}
it('serves complete public documents without authentication, API or JavaScript', async () => {
  const { root, origin } = await fixture();
  await mkdir(join(root, 'legal'));
  for (const slug of ['privacy', 'data-deletion', 'terms']) {
    const html = await readFile(new URL(`../apps/web/public/legal/${slug}.html`, import.meta.url), 'utf8');
    await writeFile(join(root, 'legal', `${slug}.html`), html);
    for (const suffix of ['', '/', '?utm_source=meta']) {
      const response = await fetch(`${origin}/${slug}${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body).toContain('29.597.360/0001-02');
      expect(body).toContain('mailto:aamaxt@gmail.com');
      expect(body).toContain('<main');
      expect(body).not.toMatch(/<script|Console fixture|<form/i);
      for (const route of ['/privacy', '/data-deletion', '/terms']) expect(body).toContain(`href="${route}"`);
    }
    const head = await fetch(`${origin}/${slug}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${origin}/${slug}`, { method: 'POST' })).status).toBe(405);
  }
});
it('does not disguise an absent public document as a successful SPA page', async () => {
  const { origin } = await fixture();
  for (const route of ['/privacy', '/data-deletion', '/terms']) {
    const response = await fetch(origin + route);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Console fixture');
  }
  expect(await (await fetch(origin + '/login')).text()).toContain('Console fixture');
});
