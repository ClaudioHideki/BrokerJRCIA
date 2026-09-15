import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveE2eScreenshotDirectory,
  SYNTHETIC_PAIRING_HINT,
} from '../apps/web/tests/e2e/artifact-policy.ts';
import playwrightConfig from '../playwright.config.ts';

describe('política de artefatos E2E', () => {
  it('mantém screenshots comuns fora de docs e exige opt-in para evidência versionada', () => {
    const rootDirectory = resolve('synthetic-root');

    expect(resolveE2eScreenshotDirectory(rootDirectory, {}))
      .toBe(resolve(rootDirectory, 'test-results/security-screenshots'));
    expect(resolveE2eScreenshotDirectory(rootDirectory, { JRC_E2E_CAPTURE_DOCS: 'true' }))
      .toBe(resolve(rootDirectory, 'docs/security/phase-1-increment-2/screenshots'));
  });

  it('desabilita traces, screenshots automáticos e vídeo que poderiam persistir segredos', () => {
    expect(playwrightConfig.use).toMatchObject({
      trace: 'off',
      screenshot: 'off',
      video: 'off',
    });
  });

  it('usa um pairing hint inequivocamente sintético no provider falso', () => {
    // Fixture fictícia do intervalo 555-0100–0199, usada apenas pelo adapter falso.
    expect(SYNTHETIC_PAIRING_HINT).toMatch(/^120255501\d{2}$/u);
  });
});
