import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertFingerprintSecret, scanTextForSecrets } from './secret-scan-core.mjs';

const BUNDLE_ROOTS = Object.freeze([
  'apps/api/dist',
  'apps/web/dist',
  'packages/contracts/dist',
  'packages/providers/dist',
  'packages/security/dist',
]);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json']);
const WEB_SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (TEXT_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith('.map')) files.push(path);
  }
  return files;
}

async function candidateViteFiles(rootDirectory) {
  const candidates = [];
  for (const directory of [rootDirectory, resolve(rootDirectory, 'apps/web')]) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('.env')) {
        candidates.push(resolve(directory, entry.name));
      }
    }
  }
  const sourceRoot = resolve(rootDirectory, 'apps/web/src');
  for (const path of await filesUnderExtensions(sourceRoot, WEB_SOURCE_EXTENSIONS)) candidates.push(path);
  for (const path of [
    resolve(rootDirectory, 'vite.config.ts'),
    resolve(rootDirectory, 'apps/web/vite.config.ts'),
  ]) {
    try {
      await readFile(path, 'utf8');
      candidates.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(candidates)].sort();
}

async function filesUnderExtensions(directory, extensions) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', 'test', 'tests'].includes(entry.name)) {
        files.push(...await filesUnderExtensions(path, extensions));
      }
    } else if (
      extensions.has(extname(entry.name))
      && !/\.(?:spec|test)\.[^.]+$/u.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

export async function scanForbiddenViteVariables({
  rootDirectory = process.cwd(),
  environment = process.env,
  allowedNames = [],
} = {}) {
  const allowed = new Set(allowedNames);
  const findings = [];
  for (const name of Object.keys(environment ?? {}).sort()) {
    if (/^VITE_[A-Z0-9_]+$/u.test(name) && !allowed.has(name)) {
      findings.push({ name, path: 'process.env', line: 1 });
    }
  }
  for (const path of await candidateViteFiles(rootDirectory)) {
    const relativePath = relative(rootDirectory, path).replaceAll('\\', '/');
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      const names = relativePath.split('/').at(-1)?.startsWith('.env')
        ? [/^\s*(VITE_[A-Z0-9_]+)\s*=/u.exec(line)?.[1]].filter(Boolean)
        : [...line.matchAll(/\b(VITE_[A-Z0-9_]+)\b/gu)].map((match) => match[1]);
      for (const name of new Set(names)) {
        if (!allowed.has(name)) findings.push({ name, path: relativePath, line: index + 1 });
      }
    }
  }
  return findings.sort((left, right) => (
    left.path.localeCompare(right.path) || left.line - right.line || left.name.localeCompare(right.name)
  ));
}

export async function scanCompiledBundle({ rootDirectory = process.cwd(), fingerprintSecret }) {
  assertFingerprintSecret(fingerprintSecret);
  const findings = [];
  for (const bundleRoot of BUNDLE_ROOTS) {
    for (const file of await filesUnder(resolve(rootDirectory, bundleRoot))) {
      const content = await readFile(file, 'utf8');
      findings.push(...scanTextForSecrets({
        scanner: 'COMPILED_BUNDLE',
        path: relative(rootDirectory, file).replaceAll('\\', '/'),
        content,
        fingerprintSecret,
      }));
    }
  }
  return findings.sort((left, right) => (
    left.path.localeCompare(right.path) || left.line - right.line || left.category.localeCompare(right.category)
  ));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const secret = process.env.AUDIT_FINGERPRINT_SECRET;
  if (!secret) throw new Error('AUDIT_FINGERPRINT_SECRET is required');
  const findings = await scanCompiledBundle({
    rootDirectory: process.argv[2] ?? process.cwd(),
    fingerprintSecret: secret,
  });
  process.stdout.write(`${JSON.stringify({ scanner: 'COMPILED_BUNDLE', findingCount: findings.length, findings })}\n`);
}
