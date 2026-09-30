import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { validateRepositoryBaseline } from '../scripts/check-repository-baseline.mjs';

describe('repository baseline', () => {
  it('contains governance, environment, and architecture files', async () => {
    const result = await validateRepositoryBaseline(process.cwd());
    expect(result.missing).toEqual([]);
    expect(result.forbiddenTrackedFiles).toEqual([]);
  });

  it('contains the current migration chain and one authoritative root manifest', async () => {
    const migrations = (await readdir('apps/api/drizzle/migrations'))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const rootManifests = (await readdir('.'))
      .filter((name) => /manifest.*sha256|sha256.*manifest/iu.test(name))
      .sort();

    expect(migrations.slice(-5)).toEqual([

      '0037_flow_ownership_reservations.sql',
      '0038_group_company_removal.sql',
      '0039_chatwoot_attendance_observations.sql',
      '0040_automation_input_queue.sql',
      '0041_automation_runtime_versions.sql',
    ]);
    expect(rootManifests).toEqual(['MANIFESTO_ARQUIVOS_SHA256.txt']);
  });
});
