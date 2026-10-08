import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PROFILES = ['S0', 'J1', 'J2', 'E1', 'C1', 'G1', 'V1'];
const CORE = ['S0', 'J1', 'J2', 'E1', 'C1'];
const COMPONENTS = ['API', 'MESSAGING', 'AUTOMATION', 'AUTOMATION_IO', 'SCHEDULER', 'LIFECYCLE', 'MIGRATOR', 'EVOLUTION'];
const REQUIRED_COMPONENTS = COMPONENTS.slice(0, 7);
const MAX_BYTES = 262144;
const CODES = new Set(['HOMOLOGATION_INVALID_INPUT', 'HOMOLOGATION_DUPLICATE', 'HOMOLOGATION_INPUT_TOO_LARGE', 'HOMOLOGATION_INPUT_UNREADABLE', 'HOMOLOGATION_USAGE']);
const RUN_FIELDS = ['id', 'profile', 'result', 'origin', 'executedAt', 'correlation', 'evidenceRef', 'observed', 'incident'];
const RELEASE_FIELDS = ['version', 'commit', 'baseline', 'expectedBaseline', 'journalVerified', 'flags', 'digests', 'externalVersions'];

// Literal selectors from docs/validation/2026-10-05-broker-programa-baseline.md.
const MATRIX = [
  ['H01', ['S0', 'J1', 'J2', 'E1']], ['H02', CORE], ['H03', 'flow'], ['H04', CORE],
  ['H05', CORE], ['H06', CORE], ['H07', ['J1', 'E1']], ['H08', CORE], ['H09', PROFILES],
  ['H10', ['S0', 'J1', 'E1']], ['H11', ['S0', 'J1', 'E1']], ['H12', 'flow'],
  ['H13', ['J1', 'J2', 'E1', 'C1']], ['H14', ['J1', 'E1']], ['H15', PROFILES],
  ['H16', 'integrated'], ['H17', 'flow'], ['H18', ['G1']], ['H19', ['V1']],
  ['H20', PROFILES], ['H21', 'centralUi'], ['H22', PROFILES], ['H23', PROFILES],
  ['H24', ['S0', 'J1', 'J2', 'E1']],
];

