import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { validateRepositoryBaseline } from '../scripts/check-repository-baseline.mjs';

describe('repository baseline', () => {
  it('contains governance, environment, and architecture files', async () => {
    const result = await validateRepositoryBaseline(process.cwd());
    expect(result.missing).toEqual([]);
    expect(result.forbiddenTrackedFiles).toEqual([]);
  });

  it('contains the complete phase 9 migration chain and one authoritative root manifest', async () => {
    const migrations = (await readdir('apps/api/drizzle/migrations'))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const rootManifests = (await readdir('.'))
      .filter((name) => /manifest.*sha256|sha256.*manifest/iu.test(name))
      .sort();

    expect(migrations.slice(-5)).toEqual([

      '0027_automation_integrations.sql',
      '0028_operational_observability.sql',
      '0029_legacy_flow_migration.sql',
      '0030_instance_archive.sql',
      '0031_economic_groups.sql',
    ]);
    expect(rootManifests).toEqual(['MANIFESTO_ARQUIVOS_SHA256.txt']);
  });
});
