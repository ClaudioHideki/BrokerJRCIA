import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { requireExclusiveLab } from '../integration/helpers/exclusive-lab.js';

for (const file of ['ci.yml', 'images.yml']) {
  it(`${file} runs integration gates against a disposable exclusive lab service`, () => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'));
    const jobs = Object.values(workflow.jobs) as any[];
    const jobsWithIntegration = jobs.filter(job => job.steps.some((step: any) =>
      step.run?.includes('npm run test:integration')));
    expect(jobsWithIntegration.length).toBeGreaterThan(0);
    for (const job of jobsWithIntegration) {
      const pg = job.services.postgres;
      expect(pg.image).toMatch(/^postgres:16\.4-alpine@sha256:/);
      expect(pg.volumes ?? []).toEqual([]);
      for (const step of job.steps.filter((item: any) => item.run?.includes('npm run test:integration'))) {
        const env = { ...job.env, ...step.env };
        for (const prefix of ['MEDIA_CUSTODY', 'PARTNER_REPLAY']) {
          expect(() => requireExclusiveLab(env.TEST_DATABASE_ADMIN_URL,
            env[`TEST_${prefix}_EXCLUSIVE_CLUSTER`], prefix)).not.toThrow();
        }
        const url = new URL(env.TEST_DATABASE_ADMIN_URL);
        expect(decodeURIComponent(url.username)).toBe(pg.env.POSTGRES_USER);
        expect(decodeURIComponent(url.pathname.slice(1))).toBe(pg.env.POSTGRES_DB);
        expect(pg.options).toContain(`-U ${pg.env.POSTGRES_USER}`);
        expect(pg.options).toContain(`-d ${pg.env.POSTGRES_DB}`);
        expect(step.run).toContain('--maxWorkers=1');
      }
    }
  });
}
