import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEPENDENCY_INVENTORY, fileHash, readSourceManifest, runtimeInventory, sha } from './artifacts.mjs';
import { installRuntimeLifecycle, runtimeClosing, runtimeShutdownSignal, recordRuntimeFailure } from './runtime-lifecycle.mjs';
import { superviseEngineMain } from './supervisor.mjs';

export function validateEnvironment(env) {
  const capture = env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED ?? 'false';
  if (capture === 'true') throw Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');
  if (capture !== 'false') throw Error('ORIGIN_ENGINE_CAPTURE_FLAG_INVALID');
  if (env.DATABASE_PROVIDER !== undefined && env.DATABASE_PROVIDER !== 'postgresql') throw Error('ORIGIN_ENGINE_PROVIDER_UNSUPPORTED');
  env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED = 'false';
  env.DATABASE_PROVIDER = 'postgresql';
}

export async function readBuildAdmission(root, env = process.env) {
  validateEnvironment(env);
  const source = await readSourceManifest(root);
  const bytes = await readFile(join(root, 'jrc-engine-build.json'));
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'JRC_EVOLUTION_ENGINE_LAB_BUILD_V1' ||
    receipt.deliveryOwnership !== 'UNPROVEN' || receipt.sourceCommit !== source.sourceCommit ||
    receipt.dependencyInventory !== DEPENDENCY_INVENTORY ||
    receipt.nodeVersion !== process.version || !Array.isArray(receipt.artifacts) ||
    receipt.sourceManifestSha256 !== await fileHash(join(root, 'jrc-origin-provenance.json'))) {
    throw Error('ORIGIN_ENGINE_IMAGE_PROVENANCE_INVALID');
  }
  return { receipt, receiptSha256: sha(bytes) };
}

async function verifyEngine(root, env, signal) {
  const { receipt, receiptSha256 } = await readBuildAdmission(root, env);
  const scanStarted = performance.now();
  const actual = await runtimeInventory(root, { signal });
  if (JSON.stringify(actual) !== JSON.stringify(receipt.artifacts)) throw Error('ORIGIN_ENGINE_IMAGE_INPUT_CHANGED');
  signal?.throwIfAborted();
  console.error(`ORIGIN_ENGINE_INTEGRITY_VERIFIED artifacts=${actual.length} durationMs=${Math.round(performance.now() - scanStarted)}`);
  return { receiptSha256, sourceManifestSha256: receipt.sourceManifestSha256 };
}

export async function startEngine(root, env = process.env, { signal } = {}) {
  const admission = await verifyEngine(root, env, signal);
  signal?.throwIfAborted();
  const result = await superviseEngineMain(root, env, admission);
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw Error('ORIGIN_ENGINE_ENTRYPOINT_USAGE');
    installRuntimeLifecycle();
    await startEngine(process.cwd(), process.env, { signal: runtimeShutdownSignal() });
  } catch (error) {
    // Fixed text only: never leak a Prisma error, connection URI or raw config.
    if (!runtimeClosing() || error?.name !== 'AbortError') {
      const flag = process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
      console.error(flag === 'true' ? 'ORIGIN_ENGINE_OWNERSHIP_UNPROVEN' : 'ORIGIN_ENGINE_STARTUP_REFUSED');
      process.exitCode = 1;
      recordRuntimeFailure(1);
    }
  }
}
