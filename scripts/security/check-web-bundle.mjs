import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json']);
const FORBIDDEN_PATTERNS = Object.freeze([
  { category: 'CLIENT_ENVIRONMENT_NAME', pattern: /\bVITE_[A-Z0-9_]+\b/ },
  {
    category: 'PRIVATE_SECRET_NAME',
    pattern: /\b(?:API_KEY_HMAC_SECRET|BROWSER_CSRF_SECRET|EVOLUTION_API_KEY|JWT_SECRET|REFRESH_TOKEN_HASH_SECRET)\b/,
  },
  {
    category: 'EVOLUTION_ADMINISTRATIVE_URL',
    pattern: /(?:https?:\/\/)?(?:evolution|127\.0\.0\.1|localhost):8080\b/i,
  },
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function inspectWebBundle(
  bundleDirectory,
  { canaries = [] } = {},
) {
  const root = resolve(bundleDirectory);
  const files = await filesUnder(root);
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const path = relative(root, file).replaceAll('\\', '/');
    for (const { category, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) findings.push({ category, path });
    }
    if (canaries.some((canary) => canary.length > 0 && content.includes(canary))) {
      findings.push({ category: 'SECRET_CANARY', path });
    }
  }
  return {
    fileCount: files.length,
    findings: findings.sort((left, right) => (
      left.path.localeCompare(right.path) || left.category.localeCompare(right.category)
    )),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await inspectWebBundle(
    process.argv[2] ?? resolve('apps/web/dist'),
    {
      canaries: (process.env.JRC_WEB_BUNDLE_CANARIES ?? '')
        .split(',')
        .filter((value) => value.length > 0),
    },
  );
  if (result.fileCount === 0) throw new Error('The production web bundle is empty');
  if (result.findings.length > 0) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
