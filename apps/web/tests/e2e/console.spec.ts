import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { expectNoAutomaticAccessibilityViolations, signIn } from './helpers.js';
import {
  resolveE2eScreenshotDirectory,
  SYNTHETIC_PAIRING_HINT,
} from './artifact-policy.js';

const screenshotDirectory = resolveE2eScreenshotDirectory();

test.describe('jornadas reais da console JRC', () => {
  test.skip(({ isMobile }) => isMobile === true);

  test('login, seleção, reload, troca de tenant, expiração e logout', async ({ page, context }) => {
    await signIn(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Conexões' })).toBeVisible();

    await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Filial' });
    await expect(page.getByText('Organização ativa: JRC E2E Filial')).toBeVisible();
    await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Matriz' });
    await expect(page.getByText('Organização ativa: JRC E2E Matriz')).toBeVisible();

    await context.clearCookies();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Acesse sua console' })).toBeVisible();
    await signIn(page);
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page.getByRole('heading', { name: 'Acesse sua console' })).toBeVisible();
  });

  test('cria, lista, conecta por QR e pairing, acompanha status e desconecta', async ({ page }) => {
    await signIn(page);
    const firstName = 'E2E QR sintética';
    await page.getByRole('link', { name: 'Nova conexão' }).click();
    await page.getByLabel('Nome da conexão').fill(firstName);
    await page.getByRole('button', { name: 'Criar conexão' }).click();
    await expect(page.getByRole('heading', { name: firstName })).toBeVisible();
    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeVisible();
    await expect(page.getByText('Conectada')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('link', { name: 'Voltar para conexões' }).click();
    await expect(page.getByRole('link', { name: `${firstName}, ver detalhes` })).toBeVisible();

    await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Filial' });
    await expect(page.getByText('Organização ativa: JRC E2E Filial')).toBeVisible();
    await expect(page.getByRole('link', { name: `${firstName}, ver detalhes` })).not.toBeVisible();
    await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Matriz' });
    await expect(page.getByRole('link', { name: `${firstName}, ver detalhes` })).toBeVisible();

    const secondName = 'E2E Pairing sintética';
    await page.getByRole('link', { name: 'Nova conexão' }).click();
    await page.getByLabel('Nome da conexão').fill(secondName);
    await page.getByRole('button', { name: 'Criar conexão' }).click();
    await page.getByRole('radio', { name: 'Código de pareamento', exact: true }).check();
    await page.getByLabel('Número do WhatsApp', { exact: true }).fill(SYNTHETIC_PAIRING_HINT);
    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('heading', { name: 'Código de pareamento' })).toBeVisible();
    await expect(page.locator('.pairing-code')).toHaveText('1234-5678');
    await expect(page.getByText('Conectada')).toBeVisible({ timeout: 10_000 });

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByText('Desconectada')).toBeVisible();
  });

  test('orienta indisponibilidade sem revelar detalhes internos', async ({ page }) => {
    await signIn(page);
    await page.route(/\/v1\/instances(?:\?.*)?$/, (route) => route.abort('failed'));
    await page.reload();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Não foi possível acessar o serviço');
    await expect(alert).not.toContainText('ECONN');
    await expect(alert).not.toContainText('stack');
  });

  test('emite, revela uma vez e revoga API key sem capturar o segredo', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Chaves de API' }).click();
    await page.getByLabel('Nome da chave').fill('E2E automação sintética');
    await page.getByLabel('Ler conexões').check();
    await page.getByRole('button', { name: 'Emitir chave' }).click();
    await expect(page.getByRole('dialog', { name: 'Chave emitida' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('dialog', { name: 'Chave emitida' })).not.toBeVisible();

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Revogar' }).first().click();
    await page.reload();
    await expect(page.getByText('Revogada')).toBeVisible();

    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotDirectory, 'console-desktop-api-keys-sanitizada.png'),
      fullPage: true,
      mask: [page.locator('.identity-summary span'), page.locator('.api-key-list code')],
      maskColor: '#CBD5E1',
    });
    await expectNoAutomaticAccessibilityViolations(page);
  });
});

test('shell mobile é navegável por teclado e captura apenas dados sintéticos', async ({ page, isMobile }) => {
  test.skip(isMobile !== true);
  await signIn(page);
  await page.getByRole('button', { name: 'Abrir navegação' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Caixas de entrada' })).toBeFocused();
  await expectNoAutomaticAccessibilityViolations(page);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, 'console-mobile-conexoes-sanitizada.png'),
    fullPage: true,
    mask: [page.locator('.identity-summary span')],
    maskColor: '#CBD5E1',
  });
});
