// Explicit artifact gates; not discovered as a unit suite and never an engine
// session/homologation test. No PG, network, application bootstrap or real data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.JRC_ENGINE_IMAGE_GATE_ID;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u, 'an explicit local immutable image ID is required');
const binary = process.env.JRC_ENGINE_DOCKER_EXECUTABLE || 'docker';
const task = 'engine-build-20261102', nonce = randomUUID().replaceAll('-', '').slice(0, 10);
const directory = fileURLToPath(new URL(`../build/image-gates-${nonce}/`, import.meta.url));
const canary = `JRC_SYNTHETIC_CANARY_${nonce}`, containers = new Set(), results = [];
const docker = (args, timeout = 20000) => {
  const started = performance.now();
  const result = spawnSync(binary, ['--context', 'desktop-linux', ...args], {
    encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
  });
  return { ...result, durationMs: Math.round(performance.now() - started) };
};
const must = args => {
  const result = docker(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'local Docker artifact operation failed');
  return result.stdout;
};
const inspect = JSON.parse(must(['image', 'inspect', '--format', '{{json .}}', image]));
assert.equal(inspect.Id, image);
assert.equal(inspect.Config.User, 'node');
assert.deepEqual(inspect.Config.Entrypoint, ['node', 'jrc-image/entrypoint.mjs']);
assert.equal(inspect.Config.Labels['jrc.task'], task);
assert.equal(inspect.Config.Labels['com.jrc.delivery-ownership'], 'UNPROVEN');
assert.equal(inspect.Config.Labels['com.jrc.evolution-source'], 'fa09d37892cdbb1d65a250155d293d92230c5b30');
await mkdir(directory);

