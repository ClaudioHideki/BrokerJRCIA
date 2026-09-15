import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertAuditData,
  assertAuditEvidenceLocations,
  normalizeIssueMarkdown,
} from './audit-schema.mjs';
import { CURRENT_AUDIT_PROFILE } from './audit-profile.mjs';
import { buildRouteInventory } from './inventory-routes.mjs';
import { renderAuditMarkdown } from './render-markdown.mjs';
import { AUDIT_PALETTE, renderAuditPdf } from './render-pdf.mjs';
import {
  scanCompiledBundle,
  scanForbiddenViteVariables,
} from './scan-compiled-bundle.mjs';
import { scanJrcHistory } from './scan-jrc-history.mjs';
import { TEST_SECRET_CANARIES } from './secret-canaries.mjs';
import { sanitizedScanSummary } from './secret-scan-core.mjs';

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function referenceDateFromEpoch(sourceDateEpoch) {
  if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  return new Date(sourceDateEpoch * 1000).toISOString().slice(0, 10);
}

const AUDITED_SOURCE_PATHS = Object.freeze([
  '.env.example',
  '.github/workflows/ci.yml',
  'apps',
  'infra',
  'package-lock.json',
  'package.json',
  'packages',
  'playwright.config.ts',
  'scripts/security',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'vitest.compiled.config.ts',
  'docs/api',
  'docs/operations',
]);

