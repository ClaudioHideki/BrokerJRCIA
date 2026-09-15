import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_DISTRIBUTED_PACKAGES,
  assertBundledNoticeMatches,
  verifyThirdPartyNotices,
} from '../scripts/security/check-third-party-notices.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('avisos das dependências distribuídas no navegador', () => {
  it('mantém inventário explícito da árvore de produção da console', () => {
    expect(BROWSER_DISTRIBUTED_PACKAGES).toEqual([
      'cookie',
      'react',
      'react-dom',
      'react-router',
      'scheduler',
      'set-cookie-parser',
      'zod',
    ]);
  });

  it('inclui versão e texto integral da licença instalada no asset distribuído', async () => {
    await expect(verifyThirdPartyNotices(ROOT, { verifyBundle: false }))
      .resolves.toEqual({ packageCount: 7 });
  });

  it('rejeita bundle sem o aviso integral', () => {
    expect(() => assertBundledNoticeMatches('notice', 'notice')).not.toThrow();
    expect(() => assertBundledNoticeMatches('notice', 'truncated'))
      .toThrow('Bundled third-party notice differs from its source');
  });

  it('mantém o gate de cópia no CI depois do build', async () => {
    const [source, packageJson, workflow] = await Promise.all([
      readFile(resolve(ROOT, 'apps/web/public/THIRD_PARTY_NOTICES.txt'), 'utf8'),
      readFile(resolve(ROOT, 'package.json'), 'utf8'),
      readFile(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    ]);
    expect(source).toContain('BEGIN PACKAGE react@19.2.8 (MIT)');
    expect(JSON.parse(packageJson).scripts['security:notices'])
      .toBe('node scripts/security/check-third-party-notices.mjs');
    expect(workflow).toContain('npm run security:notices');
    expect(workflow.indexOf('npm run build')).toBeLessThan(workflow.indexOf('npm run security:notices'));
  });
});
