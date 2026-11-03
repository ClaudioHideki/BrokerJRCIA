import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BASE_IMAGE = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const SOURCE_COMMIT = 'fa09d37892cdbb1d65a250155d293d92230c5b30';
export const DEPENDENCY_INVENTORY = 'ALL_NODE_MODULES_V1';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function fileHash(path, signal) {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

function artifactPath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
    !/^[a-zA-Z]:/u.test(path) && !path.includes(String.fromCharCode(0)) &&
    !path.includes(String.fromCharCode(92)) && !path.split('/').some(part => !part || part === '.' || part === '..');
}

function inside(directory, path) {
  const part = relative(directory, path);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
}

async function binLink(root, path, signal) {
  const parts = path.split('/');
  if (parts[0] !== 'node_modules' || parts.at(-2) !== '.bin' || parts.at(-3) !== 'node_modules') {
    throw Error('ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED');
  }
  const moduleRoot = join(root, 'node_modules'), moduleStat = await lstat(moduleRoot);
  if (moduleStat.isSymbolicLink() || !moduleStat.isDirectory()) throw Error('ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED');
  const link = join(root, path), raw = await readlink(link);
  if (isAbsolute(raw) || /^[a-zA-Z]:/u.test(raw) || raw.startsWith(String.fromCharCode(92)) ||
    !inside(moduleRoot, resolve(dirname(link), raw))) throw Error('ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED');
  const target = await realpath(link), moduleRealRoot = await realpath(moduleRoot);
  if (!inside(moduleRealRoot, target) || !(await lstat(target)).isFile()) throw Error('ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED');
  return { path, type: 'bin-symlink', target: raw.replaceAll(String.fromCharCode(92), '/'),
    resolvedTarget: relative(moduleRealRoot, target).split(sep).join('/'), sha256: await fileHash(target, signal) };
}

export async function inventoryTree(directory, prefix = '') {
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw Error('ORIGIN_ENGINE_SOURCE_SYMLINK_REFUSED');
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), stat = await lstat(path), relative = prefix + name;
    if (stat.isSymbolicLink()) throw Error('ORIGIN_ENGINE_SOURCE_SYMLINK_REFUSED');
    if (stat.isDirectory()) result.push(...await inventoryTree(path, relative + '/'));
    else if (stat.isFile()) result.push({ path: relative, sha256: await fileHash(path) });
    else throw Error('ORIGIN_ENGINE_INPUT_TYPE_INVALID');
  }
  return result;
}

export async function readSourceManifest(root) {
  const manifest = JSON.parse(await readFile(join(root, 'jrc-origin-provenance.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'EVOLUTION_PINNED_LAB_STAGING' ||
    manifest.sourceCommit !== SOURCE_COMMIT || manifest.deliveryOwnership !== 'UNPROVEN' ||
    manifest.buildContext?.kind !== 'JRC_EVOLUTION_ENGINE_IMAGE_CONTEXT_V1' ||
    manifest.buildContext.baseImage !== BASE_IMAGE || manifest.buildContext.databaseProvider !== 'postgresql' ||
    manifest.buildContext.captureDefault !== false || !Array.isArray(manifest.buildContext.inputs) ||
    manifest.buildContext.inputs.length < 1) throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
  return manifest;
}

export async function verifyFiles(root, files) {
  const seen = new Set();
  for (const file of files) {
    if (!artifactPath(file.path) ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) || seen.has(file.path)) throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
    seen.add(file.path);
    if (file.type === 'bin-symlink') {
      if (JSON.stringify(await binLink(root, file.path)) !== JSON.stringify(file)) throw Error('ORIGIN_ENGINE_IMAGE_INPUT_CHANGED');
      continue;
    }
    if (file.type !== undefined) throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
    if (!(await lstat(join(root, file.path))).isFile() || await fileHash(join(root, file.path)) !== file.sha256) {
      throw Error('ORIGIN_ENGINE_IMAGE_INPUT_CHANGED');
    }
  }
}

export async function verifyContextInputs(root, manifest) {
  const inputs = manifest.buildContext.inputs;
  await verifyFiles(root, inputs);
  const trees = ['src', 'prisma', 'public', 'manager', 'jrc-origin', 'schema', 'jrc-image'];
  const actual = [];
  for (const tree of trees) actual.push(...await inventoryTree(join(root, tree), tree + '/'));
  const expected = inputs.filter(file => trees.includes(file.path.split('/')[0]));
  const ordered = files => files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(expected))) throw Error('ORIGIN_ENGINE_IMAGE_INPUT_CHANGED');
}

export async function runtimeInventory(root, { signal } = {}) {
  signal?.throwIfAborted();
  const files = [];
  const pending = ['dist', 'jrc-origin', 'jrc-image', 'schema', 'prisma', 'public', 'manager', 'node_modules']
    .map(path => ({ path, root: true }));
  pending.push(...['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'TRADEMARKS.md'].map(path => ({ path, leaf: true })));
  // At most eight metadata/hash operations and eight 64KiB read streams. Every
  // entry and link still receives the same lstat/realpath/content checks; no
  // inventory scope, receipt assertion or expected file is removed for speed.
  while (pending.length) {
    signal?.throwIfAborted();
    const outcomes = await Promise.allSettled(pending.splice(0, 8).map(async item => {
      const { path } = item, dependency = path === 'node_modules' || path.startsWith('node_modules/');
      if (!artifactPath(path)) throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
      signal?.throwIfAborted();
      const absolute = join(root, path), stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (dependency && !item.root) files.push(await binLink(root, path, signal));
        else throw Error(dependency ? 'ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED' : 'ORIGIN_ENGINE_SOURCE_SYMLINK_REFUSED');
      } else if (stat.isDirectory() && !item.leaf) {
        signal?.throwIfAborted();
        for (const name of await readdir(absolute)) pending.push({ path: path + '/' + name });
      } else if (stat.isFile() && !item.root) files.push({ path, sha256: await fileHash(absolute, signal) });
      else throw Error('ORIGIN_ENGINE_INPUT_TYPE_INVALID');
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
  signal?.throwIfAborted();
  for (const path of ['dist/main.js', 'node_modules/.prisma/client/index.js', 'node_modules/.prisma/client/schema.prisma']) {
    if (!files.some(file => file.path === path)) throw Error('ORIGIN_ENGINE_COMPILED_ARTIFACT_MISSING');
  }
  if (!files.some(file => file.path.startsWith('dist/translations/')) ||
    !files.some(file => /^node_modules\/\.prisma\/client\/libquery_engine-.*\.so\.node$/u.test(file.path))) {
    throw Error('ORIGIN_ENGINE_COMPILED_ARTIFACT_MISSING');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