function run(name, args, command = [], timeout = 20000) {
  const container = `jrc-engine-gate-${nonce}-${name}`;
  containers.add(container);
  return docker(['run', '--rm', '--name', container, '--label', `jrc.task=${task}`,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--memory', '192m', '--cpus', '1', ...args, image, ...command], timeout);
}
const mount = (source, target) => ['--mount', `type=bind,src=${source},dst=${target},readonly`];
const reader = `
import assert from 'node:assert/strict';
import {readFile,open} from 'node:fs/promises';
import {readSourceManifest,runtimeInventory,fileHash} from './jrc-image/artifacts.mjs';
const root=process.cwd(), source=await readSourceManifest(root);
const receiptText=await readFile('jrc-engine-build.json','utf8'),receipt=JSON.parse(receiptText);
assert.notEqual(process.getuid(),0);
assert.equal(process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED,'false');
assert.equal(receipt.deliveryOwnership,'UNPROVEN');
assert.equal(receipt.dependencyInventory,'ALL_NODE_MODULES_V1');
assert.equal(receipt.nodeVersion,process.version);
assert.equal(await fileHash('jrc-origin-provenance.json'),receipt.sourceManifestSha256);
const scanStarted=performance.now();
assert.deepEqual(await runtimeInventory(root),receipt.artifacts);
const scanDurationMs=Math.round(performance.now()-scanStarted);
const native=receipt.artifacts.find(file=>file.path.startsWith('node_modules/.prisma/client/libquery_engine-')&&file.path.endsWith('.so.node'));
assert.ok(native);
const descriptor=await open(native.path,'r'), header=Buffer.alloc(4);
try { await descriptor.read(header,0,4,0); } finally { await descriptor.close(); }
assert.deepEqual(header,Buffer.from([127,69,76,70]));
const client=JSON.parse(await readFile('node_modules/@prisma/client/package.json','utf8'));
assert.equal(client.version,'6.19.0');
console.log(JSON.stringify({uid:process.getuid(),clientVersion:client.version,node:process.version,sourceCommit:source.sourceCommit,artifactCount:receipt.artifacts.length,receiptBytes:Buffer.byteLength(receiptText),dependencyInventory:receipt.dependencyInventory,scanDurationMs,maxRSSKiB:process.resourceUsage().maxRSS,heapLimitMiB:128,containerLimitMiB:192}));
`;
try {
  // Export immutable metadata without starting this container or routing large
  // dependency inventories through stdout. Persist size/count before the scan.
  const receiptContainer = `jrc-engine-gate-${nonce}-receipt-source`;
  containers.add(receiptContainer);
  must(['create', '--name', receiptContainer, '--label', `jrc.task=${task}`, '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--memory', '192m', '--cpus', '1',
    '--entrypoint', 'node', image, '--eval', 'process.exit(0)']);
  const originalReceiptPath = join(directory, 'original-receipt.log');
  must(['cp', `${receiptContainer}:/evolution/jrc-engine-build.json`, originalReceiptPath]);
  let receiptText = await readFile(originalReceiptPath, 'utf8');
  const receiptBytes = Buffer.byteLength(receiptText);
  let validCanaryReceipt = JSON.parse(receiptText);
  receiptText = undefined;
  assert.equal(validCanaryReceipt.dependencyInventory, 'ALL_NODE_MODULES_V1');
  await writeFile(join(directory, 'receipt-claims.log'), JSON.stringify({
    receiptBytes, artifacts: validCanaryReceipt.artifacts.length, dependencyInventory: validCanaryReceipt.dependencyInventory,
    status: 'copied_metadata_not_yet_validated',
  }));
  // Full-tree build scan measured 142.8s and the 20s reader timed out. Only this
  // read-only inventory case gets 240s (1 CPU); admission negatives remain 20s.
  const contract = run('contract', ['--entrypoint', 'node'], ['--max-old-space-size=128', '--input-type=module', '-e', reader], 240000);
  await writeFile(join(directory, 'contract-output.log'), ((contract.stdout ?? '') + (contract.stderr ?? '')).replaceAll(canary, '[REDACTED_SYNTHETIC_CANARY]'));
  await writeFile(join(directory, 'contract-result.log'), JSON.stringify({status:contract.status,signal:contract.signal,errorCode:contract.error?.code}));
  assert.equal(contract.error, undefined);
  assert.equal(contract.status, 0, 'original image artifact contract failed');
  const original = JSON.parse(contract.stdout);
  await writeFile(join(directory, 'original-contract.log'), JSON.stringify(original, null, 2) + '\n');
  results.push({ case: 'original_image_artifact_contract', passed: true, uid: original.uid,
    clientVersion: original.clientVersion, artifacts: original.artifactCount, receiptBytes: original.receiptBytes,
    durationMs: contract.durationMs, scanDurationMs: original.scanDurationMs, maxRSSKiB: original.maxRSSKiB });
  assert.equal(receiptBytes, original.receiptBytes);
  assert.equal(validCanaryReceipt.artifacts.length, original.artifactCount);

  // Matching canary hashes remove unrelated file-integrity failures. If an
  // admission check is bypassed, only this harmless marker can execute, never
  // the real Evolution main. It exits immediately and performs no I/O.
  const main = `console.log(${JSON.stringify(canary)});process.exit(91);\n`;
  const mainPath = join(directory, 'main-canary.log');
  await writeFile(mainPath, main);
  const mainArtifact = validCanaryReceipt.artifacts.find(file => file.path === 'dist/main.js');
  assert.ok(mainArtifact);
  mainArtifact.sha256 = createHash('sha256').update(main).digest('hex');
  const validReceiptPath = join(directory, 'canary-receipt.log');
  await writeFile(validReceiptPath, JSON.stringify(validCanaryReceipt));
  const invalidReceiptPath = join(directory, 'tampered-receipt.log');
  validCanaryReceipt.deliveryOwnership = 'PROVEN';
  await writeFile(invalidReceiptPath, JSON.stringify(validCanaryReceipt));
  validCanaryReceipt = undefined;

  for (const scenario of [
    { name: 'capture_true', flag: 'true', receipt: validReceiptPath, expected: 'ORIGIN_ENGINE_OWNERSHIP_UNPROVEN' },
    { name: 'invalid_flag', flag: 'invalid', receipt: validReceiptPath, expected: 'ORIGIN_ENGINE_STARTUP_REFUSED' },
    { name: 'tampered_receipt', flag: 'false', receipt: invalidReceiptPath, expected: 'ORIGIN_ENGINE_STARTUP_REFUSED' },
  ]) {
    const result = run(scenario.name, [
      '--env', `JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=${scenario.flag}`,
      '--env', 'JRC_EVOLUTION_ORIGIN_OWNERSHIP_APPROVED=true',
      '--env', `DATABASE_CONNECTION_URI=postgresql://synthetic:${canary}@never-contact.invalid:1/jrc_engine_lab`,
      ...mount(mainPath, '/evolution/dist/main.js'),
      ...mount(scenario.receipt, '/evolution/jrc-engine-build.json'),
    ]);
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    const leaked = output.includes(canary);
    await writeFile(join(directory, `${scenario.name}.log`), output.replaceAll(canary, '[REDACTED_SYNTHETIC_CANARY]'));
    await writeFile(join(directory, `${scenario.name}-result.log`), JSON.stringify({status:result.status,signal:result.signal,errorCode:result.error?.code,canaryDisclosed:leaked}));
    assert.ok(!result.error, `${scenario.name}: timed out or process failed`);
    assert.equal(result.status, 1, `${scenario.name}: must fail closed`);
    assert.ok(output.includes(scenario.expected), `${scenario.name}: wrong refusal`);
    assert.equal(leaked, false, `${scenario.name}: canary import or disclosure`);
    assert.equal(result.stdout, '', `${scenario.name}: no engine output is permitted`);
    results.push({ case: scenario.name, passed: true, exitCode: result.status, canaryDisclosed: leaked, durationMs: result.durationMs });
  }
  const report = { image, task, network: 'none', readOnly: true, capDrop: 'ALL',
    realEngineBoot: false, postgresUsed: false, ownership: 'UNPROVEN', results };
  await writeFile(join(directory, 'report.log'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidenceDirectory: directory }));
} finally {
  const cleanup = [];
  const absent = result => !result.error && result.status !== 0 && /No such (?:container|object):/iu.test(result.stderr ?? '');
  for (const container of containers) {
    const state = docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', container], 5000);
    if (absent(state)) { cleanup.push({ container, status: 'confirmed_absent' }); continue; }
    if (state.error || state.status !== 0) { cleanup.push({ container, status: 'cleanup_unproven', phase: 'inspect' }); continue; }
    assert.equal(JSON.parse(state.stdout)['jrc.task'], task, 'refuse cleanup of another task');
    docker(['stop', '--time', '1', container], 5000);
    const stopped = docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', container], 5000);
    if (absent(stopped)) { cleanup.push({ container, status: 'confirmed_absent_after_stop' }); continue; }
    if (stopped.error || stopped.status !== 0) { cleanup.push({ container, status: 'cleanup_unproven', phase: 'inspect_after_stop' }); continue; }
    assert.equal(JSON.parse(stopped.stdout)['jrc.task'], task, 'refuse cleanup of another task');
    const removed = docker(['rm', container], 5000);
    let final;
    for (let attempt = 0; attempt < 5; attempt++) {
      final = docker(['container','inspect',container],5000);
      if (absent(final)) break;
      // --rm may still be completing after stop; read only this exact owned
      // name again. A daemon failure never becomes an absence claim.
      if (attempt < 4) await delay(200);
    }
    cleanup.push({ container, status: absent(final) ? 'confirmed_removed' : 'cleanup_unproven', removeExitCode: removed.status,
      ...(absent(final) ? {} : { inspectExitCode: final.status, inspectErrorCode: final.error?.code, inspectStderr: final.stderr }) });
  }
  await writeFile(join(directory, 'cleanup.log'), JSON.stringify(cleanup, null, 2) + '\n');
  assert.ok(cleanup.every(item => item.status !== 'cleanup_unproven'), 'owned cleanup unproven; inspect cleanup.log without broad removal');
}
