import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Node type definitions', () => {
  it('fixa @types/node na linha 24 compatível com o runtime obrigatório', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const version = packageJson.devDependencies['@types/node'];

    expect(version).toMatch(/^24\.\d+\.\d+$/);
  });
});
