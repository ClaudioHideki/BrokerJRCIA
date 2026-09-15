import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CURRENT_AUDIT_PROFILE } from './audit-profile.mjs';

export const FINDING_SEVERITIES = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export const FINDING_STATUSES = Object.freeze(['OPEN', 'ACCEPTED', 'FIXED', 'NOT_APPLICABLE']);
export const AUDIT_CATEGORIES = Object.freeze([
  'MULTITENANT_ISOLATION',
  'AUTHORIZATION_RBAC',
  'IDOR',
  'SECRETS_CRYPTOGRAPHY',
  'INPUTS_XSS',
  'AUTHENTICATION',
  'RATE_LIMITING',
  'LOGGING_AUDIT',
  'PROVIDER_BOUNDARY',
  'IDEMPOTENCY_DOS',
  'SUPPLY_CHAIN',
  'OPENAPI_ROUTES',
  'CONTAINER_RUNTIME',
]);

const findingKeys = Object.freeze([
  'acceptanceCriteria', 'category', 'codeExcerptMasked', 'control', 'description',
  'evidencePaths', 'exploitability', 'exploitConditions', 'file', 'id', 'impact',
  'issueMarkdown', 'lineEnd', 'lineStart', 'remediation', 'severity', 'status',
  'suggestedLabels', 'title', 'verification',
].sort());
const strengthKeys = Object.freeze([
  'category', 'description', 'evidencePaths', 'file', 'id', 'lineEnd', 'lineStart', 'title',
].sort());

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.join('\0') !== expected.join('\0')) throw new Error(`${label} has invalid fields`);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`));
}

function assertLocation(value, label) {
  assertString(value.file, `${label}.file`);
  if (!Number.isInteger(value.lineStart) || value.lineStart < 1) throw new Error(`${label}.lineStart is invalid`);
  if (!Number.isInteger(value.lineEnd) || value.lineEnd < value.lineStart) throw new Error(`${label}.lineEnd is invalid`);
  assertStringArray(value.evidencePaths, `${label}.evidencePaths`);
}

export function normalizeIssueMarkdown(issueMarkdown, issueNumber) {
  assertString(issueMarkdown, 'issueMarkdown');
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('issueNumber must be a positive integer');
  const body = issueMarkdown
    .split(/\r?\n/u)
    .filter((line) => !/^--- (?:FIM )?ISSUE \d+ ---$/u.test(line.trim()))
    .join('\n')
    .trim();
  return `--- ISSUE ${issueNumber} ---\n${body}\n--- FIM ISSUE ${issueNumber} ---`;
}

export function assertAuditData(data) {
  assertObject(data, 'audit data');
  assertExactKeys(data, ['findings', 'generatedAt', 'schemaVersion', 'strengths'], 'audit data');
  if (data.schemaVersion !== 1) throw new Error('Unsupported audit schema version');
  if (typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) {
    throw new Error('generatedAt must be an ISO timestamp');
  }
  if (!Array.isArray(data.findings) || !Array.isArray(data.strengths)) {
    throw new Error('findings and strengths must be arrays');
  }
  const ids = new Set();
  data.findings.forEach((finding, index) => {
    const label = `findings[${index}]`;
    assertObject(finding, label);
    assertExactKeys(finding, findingKeys, label);
    ['id', 'title', 'control', 'codeExcerptMasked', 'description', 'impact', 'exploitability',
      'exploitConditions', 'remediation', 'verification', 'issueMarkdown']
      .forEach((key) => assertString(finding[key], `${label}.${key}`));
    if (!AUDIT_CATEGORIES.includes(finding.category)) throw new Error(`${label}.category is invalid`);
    if (!FINDING_SEVERITIES.includes(finding.severity)) throw new Error(`${label}.severity is invalid`);
    if (!FINDING_STATUSES.includes(finding.status)) throw new Error(`${label}.status is invalid`);
    assertLocation(finding, label);
    assertStringArray(finding.acceptanceCriteria, `${label}.acceptanceCriteria`);
    assertStringArray(finding.suggestedLabels, `${label}.suggestedLabels`);
    if (finding.issueMarkdown !== normalizeIssueMarkdown(finding.issueMarkdown, index + 1)) {
      throw new Error(`${label}.issueMarkdown has invalid delimiters`);
    }
    if (ids.has(finding.id)) throw new Error(`Duplicate audit id: ${finding.id}`);
    ids.add(finding.id);
  });
  data.strengths.forEach((strength, index) => {
    const label = `strengths[${index}]`;
    assertObject(strength, label);
    assertExactKeys(strength, strengthKeys, label);
    ['id', 'title', 'description'].forEach((key) => assertString(strength[key], `${label}.${key}`));
    if (!AUDIT_CATEGORIES.includes(strength.category)) throw new Error(`${label}.category is invalid`);
    assertLocation(strength, label);
    if (ids.has(strength.id)) throw new Error(`Duplicate audit id: ${strength.id}`);
    ids.add(strength.id);
  });
  return data;
}

function evidencePath(rootDirectory, path, label) {
  const absolute = resolve(rootDirectory, path);
  const relativePath = relative(rootDirectory, absolute);
  if (isAbsolute(path) || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return absolute;
}

export async function assertAuditEvidenceLocations(data, { rootDirectory = process.cwd() } = {}) {
  assertAuditData(data);
  const entries = [...data.findings, ...data.strengths];
  for (const [index, entry] of entries.entries()) {
    const label = index < data.findings.length
      ? `findings[${index}]`
      : `strengths[${index - data.findings.length}]`;
    const primaryPath = evidencePath(rootDirectory, entry.file, `${label}.file`);
    let source;
    try {
      source = await readFile(primaryPath, 'utf8');
    } catch {
      throw new Error(`${label}.file does not exist: ${entry.file}`);
    }
    const lineCount = source.length === 0
      ? 0
      : source.split(/\r?\n/u).length - (source.endsWith('\n') ? 1 : 0);
    if (entry.lineEnd > lineCount) {
      throw new Error(`${label}.lineEnd ${entry.lineEnd} exceeds ${entry.file} EOF at line ${lineCount}`);
    }
    for (const [evidenceIndex, path] of entry.evidencePaths.entries()) {
      const absolute = evidencePath(rootDirectory, path, `${label}.evidencePaths[${evidenceIndex}]`);
      try {
        if (!(await stat(absolute)).isFile()) throw new Error('not a file');
      } catch {
        throw new Error(`${label}.evidencePaths[${evidenceIndex}] does not exist: ${path}`);
      }
    }
  }
  return data;
}

export function gateAuditData(data) {
  assertAuditData(data);
  const blockingFindingIds = data.findings
    .filter(({ severity, status }) => status === 'OPEN' && (severity === 'CRITICAL' || severity === 'HIGH'))
    .map(({ id }) => id)
    .sort();
  return { blocked: blockingFindingIds.length > 0, blockingFindingIds };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const input = process.argv[2]
    ?? resolve(process.cwd(), CURRENT_AUDIT_PROFILE.outputDirectory, 'findings.json');
  const data = JSON.parse(await readFile(input, 'utf8'));
  assertAuditData(data);
  await assertAuditEvidenceLocations(data, { rootDirectory: process.cwd() });
  process.stdout.write('Audit data schema: PASS\n');
}
