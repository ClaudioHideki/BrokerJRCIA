import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ADMIN_METHOD = /\b(?:deprovisionInstance|lookupInstance|reconcileProvisioning)\b/u;
const UPSTREAM_TERM = /\b(?:Evolution|evolutionInstanceName|upstreamInstance(?:Key|Name))\b/u;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
];

export function scanHighConfidenceSecretMaterial(source) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(source));
}

export function scanPublicContract(source) {
  const findings = [];
  if (UPSTREAM_TERM.test(source)) findings.push({ rule: 'no-upstream-public-contract' });
  if (ADMIN_METHOD.test(source)) findings.push({ rule: 'no-admin-provider-public-contract' });
  return findings;
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ['dist', 'node_modules', 'coverage', 'upstream'].includes(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (['.ts', '.js', '.mjs', '.json', '.snap'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function checkPublicContracts(rootDirectory = process.cwd()) {
  const publicRoots = [
    resolve(rootDirectory, 'packages/contracts/src'),
    resolve(rootDirectory, 'apps/api/src/http/routes'),
  ];
  const findings = [];
  for (const root of publicRoots) {
    for (const file of await filesUnder(root)) {
      const source = await readFile(file, 'utf8');
      for (const finding of scanPublicContract(source)) {
        findings.push({ ...finding, file: file.slice(rootDirectory.length + 1).replaceAll('\\', '/') });
      }
    }
  }

  const openapiPath = resolve(rootDirectory, 'docs/api/openapi.json');
  const openapi = await readFile(openapiPath, 'utf8');
  for (const finding of scanPublicContract(openapi)) {
    findings.push({ ...finding, file: 'docs/api/openapi.json' });
  }

  const fixtureRoots = [resolve(rootDirectory, 'apps'), resolve(rootDirectory, 'packages'), resolve(rootDirectory, 'tests')];
  for (const root of fixtureRoots) {
    for (const file of await filesUnder(root)) {
      const source = await readFile(file, 'utf8');
      if (scanHighConfidenceSecretMaterial(source)) {
        findings.push({
          rule: 'no-high-confidence-secret-in-source',
          file: file.slice(rootDirectory.length + 1).replaceAll('\\', '/'),
        });
      }
    }
  }
  return findings;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const findings = await checkPublicContracts();
  if (findings.length > 0) {
    for (const { rule, file } of findings) process.stderr.write(`${rule}: ${file}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Public contract boundary: PASS\n');
  }
}