function fail(code = 'HOMOLOGATION_INVALID_INPUT') { throw new Error(code); }
function object(value, fields, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !property?.enumerable || !Object.hasOwn(property, 'value')) fail();
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail();
}
function list(value, max) { if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) fail(); }
function oneOf(value, allowed) { if (!allowed.includes(value)) fail(); }
function formatted(value, pattern) { if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) fail(); }
function duplicate(seen, key) { if (seen.has(key)) fail('HOMOLOGATION_DUPLICATE'); seen.add(key); }
function pick(value, fields) { return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
const version = value => formatted(value, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
const baseline = value => formatted(value, /^\d{4}_[a-z][a-z_]{0,63}$/);

function validate(input) {
  object(input, ['schemaVersion', 'profiles', 'release', 'runs'], ['schemaVersion', 'profiles', 'runs']);
  if (input.schemaVersion !== 1) fail();
  list(input.profiles, 7); list(input.runs, 168);
  const seenProfiles = new Set();
  for (const profile of input.profiles) {
    object(profile, ['id', 'flow', 'integrated', 'centralUi'], ['id']);
    oneOf(profile.id, PROFILES); duplicate(seenProfiles, profile.id);
    for (const field of ['flow', 'integrated', 'centralUi']) if (Object.hasOwn(profile, field) && profile[field] !== null && typeof profile[field] !== 'boolean') fail();
  }
  if (Object.hasOwn(input, 'release')) {
    const release = input.release; object(release, RELEASE_FIELDS);
    if (Object.hasOwn(release, 'version')) version(release.version);
    if (Object.hasOwn(release, 'commit')) formatted(release.commit, /^[a-f0-9]{40}$/);
    for (const field of ['baseline', 'expectedBaseline']) if (Object.hasOwn(release, field)) baseline(release[field]);
    if (Object.hasOwn(release, 'journalVerified') && typeof release.journalVerified !== 'boolean') fail();
    if (Object.hasOwn(release, 'flags')) {
      object(release.flags, ['AUTOMATION_RUNTIME_V2_ENABLED']);
      if (Object.hasOwn(release.flags, 'AUTOMATION_RUNTIME_V2_ENABLED') && typeof release.flags.AUTOMATION_RUNTIME_V2_ENABLED !== 'boolean') fail();
    }
    if (Object.hasOwn(release, 'digests')) {
      object(release.digests, COMPONENTS);
      for (const value of Object.values(release.digests)) formatted(value, /^sha256:[a-f0-9]{64}$/);
    }
    if (Object.hasOwn(release, 'externalVersions')) {
      list(release.externalVersions, 7); const seen = new Set();
      for (const external of release.externalVersions) {
        object(external, ['profile', 'version'], ['profile', 'version']);
        oneOf(external.profile, PROFILES); duplicate(seen, external.profile); version(external.version);
      }
    }
  }
  const seenRuns = new Set();
  for (const run of input.runs) {
    object(run, RUN_FIELDS, ['id', 'profile', 'result']);
    oneOf(run.id, MATRIX.map(row => row[0])); oneOf(run.profile, PROFILES);
    duplicate(seenRuns, `${run.id}:${run.profile}`);
    oneOf(run.result, ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NOT_APPLICABLE']);
    if (Object.hasOwn(run, 'origin')) oneOf(run.origin, ['REAL', 'SIMULATED', 'NOT_RECORDED']);
    if (Object.hasOwn(run, 'observed')) oneOf(run.observed, ['MATCHED', 'MISMATCHED', 'UNRECORDED']);
    if (Object.hasOwn(run, 'executedAt')) {
      formatted(run.executedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      if (!Number.isFinite(Date.parse(run.executedAt)) || new Date(run.executedAt).toISOString() !== run.executedAt) fail();
    }
    if (Object.hasOwn(run, 'correlation')) formatted(run.correlation, /^corr_[a-f0-9]{32,64}$/);
    if (Object.hasOwn(run, 'evidenceRef')) formatted(run.evidenceRef, /^ev_[a-f0-9]{64}$/);
    if (Object.hasOwn(run, 'incident')) formatted(run.incident, /^inc_[a-f0-9]{64}$/);
  }
}

function matrixPairs(profiles) {
  const requiredPairs = []; const unresolvedPairs = []; const excludedPairs = [];
  for (const [id, selector] of MATRIX) {
    if (Array.isArray(selector)) {
      for (const profile of selector) requiredPairs.push({ id, profile });
      continue;
    }
    const candidates = selector === 'centralUi' ? ['J1', 'J2', 'E1'] : PROFILES;
    for (const profile of candidates) {
      const membership = profiles.find(item => item.id === profile)?.[selector];
      const pairs = membership === true ? requiredPairs : membership === false ? excludedPairs : unresolvedPairs;
      pairs.push({ id, profile });
    }
  }
  return { requiredPairs, unresolvedPairs, excludedPairs };
}

/** Preparation contains no assertions of capability or execution. Resolve conditional metadata before recording its runs. */
export function createHomologationTemplate() {
  const profiles = PROFILES.map(id => ({ id, flow: null, integrated: null, centralUi: null }));
  const { requiredPairs } = matrixPairs(profiles);
  return { schemaVersion: 1, profiles, release: {}, runs: requiredPairs.map(pair => ({ ...pair, result: 'NOT_RUN', origin: 'NOT_RECORDED' })) };
}

/** Consolidates declarations only; it cannot authenticate evidence, execute a journey or approve P10. */
export function buildHomologationReport(input) {
  validate(input);
  const pairs = matrixPairs(input.profiles);
  const allowed = new Set(pairs.requiredPairs.map(pair => `${pair.id}:${pair.profile}`));
  for (const run of input.runs) if (!allowed.has(`${run.id}:${run.profile}`)) fail();
  const release = input.release ?? {};
  const missingMetadata = [];
  for (const profile of PROFILES) if (!input.profiles.some(item => item.id === profile)) missingMetadata.push(`profiles.${profile}`);
  for (const field of ['version', 'commit', 'baseline', 'expectedBaseline']) if (!Object.hasOwn(release, field)) missingMetadata.push(`release.${field}`);
  if (release.journalVerified !== true) missingMetadata.push('release.journalVerified');
  if (release.flags?.AUTOMATION_RUNTIME_V2_ENABLED !== true) missingMetadata.push('release.flags.AUTOMATION_RUNTIME_V2_ENABLED');
  for (const component of REQUIRED_COMPONENTS) if (!release.digests?.[component]) missingMetadata.push(`release.digests.${component}`);
  for (const profile of input.profiles.filter(item => item.integrated === true)) {
    if (!release.externalVersions?.some(item => item.profile === profile.id)) missingMetadata.push(`release.externalVersions.${profile.id}`);
  }
  const pendingPairs = []; const failedPairs = [];
  for (const pair of pairs.requiredPairs) {
    const run = input.runs.find(item => item.id === pair.id && item.profile === pair.profile);
    if (run?.result === 'FAIL' || run?.observed === 'MISMATCHED') failedPairs.push(pair);
    else if (!run || run.result !== 'PASS' || run.origin !== 'REAL' || run.observed !== 'MATCHED' || !run.executedAt || !run.correlation || !run.evidenceRef) pendingPairs.push(pair);
  }
  const baselineMismatch = Boolean(release.baseline && release.expectedBaseline && release.baseline !== release.expectedBaseline);
  const status = failedPairs.length || baselineMismatch ? 'FAIL' : missingMetadata.length || pendingPairs.length || pairs.unresolvedPairs.length ? 'PENDING' : 'RECORDED';
  return {
    schemaVersion: 1, status, readyForManualReview: status === 'RECORDED',
    homologationApproved: false, evidenceIndependentlyVerified: false, source: 'OPERATOR_ATTESTED',
    matrix: '2026-10-05-broker-programa-baseline', ...pairs, pendingPairs, failedPairs, missingMetadata, baselineMismatch,
    profiles: input.profiles.map(profile => ({ id: profile.id, flow: profile.flow ?? null, integrated: profile.integrated ?? null, centralUi: profile.centralUi ?? null })),
    release: pick(release, RELEASE_FIELDS), records: input.runs.map(run => pick(run, RUN_FIELDS)),
  };
}

async function readInput(path) {
  let file;
  try {
    file = await open(path, 'r'); const info = await file.stat();
    if (!info.isFile()) fail('HOMOLOGATION_INPUT_UNREADABLE');
    if (info.size > MAX_BYTES) fail('HOMOLOGATION_INPUT_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break; size += result.bytesRead;
    }
    if (size > MAX_BYTES) fail('HOMOLOGATION_INPUT_TOO_LARGE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { fail(); }
  } catch (error) {
    if (CODES.has(error?.message)) throw error;
    fail('HOMOLOGATION_INPUT_UNREADABLE');
  } finally { await file?.close().catch(() => {}); }
}

async function cli(args) {
  try {
    if (args.length !== 1) fail('HOMOLOGATION_USAGE');
    const output = args[0] === '--template' ? createHomologationTemplate() : buildHomologationReport(await readInput(args[0]));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (args[0] !== '--template' && output.status !== 'RECORDED') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${CODES.has(error?.message) ? error.message : 'HOMOLOGATION_INVALID_INPUT'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await cli(process.argv.slice(2));
