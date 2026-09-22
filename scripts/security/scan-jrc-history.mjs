import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertFingerprintSecret, scanTextForSecrets } from './secret-scan-core.mjs';
import { TEST_SECRET_CANARIES } from './secret-canaries.mjs';

const UPSTREAM_PREFIX = 'upstream/evolution-api/';
const CANARY_DEFINITION_PATH = 'scripts/security/secret-canaries.mjs';
const HIGH_CONFIDENCE_GREP_PATTERNS = Object.freeze([
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '(AKIA|ASIA)[A-Z0-9]{16}',
  'xox[baprs]-[A-Za-z0-9-]{20,}',
]);

function escapeExtendedRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

function git(arguments_, rootDirectory, encoding = 'utf8') {
  try {
    const safeDirectory = resolve(rootDirectory).replaceAll('\\', '/');
    return execFileSync('git', ['-c', `safe.directory=${safeDirectory}`, ...arguments_], {
      cwd: rootDirectory,
      encoding,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error('Sanitized Git history scan failed');
  }
}

function isJrcPath(path) {
  return path !== 'upstream/evolution-api'
    && !path.startsWith(UPSTREAM_PREFIX);
}

export async function scanJrcHistory({ rootDirectory = process.cwd(), fingerprintSecret }) {
  assertFingerprintSecret(fingerprintSecret);
  const commits = git(['rev-list', '--all'], rootDirectory).split(/\r?\n/u).filter(Boolean);
  if (commits.length === 0) return [];
  const patterns = [
    ...Object.values(TEST_SECRET_CANARIES).map(escapeExtendedRegex),
    ...HIGH_CONFIDENCE_GREP_PATTERNS,
  ].flatMap((value) => ['-e', value]);
  const result = spawnSync('git', [
    '-c', `safe.directory=${resolve(rootDirectory).replaceAll('\\', '/')}`,
    'grep', '-n', '-I', '-E', ...patterns, ...commits, '--', '.', ':(exclude)upstream/evolution-api/**',
  ], {
    cwd: rootDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error('Sanitized Git history scan failed');
  }
  const findings = [];
  for (const line of (result.stdout ?? '').split(/\r?\n/u).filter(Boolean)) {
    const match = /^(?<sha>[0-9a-f]{40}):(?<path>.*?):(?<line>\d+):(?<content>.*)$/u.exec(line);
    if (!match?.groups || !isJrcPath(match.groups.path)) continue;
    const lineNumber = Number.parseInt(match.groups.line, 10);
    findings.push(...scanTextForSecrets({
      scanner: 'JRC_GIT_HISTORY',
      path: match.groups.path,
      content: match.groups.content,
      fingerprintSecret,
      sha: match.groups.sha,
      canaries: match.groups.path === CANARY_DEFINITION_PATH ? {} : TEST_SECRET_CANARIES,
    }).map((finding) => ({ ...finding, line: lineNumber })));
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.category}:${finding.path}:${finding.line}:${finding.sha}`, finding);
  }
  return [...unique.values()].sort((left, right) => (
    left.path.localeCompare(right.path)
      || left.line - right.line
      || left.category.localeCompare(right.category)
      || left.sha.localeCompare(right.sha)
  ));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const secret = process.env.AUDIT_FINGERPRINT_SECRET;
  if (!secret) throw new Error('AUDIT_FINGERPRINT_SECRET is required');
  const findings = await scanJrcHistory({
    rootDirectory: process.argv[2] ?? process.cwd(),
    fingerprintSecret: secret,
  });
  process.stdout.write(`${JSON.stringify({ scanner: 'JRC_GIT_HISTORY', findingCount: findings.length, findings })}\n`);
}
