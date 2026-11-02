import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEPENDENCY_INVENTORY, fileHash, readSourceManifest, runtimeInventory, verifyContextInputs } from './artifacts.mjs';

export async function recordBuild(root) {
  const source = await readSourceManifest(root);
  await verifyContextInputs(root, source);
  const receipt = {
    schemaVersion: 1, kind: 'JRC_EVOLUTION_ENGINE_LAB_BUILD_V1',
    deliveryOwnership: 'UNPROVEN', sourceCommit: source.sourceCommit,
    dependencyInventory: DEPENDENCY_INVENTORY,
    sourceManifestSha256: await fileHash(join(root, 'jrc-origin-provenance.json')),
    nodeVersion: process.version, artifacts: await runtimeInventory(root),
  };
  await writeFile(join(root, 'jrc-engine-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw Error('ORIGIN_ENGINE_BUILD_RECEIPT_USAGE');
  await recordBuild(process.cwd());
}
