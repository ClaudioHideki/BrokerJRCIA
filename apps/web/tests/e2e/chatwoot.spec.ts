import { test, expect } from '@playwright/test';
import { signIn } from './helpers.js';

test('persists a pending destination without requesting a token and isolates the other company', async ({ page }) => {
  await signIn(page);
  await page.goto('/integracoes');
  await page.getByLabel('Endereço do Chatwoot').fill('https://support-fixture.example.com');
  await page.getByRole('button', { name: 'Solicitar destino' }).click();
  await expect(page.getByText('Aguardando aprovação da equipe JRC.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Token de acesso do JRC Conversas')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Aguardando aprovação da equipe JRC.', { exact: false })).toBeVisible();
  await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Filial' });
  await expect(page.getByText('Aguardando aprovação da equipe JRC.', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Endereço do Chatwoot')).toHaveValue('');
  await page.getByLabel('Organização ativa').selectOption({ label: 'JRC E2E Matriz' });
  await expect(page.getByLabel('Endereço do Chatwoot')).toHaveValue('https://support-fixture.example.com');
});
