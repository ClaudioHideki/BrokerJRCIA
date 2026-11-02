import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEPENDENCY_INVENTORY, fileHash, readSourceManifest, runtimeInventory } from './artifacts.mjs';

export function validateEnvironment(env) {
  const capture = env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED ?? 'false';
  if (capture === 'true') throw Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  if (capture !== 'false') throw Error('ORIGIN_ENGINE_CAPTURE_FLAG_INVALID');
  if (env.DATABASE_PROVIDER !== undefined && env.DATABASE_PROVIDER !== 'postgresql') throw Error('ORIGIN_ENGINE_PROVIDER_UNSUPPORTED');
  env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED = 'false';
  env.DATABASE_PROVIDER = 'postgresql';
}

export async function startEngine(root, env = process.env) {
  validateEnvironment(env);
  const source = await readSourceManifest(root);
  const receipt = JSON.parse(await readFile(join(root, 'jrc-engine-build.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'JRC_EVOLUTION_ENGINE_LAB_BUILD_V1' ||
    receipt.deliveryOwnership !== 'UNPROVEN' || receipt.sourceCommit !== source.sourceCommit ||
    receipt.dependencyInventory !== DEPENDENCY_INVENTORY ||
    receipt.nodeVersion !== process.version || !Array.isArray(receipt.artifacts) ||
    receipt.sourceManifestSha256 !== await fileHash(join(root, 'jrc-origin-provenance.json'))) {
    throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
  }
  const actual = await runtimeInventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.artifacts)) throw Error('ORIGIN_ENGINE_IMAGE_INPUT_CHANGED');
  return import(pathToFileURL(join(root, 'dist/main.js')).href);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw Error('ORIGIN_ENGINE_ENTRYPOINT_USAGE');
    await startEngine(process.cwd());
  } catch {
    // Fixed text only: never leak a Prisma error, connection URI or raw config.
    const flag = process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
    console.error(flag === 'true' ? 'ORIGIN_ENGINE_OWNERSHIP_UNPROVEN' : 'ORIGIN_ENGINE_STARTUP_REFUSED');
    process.exitCode = 1;
  }
}
