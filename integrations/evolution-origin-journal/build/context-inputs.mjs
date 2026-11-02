import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_SOURCE_COMMIT } from '../src/overlay.mjs';
import { BASE_IMAGE, inventoryTree } from '../../../infra/evolution/artifacts.mjs';

const vendor = fileURLToPath(new URL('../../../upstream/evolution-api/', import.meta.url));
const recipe = fileURLToPath(new URL('../../../infra/evolution/', import.meta.url));
const git = args => execFileSync(process.env.JRC_ENGINE_GIT_EXECUTABLE || 'git', ['-C', vendor, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
const tracked = paths => git(['ls-files', '-z', '--', ...paths]).split('\0').filter(Boolean);

export async function verifyPinnedImageSource() {
  if (git(['rev-parse', 'HEAD']).trim() !== PINNED_SOURCE_COMMIT || git(['status', '--porcelain', '--untracked-files=all']).trim()) {
    throw Error('ORIGIN_ENGINE_VENDOR_NOT_PINNED_CLEAN');
  }
  const expected = tracked(['src']).sort();
  const present = (await inventoryTree(join(vendor, 'src'))).map(file => `src/${file.path}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(present)) throw Error('ORIGIN_ENGINE_VENDOR_INPUTS_INVALID');
}

export async function completeEngineBuildContext(directory, manifest) {
  const paths = tracked(['prisma', 'public', 'manager']);
  for (const prefix of ['prisma/', 'public/', 'manager/']) {
    if (!paths.some(path => path.startsWith(prefix))) throw Error('ORIGIN_ENGINE_VENDOR_INPUTS_INVALID');
  }
  for (const path of paths) {
    if (!/^(prisma|public|manager)\//u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('ORIGIN_ENGINE_VENDOR_INPUTS_INVALID');
    }
    if (!(await lstat(join(vendor, path))).isFile()) throw Error('ORIGIN_ENGINE_SOURCE_SYMLINK_REFUSED');
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(vendor, path), join(directory, path));
  }
  await mkdir(join(directory, 'jrc-image'));
  for (const name of ['entrypoint.mjs', 'record-build.mjs', 'artifacts.mjs']) {
    await cp(join(recipe, name), join(directory, 'jrc-image', name));
  }
  for (const name of ['Dockerfile', '.dockerignore']) await cp(join(recipe, name), join(directory, name));
  const inputs = await inventoryTree(directory);
  manifest.buildContext = {
    kind: 'JRC_EVOLUTION_ENGINE_IMAGE_CONTEXT_V1', baseImage: BASE_IMAGE,
    databaseProvider: 'postgresql', captureDefault: false, inputs,
  };
  await writeFile(join(directory, 'jrc-origin-provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
}
