import { readFile, writeFile, mkdir, mkdtemp, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { inspectWebBundle } from './security/check-web-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), outputAt = args.indexOf('--out'), installAt = args.indexOf('--install-jrc');
const allowed = new Set(['--allow-dirty', '--out', '--install-jrc', ...(outputAt >= 0 ? [args[outputAt + 1]] : []), ...(installAt >= 0 ? [args[installAt + 1]] : [])]);
if (args.some(arg => !allowed.has(arg)) || outputAt >= 0 && !args[outputAt + 1] || installAt >= 0 && !args[installAt + 1] || outputAt >= 0 && installAt >= 0) {
  throw new Error('Usage: node scripts/build-native-flow-editor.mjs [--out directory | --install-jrc candidate-checkout] [--allow-dirty]');
}
const host = installAt >= 0 ? path.resolve(root, args[installAt + 1]) : null;
if (host) {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: host, encoding: 'utf8' }).trim();
  if (!branch.startsWith('codex/') || args.includes('--allow-dirty')) throw new Error('Install only committed source into an isolated codex/ host branch.');
}
const output = host ? path.join(host, 'public/jrc-flow-editor') : path.resolve(root, outputAt >= 0 ? args[outputAt + 1] : '.sessions/native-flow-editor');
if (output === root || output === path.parse(output).root) throw new Error('An explicit artifact directory is required.');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const sourceSha = git('rev-parse', 'HEAD').trim(), allowDirty = args.includes('--allow-dirty');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value.toString().replaceAll('\r\n', '\n');
const stagingParent = host ? path.join(host, '.sessions/native-flow-editor-build') : path.dirname(output);
await mkdir(stagingParent, { recursive: true });
const staging = await mkdtemp(path.join(stagingParent, '.jrc-native-editor-'));
const privateArtifact = candidate => path.dirname(path.resolve(candidate)) === stagingParent && path.basename(candidate).startsWith('.jrc-native-editor-');
async function discard(candidate) {
  if (!privateArtifact(candidate)) throw new Error('Refusing cleanup outside the private build directory.');
  await rm(candidate, { recursive: true, force: true });
}
async function promote() {
  const backup = staging + '-previous';
  if (!privateArtifact(staging) || !privateArtifact(backup)) throw new Error('Refusing promotion outside the private build directory.');
  const versionFile = host ? path.join(host, 'app/javascript/dashboard/routes/dashboard/jrcFlows/nativeEditorBuild.js') : null;
  const versionStage = versionFile ? path.join(path.dirname(versionFile), '.' + path.basename(staging) + '.js') : null;
  let previous = false, installed = false;
  try {
    if (versionStage) await writeFile(versionStage,
      '// Generated together with public/jrc-flow-editor from the committed Broker source.\n' +
      `export const nativeEditorBuild = '${sourceSha}';\n`, { flag: 'wx' });
    try {
      if (!(await lstat(output)).isDirectory()) throw new Error('The artifact target must be a directory.');
      await rename(output, backup); previous = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(output), { recursive: true });
    await rename(staging, output); installed = true;
    if (versionStage) await rename(versionStage, versionFile);
  } catch (error) {
    // No fallible validation runs after promotion. If either rename fails,
    // restore the previous public tree before reporting the build as failed.
    if (installed) await rename(output, staging);
    if (previous) await rename(backup, output);
    throw error;
  } finally {
    if (versionStage) await rm(versionStage, { force: true });
  }
  if (previous) await discard(backup).catch(() => process.stderr.write('Previous verified artifact retained in the private build directory.\n'));
}
try {
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: ['apps/web/src/native-flow/entry.tsx'], outfile: path.join(staging, 'editor.js'),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], jsx: 'automatic', minify: true,
    // Escape multiline templates as strings; preserve their values while making
    // the generated artifact compatible with the host's Git whitespace gate.
    supported: { 'template-literal': false },
    metafile: true, sourcemap: false, legalComments: 'external',
    tsconfig: path.join(root, 'apps/web/tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true',
      '__JRC_NATIVE_EDITOR_SOURCE__': JSON.stringify(sourceSha) },
    plugins: [{ name: 'current-workspace-contracts-and-ui', setup(build) {
      build.onResolve({ filter: /^@jrc\/(contracts|ui)$/ }, args => ({ path: path.join(root, `packages/${args.path.split('/')[1]}/src/index.ts`) }));
    } }],
  });
  const inputs = [];
  let dirty = false;
  const inputFiles = new Set([...Object.keys(result.metafile.inputs), 'scripts/build-native-flow-editor.mjs',
    'scripts/security/check-web-bundle.mjs', 'package.json', 'package-lock.json', 'apps/web/tsconfig.json',
    'tsconfig.base.json', 'apps/web/public/THIRD_PARTY_NOTICES.txt']);
  for (const file of [...inputFiles].sort()) {
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (relative.startsWith('../')) throw new Error('Build input escaped the workspace: ' + relative);
    const bytes = await readFile(absolute), dependency = relative.startsWith('node_modules/');
    if (!dependency) {
      let committed; try { committed = git('show', `${sourceSha}:${relative}`); } catch { committed = null; }
      if (committed === null || canonical(bytes) !== canonical(committed)) dirty = true;
    }
    inputs.push({ path: relative, sha256: digest(bytes), dependency });
  }
  if (dirty && !allowDirty) throw new Error('Native editor inputs differ from the exact committed source. Commit them before producing a release artifact.');
  const notices = await readFile(path.join(root, 'apps/web/public/THIRD_PARTY_NOTICES.txt'));
  await writeFile(path.join(staging, 'THIRD_PARTY_NOTICES.txt'), notices);
  const outputs = [];
  for (const file of [...Object.keys(result.metafile.outputs).map(file => path.resolve(root, file)), path.join(staging, 'THIRD_PARTY_NOTICES.txt')].sort()) {
    const relative = path.relative(staging, file).replaceAll('\\', '/');
    if (relative.startsWith('../')) throw new Error('Build output escaped its artifact directory.');
    const bytes = await readFile(file); outputs.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  const inspection = await inspectWebBundle(staging);
  if (inspection.findings.length) throw new Error('Native editor public bundle inspection failed: ' + JSON.stringify(inspection.findings));
  const manifest = { schemaVersion: 1, component: 'jrc-native-flow-editor', sourceRepository: 'ClaudioHideki/BrokerJRCIA', sourceSha,
    sourceCommitted: !dirty, lockfileSha256: digest(await readFile(path.join(root, 'package-lock.json'))),
    inputs, outputs, inspection };
  await writeFile(path.join(staging, 'EDITOR-BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  await promote();
  console.log(JSON.stringify({ sourceSha, sourceCommitted: !dirty, inputs: inputs.length, outputs, findings: inspection.findings.length }));
} finally {
  await discard(staging);
}
