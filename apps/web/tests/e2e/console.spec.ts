import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { expectNoAutomaticAccessibilityViolations, signIn } from './helpers.js';
import {
  resolveE2eScreenshotDirectory,
  SYNTHETIC_PAIRING_HINT,
} from './artifact-policy.js';

const screenshotDirectory = resolveE2eScreenshotDirectory();

// Real isolated Broker API/PostgreSQL/Redis; BrowserE2eFakeProvider supplies QR
// and connection status. This suite does not homologate LAB2 or WhatsApp.
test.describe('jornadas da console JRC com API isolada e provider sintético', () => {

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

  test('cria, lista, conecta por QR e pairing, acompanha status e desconecta', async ({ page }, testInfo) => {
    await signIn(page);
    const firstName = `E2E QR sintética ${testInfo.project.name}`;
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

    const secondName = `E2E Pairing sintética ${testInfo.project.name}`;
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

  test('emite, revela uma vez e revoga API key sem capturar o segredo', async ({ page, isMobile }, testInfo) => {
    await signIn(page);
    const navigation = page.getByRole('navigation', { name: 'Navegação principal', exact: true });
    if (isMobile) {
      await expect(navigation).not.toBeVisible();
      const menu = page.getByRole('button', { name: 'Abrir navegação', exact: true });
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await expect(page.getByRole('button', { name: 'Fechar navegação', exact: true })).toHaveAttribute('aria-expanded', 'true');
    }
    await expect(navigation).toBeVisible();
    await navigation.getByRole('link', { name: 'Chaves de API', exact: true }).click();
    await expect(page).toHaveURL(/\/chaves-api$/u);
    if (isMobile) {
      await expect(navigation).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Abrir navegação', exact: true })).toHaveAttribute('aria-expanded', 'false');
    }
    const keyName = `E2E automação sintética ${testInfo.project.name}`;
    await page.getByLabel('Nome da chave').fill(keyName);
    await page.getByLabel('Ler conexões').check();
    await page.getByRole('button', { name: 'Emitir chave' }).click();
    await expect(page.getByRole('dialog', { name: 'Chave emitida' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('dialog', { name: 'Chave emitida' })).not.toBeVisible();

    const issuedKey = page.getByRole('listitem').filter({ has: page.getByText(keyName, { exact: true }) });
    await expect(issuedKey).toContainText('Ativa');
    page.once('dialog', (dialog) => void dialog.accept());
    await issuedKey.getByRole('button', { name: 'Revogar', exact: true }).click();
    await page.reload();
    await expect(issuedKey.getByText('Revogada', { exact: true })).toBeVisible();
    await expect(issuedKey.getByRole('button', { name: 'Revogar', exact: true })).toHaveCount(0);

    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotDirectory, `console-${testInfo.project.name}-api-keys-sanitizada.png`),
      fullPage: true,
      mask: [page.locator('.identity-summary span'), page.locator('.api-key-list code')],
      maskColor: '#CBD5E1',
      // Inline code can wrap outside its first mask box on a narrow screen.
      // Hide every public-prefix glyph during capture; assertions run unchanged.
      style: '.api-key-list code { visibility: hidden !important; }',
    });
    await expectNoAutomaticAccessibilityViolations(page);
  });
});

test('shell mobile é navegável por teclado e captura apenas dados sintéticos', async ({ page, isMobile }) => {
  test.skip(isMobile !== true);
  await signIn(page);
  await page.getByRole('button', { name: 'Abrir navegação' }).focus();
  await page.keyboard.press('Enter');
  const navigation = page.getByRole('navigation', { name: 'Navegação principal', exact: true });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Dashboard', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(navigation.getByRole('button', { name: 'Seção Atendimento', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(navigation.getByRole('link', { name: 'Conexões e caixas', exact: true })).toBeFocused();
  await expectNoAutomaticAccessibilityViolations(page);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, 'console-mobile-conexoes-sanitizada.png'),
    fullPage: true,
    mask: [page.locator('.identity-summary span')],
    maskColor: '#CBD5E1',
  });
});
