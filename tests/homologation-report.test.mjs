import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../scripts/operations/homologation-report.mjs', import.meta.url);
const subject = () => import(moduleUrl.href);
const profiles = ['S0', 'J1', 'J2', 'E1', 'C1', 'G1', 'V1'];
const components = ['API', 'MESSAGING', 'AUTOMATION', 'AUTOMATION_IO', 'SCHEDULER', 'LIFECYCLE', 'MIGRATOR'];
const knownProfiles = () => profiles.map(id => ({ id, flow: ['S0', 'J1', 'J2', 'E1', 'C1'].includes(id), integrated: ['J1', 'J2', 'E1', 'C1'].includes(id), centralUi: ['J1', 'J2', 'E1'].includes(id) }));
const release = () => ({ version: '0.0.0', commit: 'a'.repeat(40), baseline: '0049_central_cutover', expectedBaseline: '0049_central_cutover', journalVerified: true,
  flags: { AUTOMATION_RUNTIME_V2_ENABLED: true }, digests: Object.fromEntries(components.map(id => [id, `sha256:${'b'.repeat(64)}`])),
  externalVersions: ['J1', 'J2', 'E1', 'C1'].map(profile => ({ profile, version: '4.16.2' })),
});
async function completeFixture() {
  const { buildHomologationReport } = await subject();
  const input = { schemaVersion: 1, profiles: knownProfiles(), release: release(), runs: [] };
  input.runs = buildHomologationReport(input).requiredPairs.map(({ id, profile }) => ({ id, profile, result: 'PASS', origin: 'REAL',
    executedAt: '2026-10-07T16:00:00.000Z', correlation: `corr_${'c'.repeat(32)}`, evidenceRef: `ev_${'d'.repeat(64)}`, observed: 'MATCHED' }));
  return input;
}

it('prepares an empty NOT_RUN template that remains pending and never approves P10', async () => {
  const { createHomologationTemplate, buildHomologationReport } = await subject();
  const input = createHomologationTemplate(); const report = buildHomologationReport(input);
  expect(input.runs.length).toBeGreaterThan(24); expect(input.runs.every(run => run.result === 'NOT_RUN')).toBe(true);
  expect(report.status).toBe('PENDING'); expect(report.readyForManualReview).toBe(false);
  expect(report.homologationApproved).toBe(false); expect(report.evidenceIndependentlyVerified).toBe(false);
});

it('maps only documented combinations and conditional profile memberships', async () => {
  const { buildHomologationReport } = await subject();
  const report = buildHomologationReport({ schemaVersion: 1, profiles: knownProfiles(), runs: [] });
  const pairs = report.requiredPairs.map(pair => `${pair.id}:${pair.profile}`);
  expect(pairs.filter(pair => pair.startsWith('H07:'))).toEqual(['H07:J1', 'H07:E1']);
  expect(pairs.filter(pair => pair.startsWith('H18:'))).toEqual(['H18:G1']);
  expect(pairs.filter(pair => pair.startsWith('H19:'))).toEqual(['H19:V1']);
  expect(pairs.filter(pair => pair.startsWith('H03:'))).toEqual(['H03:S0', 'H03:J1', 'H03:J2', 'H03:E1', 'H03:C1']);
  expect(pairs).toContain('H09:G1'); expect(pairs).not.toContain('H01:C1'); expect(pairs).not.toContain('H16:S0');
});

it('keeps unknown conditional membership pending instead of assuming support or silently excluding it', async () => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture();
  input.profiles[5].flow = null;
  const report = buildHomologationReport(input);
  expect(report.status).toBe('PENDING'); expect(report.readyForManualReview).toBe(false);
  expect(report.unresolvedPairs).toContainEqual({ id: 'H03', profile: 'G1' });
});

it('labels complete operator declarations only as recorded, never independently proven or approved', async () => {
  const { buildHomologationReport } = await subject(); const report = buildHomologationReport(await completeFixture());
  expect(report.status).toBe('RECORDED'); expect(report.readyForManualReview).toBe(true);
  expect(report.homologationApproved).toBe(false); expect(report.evidenceIndependentlyVerified).toBe(false);
  expect(report.source).toBe('OPERATOR_ATTESTED'); expect(report.pendingPairs).toEqual([]);
});

