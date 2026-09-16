import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { sanitizeEmbedDiagnostic } from '../../../../packages/contracts/src/integrations/embed.js';
import { createWebServer } from '../../../../infra/web/server.mjs';
import { createEmbedAuthFixture, embedBrokerOrigin as broker, embedParentOrigin as parent } from './embed-auth-fixture.js';

let fixture: Awaited<ReturnType<typeof createEmbedAuthFixture>>, web: Server, origin: string;
test.beforeAll(async () => {
  fixture = await createEmbedAuthFixture();
  web = createWebServer({ root: resolve('apps/web/dist'), apiOrigin: fixture.apiOrigin });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (web) await new Promise<void>(resolve => web.close(() => resolve())); await fixture?.close(); });
test.beforeEach(async () => { await fixture.reset(); });

async function lab(context: BrowserContext, page: Page) {
  const requests: { url: string; headers: Record<string, string> }[] = [], diagnostics: ReturnType<typeof sanitizeEmbedDiagnostic>[] = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true });
  await context.addCookies([{ name: 'embed_cookie_probe', value: 'synthetic-probe', url: broker, secure: true, sameSite: 'None' }]);
  await context.route('https://**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === broker) {
      const headers = await request.allHeaders(); requests.push({ url: request.url(), headers });
      const reply = await fetch(origin + url.pathname + url.search, { method: request.method(), headers, redirect: 'manual',
        ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}) });
      const responseHeaders = Object.fromEntries(reply.headers);
      const cookies = reply.headers.getSetCookie(); if (cookies.length) responseHeaders['set-cookie'] = cookies.join('\n');
      const body = Buffer.from(await reply.arrayBuffer());
      if (url.pathname.startsWith('/v1/')) {
        const code = reply.status >= 400 ? JSON.parse(body.toString()).code : undefined;
        diagnostics.push(sanitizeEmbedDiagnostic({ requestId: reply.headers.get('x-request-id'), status: reply.status, code }));
      }
      await route.fulfill({ status: reply.status, headers: responseHeaders, body });
    } else if (url.origin === parent) {
      await route.fulfill({ contentType: 'text/html', body: `<html><title>Chatwoot sintético</title><iframe title="JRC" src="${broker}/embed/chatwoot/${fixture.embedId}"></iframe><script>window.received=[];window.addEventListener('message',e=>window.received.push(e.data));</script></html>` });
    } else await route.abort();
  });
  await page.goto(parent);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: 'Autorizar acesso no Broker' })).toBeEnabled();
  return { frame, requests, diagnostics };
}
async function login(popup: Page, company = 'Embed Laboratório') {
  await expect(popup).toHaveURL(/\/embed\/authorize\?requestId=/);
  await popup.getByLabel('E-mail').fill(fixture.email); await popup.getByLabel('Senha', { exact: true }).fill(fixture.password);
  await popup.getByRole('button', { name: 'Entrar', exact: true }).click();
  await popup.getByRole('button', { name: `Acessar ${company}` }).click();
  await expect(popup.getByRole('heading', { name: 'Autorizar painel do Chatwoot' })).toBeVisible();
}
async function loginAndApprove(popup: Page) {
  await login(popup);
  await popup.getByRole('checkbox', { name: /Atendimento sintético/ }).check();
  await popup.getByRole('button', { name: 'Autorizar por 5 minutos' }).click();
  await expect(popup.getByText(/Autorização concedida/)).toBeVisible();
}
test('first-party login authorizes with third-party cookies blocked, then revocation removes the challenge', async ({ context, page }) => {
  const { frame, requests, diagnostics } = await lab(context, page);
  const runtime = await page.frames().find(f => f.url().includes('/embed/chatwoot/'))!.evaluate(async () => {
    try {
      const data = crypto.getRandomValues(new Uint8Array(32));
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(btoa(String.fromCharCode(...data))));
      AbortSignal.any([new AbortController().signal, AbortSignal.timeout(1000)]);
      return { secure: isSecureContext, crypto: true };
    } catch (error) { return { secure: isSecureContext, crypto: false, error: String(error) }; }
  });
  expect(runtime).toEqual({ secure: true, crypto: true });
  const initial = await fixture.countSessions();
  const nextPage = context.waitForEvent('page'); await frame.getByRole('button', { name: 'Autorizar acesso no Broker' }).click();
  try { await expect(frame.getByRole('status')).toContainText('Conclua'); }
  catch { throw new Error(`Authorization start failed: ${JSON.stringify(diagnostics)}`); }
  const popup = await nextPage; await loginAndApprove(popup);
  await expect(frame.getByRole('button', { name: 'Reconectar WhatsApp' })).toBeEnabled();
  await expect.poll(() => fixture.countSessions()).toBe(initial + 1);
  await frame.getByRole('button', { name: 'Reconectar WhatsApp' }).click();
  await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toBeVisible();
  expect(requests.filter(r => r.url.includes('/v1/embed/') && !/\/approve$|\/deny$|\/authorizations\/[^/]+$/.test(r.url)).every(r => !r.headers.cookie)).toBe(true);
  const embedded = page.frames().find(f => f.url().includes('/embed/chatwoot/'))!;
  expect(await embedded.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/SYNTHETIC-PAIR-ONLY|Bearer/);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { received: unknown[] }).received))).not.toMatch(/SYNTHETIC-PAIR-ONLY|Bearer/);
  await fixture.revoke(); await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toHaveCount(0);
  await expect(frame.getByRole('status')).toContainText('Acesso indisponível');
});
test('blocked popup offers an ordinary first-party authorization link', async ({ context, page }) => {
  const { frame } = await lab(context, page);
  const embedded = page.frames().find(f => f.url().includes('/embed/chatwoot/'))!;
  await embedded.evaluate(() => { window.open = () => null; });
  await frame.getByRole('button', { name: 'Autorizar acesso no Broker' }).click();
  const link = frame.getByRole('link', { name: 'Abrir autorização no portal' });
  await expect(link).toHaveAttribute('href', /^\/embed\/authorize\?requestId=[0-9a-f-]+$/);
  const nextPage = context.waitForEvent('page'); await link.click(); await loginAndApprove(await nextPage);
  await expect(frame.getByRole('button', { name: 'Reconectar WhatsApp' })).toBeEnabled();
});
test('forged agent context cannot authorize and changing the account clears authorized pairing', async ({ context, page }) => {
  const { frame } = await lab(context, page), initial = await fixture.countSessions();
  const send = (accountId: number) => page.evaluate(({ broker, accountId }) => {
    document.querySelector('iframe')!.contentWindow!.postMessage(JSON.stringify({ event: 'appContext', data: {
      conversation: { id: 10, inbox_id: 31, account_id: accountId }, currentAgent: { role: 'administrator', id: 1 },
    } }), broker);
  }, { broker, accountId });
  await send(1); expect(await fixture.countSessions()).toBe(initial);
  await expect(frame.getByRole('button', { name: 'Reconectar WhatsApp' })).toHaveCount(0);
  const nextPage = context.waitForEvent('page'); await frame.getByRole('button', { name: 'Autorizar acesso no Broker' }).click();
  await loginAndApprove(await nextPage); await frame.getByRole('button', { name: 'Reconectar WhatsApp' }).click();
  await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toBeVisible(); await send(2);
  await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toHaveCount(0);
  await expect(frame.getByRole('status')).toContainText('Acesso indisponível');
});
test('session expiry clears pairing in the browser without logging out the WhatsApp session', async ({ context, page }) => {
  await page.clock.install();
  const { frame } = await lab(context, page);
  const nextPage = context.waitForEvent('page'); await frame.getByRole('button', { name: 'Autorizar acesso no Broker' }).click();
  await loginAndApprove(await nextPage); await frame.getByRole('button', { name: 'Reconectar WhatsApp' }).click();
  await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toBeVisible();
  const before = fixture.pairCalls;
  await page.clock.fastForward(301000);
  await expect(frame.getByText('SYNTHETIC-PAIR-ONLY')).toHaveCount(0);
  await expect(frame.getByRole('status')).toContainText('expirou');
  expect(fixture.pairCalls).toBe(before);
});
test('another company, unknown request and expired request cannot authorize the frame', async ({ context, page }) => {
  const { frame } = await lab(context, page), initial = await fixture.countSessions();
  const nextPage = context.waitForEvent('page'); await frame.getByRole('button', { name: 'Autorizar acesso no Broker' }).click();
  const popup = await nextPage; await login(popup, 'Outra empresa');
  await expect(popup.getByRole('alert')).toContainText('Solicitação indisponível');
  await expect(popup.getByRole('button', { name: 'Autorizar por 5 minutos' })).toHaveCount(0);
  await popup.goto(`${broker}/embed/authorize?requestId=00000000-0000-4000-8000-000000000099`);
  await expect(popup.getByRole('alert')).toContainText('Solicitação indisponível');
  await fixture.expireRequests();
  await expect(frame.getByRole('status')).toContainText('Acesso indisponível');
  expect(await fixture.countSessions()).toBe(initial);
});
