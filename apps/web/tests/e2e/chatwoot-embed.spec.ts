import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { test, expect, type BrowserContext } from '@playwright/test';
import { createWebServer } from '../../../../infra/web/server.mjs';

const embedId = '00000000-0000-4000-8000-000000000001';
const brokerOrigin = 'https://broker.example.test', parentOrigin = 'https://chatwoot.example.test';
let server: Server, api: Server, webOrigin: string, enabled = true;
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test.beforeAll(async () => {
  api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (enabled && req.url === `/v1/embed/apps/${embedId}/policy`) res.end(JSON.stringify({ origin: parentOrigin }));
    else { res.writeHead(404); res.end('{}'); }
  });
  const apiOrigin = await listen(api);
  server = createWebServer({ root: resolve('apps/web/dist'), apiOrigin });
  webOrigin = await listen(server);
});
test.afterAll(async () => {
  for (const resource of [server, api]) await new Promise<void>(resolve => resource.close(() => resolve()));
});
test.beforeEach(() => { enabled = true; });

async function routeLab(context: BrowserContext, path = `/embed/chatwoot/${embedId}`) {
  // The browser uses distinct HTTPS origins. Every Broker response and CSP comes
  // from the actual final web server, with a synthetic policy-only API behind it.
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === brokerOrigin) {
      const reply = await fetch(webOrigin + url.pathname + url.search, { redirect: 'manual' });
      await route.fulfill({ status: reply.status, headers: Object.fromEntries(reply.headers), body: Buffer.from(await reply.arrayBuffer()) });
    } else if ([parentOrigin, 'https://other.example.test'].includes(url.origin)) {
      await route.fulfill({ contentType: 'text/html', body: `<html><title>Laboratório Chatwoot</title><iframe title="JRC" src="${brokerOrigin}${path}"></iframe></html>` });
    } else await route.abort();
  });
}
test('allows only the approved ancestor and serves the restricted entry', async ({ page, context }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await routeLab(context); await page.goto(parentOrigin);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Conexões JRC' })).toBeVisible();
  await expect(frame.getByRole('link', { name: 'Abrir portal JRC' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(frame.getByText('Administração JRC', { exact: true })).toHaveCount(0);
  expect(requests.some(url => /\/assets\/App-|\/v1\/console\/auth\//.test(url))).toBe(false);
  const violations: string[] = [];
  page.on('console', message => { if (message.type() === 'error') violations.push(message.text()); });
  await page.goto('https://other.example.test');
  await expect.poll(() => violations.some(v => /frame-ancestors|refused to frame/i.test(v))).toBe(true);
  await expect(frame.getByRole('heading', { name: 'Conexões JRC' })).toHaveCount(0);
});
test('keeps first-party administration, login and authorization outside frames', async ({ page, context }) => {
  for (const path of ['/jrc', '/login', '/dashboard', '/embed/authorize']) {
    await context.unrouteAll(); await routeLab(context, path);
    const violations: string[] = [];
    const listener = (message: { type(): string; text(): string }) => { if (message.type() === 'error') violations.push(message.text()); };
    page.on('console', listener); await page.goto(parentOrigin);
    await expect.poll(() => violations.some(v => /frame-ancestors|refused to frame/i.test(v))).toBe(true);
    page.off('console', listener);
  }
});
test('revocation or disabled policy blocks the next frame load without cached headers', async ({ page, context }) => {
  await routeLab(context); await page.goto(parentOrigin);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Conexões JRC' })).toBeVisible();
  enabled = false;
  const violations: string[] = [];
  page.on('console', message => { if (message.type() === 'error') violations.push(message.text()); });
  await page.reload();
  await expect.poll(() => violations.some(v => /frame-ancestors|refused to frame/i.test(v))).toBe(true);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Conexões JRC' })).toHaveCount(0);
});