it.each(['BLOCKED', 'NOT_RUN', 'NOT_APPLICABLE'])('does not close requested capabilities with result %s', async result => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture();
  input.runs.find(run => run.id === 'H19').result = result;
  const report = buildHomologationReport(input);
  expect(report.status).toBe('PENDING'); expect(report.readyForManualReview).toBe(false); expect(report.homologationApproved).toBe(false);
});

it.each(['SIMULATED', 'NOT_RECORDED'])('does not use %s as real acceptance evidence', async origin => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture(); input.runs[0].origin = origin;
  expect(buildHomologationReport(input).status).toBe('PENDING');
});

it.each(['executedAt', 'correlation', 'evidenceRef', 'observed'])('leaves PASS without %s pending', async field => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture(); delete input.runs[0][field];
  expect(buildHomologationReport(input).status).toBe('PENDING');
});

it('fails a real mismatch, a FAIL result, or a divergent expected baseline', async () => {
  const { buildHomologationReport } = await subject();
  for (const change of [input => { input.runs[0].observed = 'MISMATCHED'; }, input => { input.runs[0].result = 'FAIL'; }, input => { input.release.baseline = '0046_legacy'; }]) {
    const input = await completeFixture(); change(input); expect(buildHomologationReport(input).status).toBe('FAIL');
  }
});

it.each(['version', 'commit', 'baseline', 'expectedBaseline', 'journalVerified', 'flags', 'digests', 'externalVersions'])('requires release metadata %s before consolidation', async field => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture(); delete input.release[field];
  expect(buildHomologationReport(input).status).toBe('PENDING');
});

it('does not accept duplicate or conflicting scenario/profile records', async () => {
  const { buildHomologationReport } = await subject();
  for (const result of ['PASS', 'FAIL']) {
    const input = await completeFixture(); input.runs.push({ ...input.runs[0], result });
    expect(() => buildHomologationReport(input)).toThrow('HOMOLOGATION_DUPLICATE');
  }
});

it.each([input => { input.runs[0].id = 'H25'; }, input => { input.runs[0].profile = 'Z9'; }, input => { input.runs[0].id = 'H18'; },
  input => { input.runs[0].token = 'private-token'; }, input => { input.runs[0].correlation = '+5511999999999'; }, input => { input.runs[0].evidenceRef = 'https://user:private-password@host'; },
  input => { input.release.version = 'private-version'; }, input => { input.release.digests.API = 'private-digest'; }, input => { input.release.flags.AUTOMATION_RUNTIME_V2_ENABLED = 'true'; },
  input => { input.runs[0].observed = 'x'.repeat(10000); }, input => { input.schemaVersion = 2; }, input => { input.profiles.push(input.profiles[0]); },
])('rejects invalid schema, credentials, free text, or non-matrix combinations', async change => {
  const { buildHomologationReport } = await subject(); const input = await completeFixture(); change(input);
  expect(() => buildHomologationReport(input)).toThrow(/^HOMOLOGATION_(INVALID_INPUT|DUPLICATE)$/);
});

it('bounds CLI files and exposes only sanitized reports or static error codes', async () => {
  const { fileURLToPath } = await import('node:url'); const directory = await mkdtemp(join(tmpdir(), 'broker-homologation-'));
  try {
    const file = join(directory, 'input.json'); const script = fileURLToPath(moduleUrl);
    await writeFile(file, JSON.stringify(await completeFixture()));
    const valid = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(valid.status).toBe(0); expect(JSON.parse(valid.stdout).status).toBe('RECORDED'); expect(valid.stderr).toBe('');
    await writeFile(file, '{private-password');
    const bad = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(bad.status).toBe(1); expect(bad.stdout).toBe(''); expect(bad.stderr).toBe('HOMOLOGATION_INVALID_INPUT\n');
    await writeFile(file, 'x'.repeat(262145));
    const huge = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(huge.status).toBe(1); expect(huge.stderr).toBe('HOMOLOGATION_INPUT_TOO_LARGE\n');
    const template = spawnSync(process.execPath, [script, '--template'], { encoding: 'utf8' });
    expect(template.status).toBe(0); expect(JSON.parse(template.stdout).runs.every(run => run.result === 'NOT_RUN')).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
