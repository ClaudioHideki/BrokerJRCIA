import { createHmac } from 'node:crypto';

import { TEST_SECRET_CANARIES } from './secret-canaries.mjs';

const HIGH_CONFIDENCE_RULES = Object.freeze([
  { category: 'GITHUB_TOKEN', expression: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/gu },
  { category: 'PRIVATE_KEY', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { category: 'AWS_ACCESS_KEY', expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { category: 'SLACK_TOKEN', expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
]);

export function assertFingerprintSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Audit fingerprint secret must contain at least 16 characters');
  }
}

function fingerprint(value, secret) {
  assertFingerprintSecret(secret);
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function scanTextForSecrets({
  scanner,
  path,
  content,
  fingerprintSecret,
  sha,
  canaries = TEST_SECRET_CANARIES,
}) {
  const findings = [];
  const lines = content.split(/\r?\n/u);
  for (const [category, value] of Object.entries(canaries)) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(value)) continue;
      findings.push({
        scanner,
        category: category.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase(),
        path,
        line: index + 1,
        ...(sha === undefined ? {} : { sha: sha.slice(0, 12) }),
        fingerprint: fingerprint(value, fingerprintSecret),
      });
    }
  }
  for (const { category, expression } of HIGH_CONFIDENCE_RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = expression.exec(lines[index]);
      expression.lastIndex = 0;
      if (!match) continue;
      findings.push({
        scanner,
        category,
        path,
        line: index + 1,
        ...(sha === undefined ? {} : { sha: sha.slice(0, 12) }),
        fingerprint: fingerprint(match[0], fingerprintSecret),
      });
    }
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.category}:${finding.path}:${finding.line}:${finding.sha ?? ''}`, finding);
  }
  return [...unique.values()];
}

export const scanTextForCanaries = scanTextForSecrets;

export function sanitizedScanSummary(scans) {
  return scans.map(({ scanner, excluded = [], findings }) => ({
    scanner,
    excluded,
    findingCount: findings.length,
    findings,
  }));
}
