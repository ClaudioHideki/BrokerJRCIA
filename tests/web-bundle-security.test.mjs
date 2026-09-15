import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inspectWebBundle } from '../scripts/security/check-web-bundle.mjs';

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'jrc-web-bundle-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

describe('bundle web de produção', () => {
  it('aceita um bundle estático que usa somente a API JRC relativa', async () => {
    const root = await fixture({
      'index.html': '<script type="module" src="/assets/index.js"></script>',
      'assets/index.js': 'fetch("/v1/instances")',
    });

    await expect(inspectWebBundle(root)).resolves.toMatchObject({ fileCount: 2, findings: [] });
  });

  it.each([
    ['segredo canário', 'window.value="web-secret-canary-27bcef"', ['web-secret-canary-27bcef']],
    ['URL administrativa Evolution', 'fetch("http://evolution:8080/instance")', []],
    ['nome de variável privada', 'const name="EVOLUTION_API_KEY"', []],
  ])('bloqueia %s no artefato compilado', async (_case, content, canaries) => {
    const root = await fixture({
      'index.html': '<script type="module" src="/assets/index.js"></script>',
      'assets/index.js': content,
    });

    const result = await inspectWebBundle(root, { canaries });
    expect(result.findings).not.toEqual([]);
  });
});
