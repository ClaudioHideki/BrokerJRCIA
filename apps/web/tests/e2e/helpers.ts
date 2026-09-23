import { createRequire } from 'node:module';

import { expect, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);

export function requiredSyntheticCredential(name: 'JRC_E2E_EMAIL' | 'JRC_E2E_PASSWORD'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be supplied by the isolated E2E runtime`);
  return value;
}

export async function signIn(page: Page, organizationName = 'JRC E2E Matriz'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(requiredSyntheticCredential('JRC_E2E_EMAIL'));
  await page.getByLabel('Senha').fill(requiredSyntheticCredential('JRC_E2E_PASSWORD'));
  await page.getByRole('button', { name: 'Entrar' }).click();
  const organization = page.getByRole('listitem').filter({ hasText: organizationName });
  await organization.getByRole('button', { name: `Acessar ${organizationName}` }).click();
  await expect(page.getByRole('heading', { name: 'Caixas de entrada' })).toBeVisible();
  // The connection lifecycle scenarios intentionally exercise the preserved
  // legacy console while /channels is the canonical post-login destination.
  await page.goto('/legacy/conexoes');
  await expect(page.getByRole('heading', { name: 'Conexões' })).toBeVisible();
}

export async function expectNoAutomaticAccessibilityViolations(page: Page): Promise<void> {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as {
      axe: { run(): Promise<{ violations: Array<{ id: string; impact: string | null; nodes:Array<{target:string[];failureSummary?:string}> }> }> };
    }).axe;
    return (await axe.run()).violations.map(({ id, impact, nodes }) => ({ id, impact, nodes:nodes.map(({target,failureSummary})=>({target,failureSummary})) }));
  });
  expect(violations).toEqual([]);
}
