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

    expect(migrations.slice(-6)).toEqual([

      '0040_automation_input_queue.sql',
      '0041_automation_runtime_versions.sql',
      '0042_native_handoff_operations.sql',
      '0043_user_password_reset.sql',
      '0044_attendance_resume_operations.sql',
      '0045_local_attendance_directory.sql',
    ]);
    expect(rootManifests).toEqual(['MANIFESTO_ARQUIVOS_SHA256.txt']);
  });
});
