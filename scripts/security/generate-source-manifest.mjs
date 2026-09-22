import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function generateSourceManifest({ rootDirectory = process.cwd() } = {}) {
  const root = resolve(rootDirectory);
  const safeRoot = root.replaceAll('\\', '/');
  const files = execFileSync('git', [
    '-c', `safe.directory=${safeRoot}`,
    'ls-files', '--cached', '--others', '--exclude-standard',
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path !== 'MANIFESTO_ARQUIVOS_SHA256.txt')
    .filter((path) => !path.startsWith('.worktrees/') && !path.startsWith('.superpowers/'))
    .filter((path) => {
      try { return lstatSync(resolve(root, path)).isFile(); } catch { return false; }
    })
    .sort();
  const lines = files.map((path) => (
    `${createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex').toUpperCase()}  ${path}`
  ));
  await writeFile(resolve(root, 'MANIFESTO_ARQUIVOS_SHA256.txt'), `${lines.join('\n')}\n`);
  return { files: files.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await generateSourceManifest();
  process.stdout.write(`Source manifest generated (${result.files} files)\n`);
}