export function buildAuditSourceReference({
  rootDirectory = process.cwd(),
  profile = CURRENT_AUDIT_PROFILE,
} = {}) {
  const root = resolve(rootDirectory);
  const safeRoot = root.replaceAll('\\', '/');
  let listedFiles;
  try {
    listedFiles = execFileSync('git', [
      '-c', `safe.directory=${safeRoot}`,
      'ls-files', '--cached', '--others', '--exclude-standard', '--', ...AUDITED_SOURCE_PATHS,
    ], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).split(/\r?\n/u).filter(Boolean);
  } catch {
    throw new Error('Could not enumerate the audited source snapshot');
  }
  const outputPrefix = `${profile.outputDirectory.replaceAll('\\', '/').replace(/\/$/u, '')}/`;
  const files = [...new Set(listedFiles)]
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !path.startsWith(outputPrefix) && !path.startsWith('upstream/'))
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
  let blobs;
  try {
    blobs = execFileSync('git', [
      '-c', `safe.directory=${safeRoot}`,
      'hash-object', '--stdin-paths',
    ], {
      cwd: root,
      encoding: 'utf8',
      input: `${files.join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    }).split(/\r?\n/u).filter(Boolean);
  } catch {
    throw new Error('Could not hash the audited source snapshot');
  }
  if (blobs.length !== files.length) throw new Error('Audited source snapshot is incomplete');
  const digest = createHash('sha256');
  for (const [index, path] of files.entries()) {
    digest.update(path).update('\0').update(blobs[index]).update('\n');
  }
  return `sha256:${digest.digest('hex')}`;
}

function assertNoCanary(buffers) {
  for (const [path, buffer] of buffers) {
    for (const value of Object.values(TEST_SECRET_CANARIES)) {
      if (buffer.includes(Buffer.from(value))) throw new Error(`Secret canary leaked into generated artifact: ${path}`);
    }
  }
}

export async function generateSecurityAudit({
  rootDirectory = process.cwd(),
  profile = CURRENT_AUDIT_PROFILE,
  outputDirectory = resolve(rootDirectory, profile.outputDirectory),
  sourceDateEpoch = Number.parseInt(
    process.env.SOURCE_DATE_EPOCH ?? String(profile.sourceDateEpoch),
    10,
  ),
  fingerprintSecret = process.env.AUDIT_FINGERPRINT_SECRET,
  auditData,
} = {}) {
  if (sourceDateEpoch !== profile.sourceDateEpoch) {
    throw new Error(`SOURCE_DATE_EPOCH must equal the immutable audit profile value ${profile.sourceDateEpoch}`);
  }
  const referenceDate = referenceDateFromEpoch(sourceDateEpoch);
  const sourceReference = buildAuditSourceReference({ rootDirectory, profile });
  const sourceAuditData = auditData ?? JSON.parse(await readFile(
    resolve(rootDirectory, profile.outputDirectory, 'findings.json'),
    'utf8',
  ));
  const normalizedAuditData = {
    ...sourceAuditData,
    generatedAt: new Date(sourceDateEpoch * 1000).toISOString(),
    findings: sourceAuditData.findings.map((finding, index) => ({
      ...finding,
      issueMarkdown: normalizeIssueMarkdown(finding.issueMarkdown, index + 1),
    })),
  };
  assertAuditData(normalizedAuditData);
  await assertAuditEvidenceLocations(normalizedAuditData, { rootDirectory });
  const openapi = JSON.parse(await readFile(resolve(rootDirectory, 'docs/api/openapi.json'), 'utf8'));
  const routeInventory = await buildRouteInventory({ rootDirectory, openapi });
  const [historyFindings, bundleFindings, viteFindings] = await Promise.all([
    scanJrcHistory({ rootDirectory, fingerprintSecret }),
    scanCompiledBundle({ rootDirectory, fingerprintSecret }),
    scanForbiddenViteVariables({ rootDirectory }),
  ]);
  const scanSummary = {
    schemaVersion: 1,
    generatedAt: normalizedAuditData.generatedAt,
    sanitization: 'HMAC_SHA_256_FINGERPRINTS_ONLY',
    scans: sanitizedScanSummary([
      { scanner: 'JRC_GIT_HISTORY', excluded: ['upstream/evolution-api/**', 'scripts/security/secret-canaries.mjs'], findings: historyFindings },
      { scanner: 'COMPILED_BUNDLE', excluded: ['**/*.map', 'node_modules/**', 'upstream/**'], findings: bundleFindings },
    ]),
  };
  scanSummary.scans[0].scope = ['reachable root repository blobs'];
  scanSummary.scans[1].scope = ['apps/api/dist/**', 'apps/web/dist/**', 'packages/contracts/dist/**', 'packages/providers/dist/**', 'packages/security/dist/**'];
  scanSummary.scans.push({
    scanner: 'VITE_CONFIGURATION',
    excluded: ['apps/web/src/**/*.test.*', 'apps/web/src/**/*.spec.*'],
    scope: ['process.env names', '.env* variable names', 'apps/web/src production references'],
    findingCount: viteFindings.length,
    findings: viteFindings,
  });

  const markdown = renderAuditMarkdown({ auditData: normalizedAuditData, routeInventory, sourceReference, referenceDate, scanSummary, profile });
  const { buffer: pdf, pageCount } = await renderAuditPdf({
    auditData: normalizedAuditData,
    routeInventory,
    sourceReference,
    referenceDate,
    scanSummary,
    profile,
  });
  const verification = {
    schemaVersion: 1,
    sourceDateEpoch,
    sourceReference,
    inputDigest: createHash('sha256').update(stableJson({ normalizedAuditData, routeInventory, scanSummary })).digest('hex'),
    pageCount,
    pageSize: 'A4',
    marginMillimeters: 18,
    headerFromPage: 2,
    footerPattern: 'Página X de Y',
    minimumRasterDpi: 150,
    expectedRasterizedPageCount: pageCount,
    chromePages: Array.from({ length: pageCount - 1 }, (_, index) => index + 2),
    palette: AUDIT_PALETTE,
    headerText: profile.headerText,
    subject: profile.subject,
  };
  const issueOutputs = normalizedAuditData.findings.map((finding, index) => [
    `issues/${String(index + 1).padStart(3, '0')}-${finding.id.toLowerCase()}.md`,
    Buffer.from(`${finding.issueMarkdown.trim()}\n`),
  ]);
  const outputs = [
    ['findings.json', Buffer.from(stableJson(normalizedAuditData))],
    ['route-inventory.json', Buffer.from(stableJson(routeInventory))],
    ['secret-scan-summary.json', Buffer.from(stableJson(scanSummary))],
    ['relatorio-auditoria-seguranca.md', Buffer.from(markdown)],
    ['relatorio-auditoria-seguranca.pdf', pdf],
    ['pdf-verification.json', Buffer.from(stableJson(verification))],
    ...issueOutputs,
  ];
  assertNoCanary(outputs);

  await mkdir(outputDirectory, { recursive: true });
  const issuesDirectory = resolve(outputDirectory, 'issues');
  await rm(issuesDirectory, { recursive: true, force: true });
  await mkdir(issuesDirectory, { recursive: true });
  await Promise.all(outputs.map(([path, content]) => writeFile(resolve(outputDirectory, path), content)));
  return { outputDirectory, pageCount, sourceReference, referenceDate };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await generateSecurityAudit();
  process.stdout.write(`Security audit artifacts generated (${result.pageCount} PDF pages)\n`);
}
