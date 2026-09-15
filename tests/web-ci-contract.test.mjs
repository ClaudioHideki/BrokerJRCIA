import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('pipeline da console web', () => {
  it('executa build, inspeção do bundle, testes web e E2E com Chromium', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const playwrightConfig = await readFile('playwright.config.ts', 'utf8');

    expect(workflow).toContain('name: JRC Broker CI');
    expect(workflow).toContain('run: npm run build:web');
    expect(workflow).toContain('run: npm run test:web');
    expect(workflow).toContain('run: npm run test:web:bundle');
    expect(workflow).toContain('run: npx playwright install --with-deps chromium');
    expect(workflow).toContain('run: npm run test:e2e');
    expect(packageJson.scripts['test:web:bundle']).toBe(
      'node scripts/security/check-web-bundle.mjs apps/web/dist',
    );
    expect(packageJson.scripts['test:e2e']).toBe('npm run build:web && playwright test');
    expect(playwrightConfig).toContain('npm --workspace @jrc/web run preview');
    expect(playwrightConfig).not.toContain('npm --workspace @jrc/web run dev');
    expect(packageJson.scripts['ci:verify']).toContain('npm run test:web:bundle');
    expect(packageJson.scripts['ci:verify']).toContain('npm run test:web');
    expect(packageJson.scripts['ci:verify']).toContain('npm run test:e2e');
    expect(packageJson.scripts['ci:verify']).toContain(
      '--tag jrc-whatsapp-broker:phase-1-increment-2',
    );
    expect(workflow).toContain('git diff --exit-code -- docs/security/phase-1-increment-2');
    expect(workflow).toContain('npm run security:release');
    expect(workflow).not.toContain('npm run security:audit:generate');
    expect(packageJson.scripts['ci:verify']).toContain('npm run security:release');
    expect(packageJson.scripts['ci:verify']).not.toContain('npm run security:audit:generate');
    expect(packageJson.scripts['ci:verify']).toContain(
      'git diff --exit-code -- docs/security/phase-1-increment-2',
    );
    expect(workflow).not.toContain('git diff --exit-code -- docs/security/phase-1-increment-1');
    expect(packageJson.scripts['ci:verify']).not.toContain(
      'git diff --exit-code -- docs/security/phase-1-increment-1',
    );
  });

  it('obtém os submódulos verificados também no workflow de imagens', async()=>{
    const workflow=await readFile('.github/workflows/images.yml','utf8');
    expect(workflow).toContain('submodules: recursive');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('npm run security:submodule');
  });

  it('preserva o segredo administrativo da auditoria sem fallback', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain(
      'AUDIT_FINGERPRINT_SECRET: ${{ secrets.AUDIT_FINGERPRINT_SECRET }}',
    );
    expect(workflow).not.toMatch(/AUDIT_FINGERPRINT_SECRET[^\n]*(?:\|\||:-)/);
  });
});
