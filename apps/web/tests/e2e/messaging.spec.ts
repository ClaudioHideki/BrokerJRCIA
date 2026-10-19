import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test('Meta e Typebot sintéticos: template, entrega, resposta ordenada e atendimento humano', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/mensagens');
  await expect(page.getByRole('heading', { name: 'Conversas', exact: true })).toBeVisible();
  const selectMeta = () => page.getByLabel('Canal WhatsApp', { exact: true }).selectOption(process.env.JRC_E2E_META_CHANNEL_ID!);
  const historyPanel = page.locator('#history-title').locator('..');
  const refreshHistory = async () => {
    const refresh = page.getByRole('button', { name: 'Atualizar histórico', exact: true });
    await expect(refresh).toBeEnabled();
    const loaded = page.waitForResponse(response => response.request().method() === 'GET' && /\/v1\/messaging\/conversations\/[^/]+\/messages(?:\?|$)/.test(response.url()));
    await refresh.click();
    expect((await loaded).status()).toBe(200);
    await expect(refresh).toBeEnabled();
    return historyPanel.innerText();
  };
  await selectMeta();
  await page.getByLabel('Modelo aprovado').selectOption({ label: 'e2e_boas_vindas · pt_BR' });
  await page.getByLabel('Variável 1', { exact: true }).fill('Cliente sintético');
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && /\/v1\/messaging\/channels\/[^/]+\/messages$/.test(response.url()));
  await page.getByRole('button', { name: 'Enviar template' }).click();
  const sentResponse = await accepted;
  expect(sentResponse.status()).toBe(202);
  const sentMessage = await sentResponse.json() as { id: string };
  await expect.poll(async () => {
    await refreshHistory();
    return page.locator(`[data-message-id="${sentMessage.id}"]`).innerText();
  }).toContain('DELIVERED');
  // Restore BOT because projects share the isolated fixture but run sequentially.
  const resume = page.getByRole('button', { name: 'Retomar bot' });
  // Exercise a slow local resume request before the next provider input.
  await page.route('**/v1/messaging/conversations/*/mode', async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.mode === 'BOT') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  if (await resume.count()) {
    const resumed = page.waitForResponse(response => response.request().method() === 'PATCH'
      && /\/v1\/messaging\/conversations\/[^/]+\/mode$/.test(response.url())
      && response.request().postDataJSON()?.mode === 'BOT');
    await resume.click();
    expect((await resumed).status()).toBe(200);
  }
  await expect(page.getByText('Modo: Bot', { exact: true })).toBeVisible();
  const incomingText = `Olá ${randomUUID()}`;
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '20000000000', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: process.env.JRC_E2E_META_PHONE_ID },
    messages: [{ id: `wamid.${randomUUID()}`, from: '5511999990000', timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: incomingText } }],
  } }] }] });
  const signature = `sha256=${createHmac('sha256', process.env.JRC_E2E_META_SECRET!).update(body).digest('hex')}`;
  const response = await request.post('http://127.0.0.1:3310/v1/webhooks/meta', { data: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } });
  expect(response.status()).toBe(200);
  await expect.poll(refreshHistory).toContain(`Resposta sintética Typebot: ${incomingText}`);
  const history = await historyPanel.innerText();
  expect(history.indexOf(`Resposta sintética Typebot: ${incomingText}`)).toBeLessThan(history.lastIndexOf('Segunda mensagem sintética'));
  await page.getByRole('button', { name: 'Assumir atendimento' }).click();
  await expect(page.getByText('Modo: Atendimento humano')).toBeVisible();
});
