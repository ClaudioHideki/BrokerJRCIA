import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test('Meta e Typebot sintéticos: template, entrega, resposta ordenada e atendimento humano', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/mensagens');
  await expect(page.getByRole('heading', { name: 'Conversas', exact: true })).toBeVisible();
  const selectMeta = () => page.getByLabel('Canal WhatsApp', { exact: true }).selectOption(process.env.JRC_E2E_META_CHANNEL_ID!);
  await selectMeta();
  await page.getByLabel('Modelo aprovado').selectOption({ label: 'e2e_boas_vindas · pt_BR' });
  await page.getByLabel('Variável 1', { exact: true }).fill('Cliente sintético');
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && /\/v1\/messaging\/channels\/[^/]+\/messages$/.test(response.url()));
  await page.getByRole('button', { name: 'Enviar template' }).click();
  const sentResponse = await accepted;
  expect(sentResponse.status()).toBe(202);
  const sentMessage = await sentResponse.json() as { id: string };
  await expect.poll(async () => {
    await page.reload(); await selectMeta();
    return page.locator(`[data-message-id="${sentMessage.id}"]`).innerText();
  }).toContain('DELIVERED');
  // Restore BOT because projects share the isolated fixture but run sequentially.
  const resume = page.getByRole('button', { name: 'Retomar bot' });
  if (await resume.count()) await resume.click();
  const incomingText = `Olá ${randomUUID()}`;
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '20000000000', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: process.env.JRC_E2E_META_PHONE_ID },
    messages: [{ id: `wamid.${randomUUID()}`, from: '5511999990000', timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: incomingText } }],
  } }] }] });
  const signature = `sha256=${createHmac('sha256', process.env.JRC_E2E_META_SECRET!).update(body).digest('hex')}`;
  const response = await request.post('http://127.0.0.1:3310/v1/webhooks/meta', { data: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } });
  expect(response.status()).toBe(200);
  await expect.poll(async () => { await page.reload(); await selectMeta(); return page.locator('#history-title').locator('..').innerText(); }).toContain(`Resposta sintética Typebot: ${incomingText}`);
  const history = await page.locator('#history-title').locator('..').innerText();
  expect(history.indexOf(`Resposta sintética Typebot: ${incomingText}`)).toBeLessThan(history.lastIndexOf('Segunda mensagem sintética'));
  await page.getByRole('button', { name: 'Assumir atendimento' }).click();
  await expect(page.getByText('Modo: Atendimento humano')).toBeVisible();
});
