import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile, readdir, writeFile, mkdir, mkdtemp, symlink, unlink, rename, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stagePinnedEngine, removeOwnStage } from '../build/stage-engine.mjs';
import { runtimeInventory, fileHash } from '../../../infra/evolution/artifacts.mjs';

test('runtime inventory cancellation stops before touching artifacts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtimeInventory('nonexistent-cancelled-engine', { signal: controller.signal }), { name: 'AbortError' });
});

test('runtime hash cancellation interrupts an already opened stream', async () => {
  const parent = fileURLToPath(new URL('../.staging/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'engine-')), path = join(root, 'synthetic-large-file');
  try {
    const descriptor = await open(path, 'w');
    try { await descriptor.truncate(16 * 1024 * 1024); } finally { await descriptor.close(); }
    const controller = new AbortController(), hashing = fileHash(path, controller.signal);
    const rejected = assert.rejects(hashing, { name: 'AbortError' });
    setImmediate(() => controller.abort());
    await rejected;
  } finally { await removeOwnStage(root); }
});

test('image context CLI finishes and returns its own disposable directory', async () => {
  const cli = fileURLToPath(new URL('../build/context-engine.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', cli], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, env: process.env,
  });
  let stage;
  try {
    assert.equal(result.status, 0, result.stderr);
    stage = JSON.parse(result.stdout);
    assert.equal(stage.manifest.buildContext.databaseProvider, 'postgresql');
    await access(join(stage.directory, 'Dockerfile'));
  } finally {
    if (stage) await removeOwnStage(stage.directory);
  }
});

// Break caught: a staged src-only tree cannot generate its own Prisma client or
// serve its upstream assets, even though the old overlay staging test passes.
test('image context contains its own Prisma inputs, assets, recipe and provenance', async () => {
  const stage = await stagePinnedEngine({ imageContext: true });
  try {
    const entries = await readdir(stage.directory);
    for (const required of ['prisma', 'public', 'manager', 'Dockerfile', 'jrc-image']) {
      assert.ok(entries.includes(required), `complete image context lacks ${required}`);
    }
    await access(join(stage.directory, 'prisma/postgresql-schema.prisma'));
    await access(join(stage.directory, 'jrc-image/entrypoint.mjs'));
    await access(join(stage.directory, 'jrc-image/record-build.mjs'));
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) await access(join(stage.directory, name));
    assert.equal(stage.manifest.sourceCommit, 'fa09d37892cdbb1d65a250155d293d92230c5b30');
    assert.equal(stage.manifest.deliveryOwnership, 'UNPROVEN');
    assert.equal(stage.manifest.buildContext.captureDefault, false);
    assert.equal(stage.manifest.buildContext.databaseProvider, 'postgresql');
    assert.ok(stage.manifest.buildContext.inputs.some(file => file.path === 'prisma/postgresql-schema.prisma'));
    assert.ok(stage.manifest.buildContext.inputs.some(file => file.path.startsWith('manager/')));
    assert.ok(stage.manifest.buildContext.inputs.some(file => file.path.startsWith('public/')));
    assert.deepEqual(JSON.parse(await readFile(join(stage.directory, 'jrc-origin-provenance.json'), 'utf8')), stage.manifest);
  } finally {
    await removeOwnStage(stage.directory);
  }
});

test('stage cleanup refuses a junction alias instead of deleting its real target', async () => {
  const parent = fileURLToPath(new URL('../.staging/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const target = await mkdtemp(join(parent, 'engine-'));
  const alias = target + '-alias';
  try {
    await writeFile(join(target, 'keep'), 'owned test directory');
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(removeOwnStage(alias), /ORIGIN_ENGINE_STAGE_DELETE_REFUSED/u);
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'owned test directory');
    await assert.rejects(removeOwnStage(parent), /ORIGIN_ENGINE_STAGE_DELETE_REFUSED/u);
  } finally {
    await unlink(alias).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removeOwnStage(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
});

// Artifacts below are explicitly synthetic process fixtures. No client binary
// is executed, no socket is opened, and this does not count as an engine build.
test('entrypoint verifies a build receipt, defaults capture false and refuses tampered artifacts', async () => {
  const stage = await stagePinnedEngine({ imageContext: true });
  const run = (script, overrides = {}) => {
    const env = { ...process.env, ...overrides };
    if (!Object.hasOwn(overrides, 'JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED')) delete env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED;
    delete env.DATABASE_PROVIDER;
    return spawnSync(process.execPath, ['--max-old-space-size=128', script], {
      cwd: stage.directory, encoding: 'utf8', timeout: 30000, env,
    });
  };
  try {
    const artifacts = {
      'dist/main.js': 'console.log(JSON.stringify({ fixture: "PROCESS_ONLY", capture: process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED, provider: process.env.DATABASE_PROVIDER }));',
      'dist/translations/en.json': '{}',
      'node_modules/.prisma/client/index.js': '// synthetic process guard fixture',
      'node_modules/.prisma/client/schema.prisma': '// synthetic process guard fixture',
      'node_modules/.prisma/client/libquery_engine-test.so.node': 'NOT_AN_EXECUTABLE_CLIENT',
      'node_modules/@prisma/client/package.json': '{"name":"process-fixture-only"}',
    };
    for (const [path, contents] of Object.entries(artifacts)) {
      await mkdir(dirname(join(stage.directory, path)), { recursive: true });
      await writeFile(join(stage.directory, path), contents);
    }
    const missingReceipt = run('jrc-image/entrypoint.mjs');
    assert.equal(missingReceipt.status, 1);
    assert.equal(missingReceipt.stdout, '');
    const recorded = run('jrc-image/record-build.mjs');
    assert.equal(recorded.error, undefined);
    assert.equal(recorded.status, 0, recorded.stderr);
    const started = run('jrc-image/entrypoint.mjs');
    assert.equal(started.status, 0, started.stderr);
    assert.deepEqual(JSON.parse(started.stdout), { fixture: 'PROCESS_ONLY', capture: 'false', provider: 'postgresql' });
    for (const flag of ['true', 'TRUE', '', '1']) {
      const refused = run('jrc-image/entrypoint.mjs', { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: flag });
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, '');
    }
    const publicPath = join(stage.directory, 'public');
    const detachedPublic = join(stage.directory, 'detached-public');
    await rename(publicPath, detachedPublic);
    try {
      await symlink(detachedPublic, publicPath, process.platform === 'win32' ? 'junction' : 'dir');
      const redirected = run('jrc-image/entrypoint.mjs');
      assert.equal(redirected.status, 1, 'runtime inventory must refuse a symlinked asset root');
      assert.equal(redirected.stdout, '');
    } finally {
      await unlink(publicPath);
      await rename(detachedPublic, publicPath);
    }
    await writeFile(join(stage.directory, 'dist/main.js'), 'console.log("TAMPERED_ENTRY_MUST_NOT_LOAD")');
    const tampered = run('jrc-image/entrypoint.mjs');
    assert.equal(tampered.status, 1);
    assert.equal(tampered.stdout, '');
    await writeFile(join(stage.directory, 'dist/main.js'), artifacts['dist/main.js']);
    const receiptPath = join(stage.directory, 'jrc-engine-build.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.deliveryOwnership = 'PROVEN';
    await writeFile(receiptPath, JSON.stringify(receipt));
    const forged = run('jrc-image/entrypoint.mjs');
    assert.equal(forged.status, 1);
    assert.equal(forged.stdout, '');
    await writeFile(join(stage.directory, 'public/unmanifested.txt'), 'must not enter an attested image');
    const extraAsset = run('jrc-image/record-build.mjs');
    assert.equal(extraAsset.status, 1, 'build receipt must refuse an asset absent from the staged manifest');
  } finally {
    await removeOwnStage(stage.directory);
  }
});

// This is a process guard test, not an engine boot/session test. The marker
// proves the compiled entry has not been evaluated before ownership is checked.
test('capture true fails before loading any compiled engine even with approval-looking environment', async () => {
  const stage = await stagePinnedEngine({ imageContext: true });
  try {
    await mkdir(join(stage.directory, 'dist'));
    await writeFile(join(stage.directory, 'dist/main.js'), 'console.log("ENGINE_MUST_NOT_LOAD");');
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', 'jrc-image/entrypoint.mjs'], {
      cwd: stage.directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true', JRC_EVOLUTION_ORIGIN_OWNERSHIP_APPROVED: 'true' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ORIGIN_ENGINE_OWNERSHIP_UNPROVEN/u);
    assert.doesNotMatch(result.stdout, /ENGINE_MUST_NOT_LOAD/u);
  } finally {
    await removeOwnStage(stage.directory);
  }
});

test('image context excludes upstream migration helpers and ambient configuration', async () => {
  const stage = await stagePinnedEngine({ imageContext: true });
  try {
    for (const forbidden of ['.env', '.env.example', '.git', 'Docker', 'runWithProvider.js', 'node_modules', 'dist']) {
      await assert.rejects(access(join(stage.directory, forbidden)), { code: 'ENOENT' });
    }
  } finally {
    await removeOwnStage(stage.directory);
  }
});

test('runtime dependency drift is refused before main imports its non-Prisma package', async t => {
  const stage = await stagePinnedEngine({ imageContext: true });
  const packagePath = join(stage.directory, 'node_modules/runtime-dependency');
  const original = 'module.exports = "ORIGINAL_DEPENDENCY";';
  const run = script => spawnSync(process.execPath, ['--max-old-space-size=128', script], {
    cwd: stage.directory, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'false', DATABASE_PROVIDER: 'postgresql' },
  });
  try {
    const artifacts = {
      'dist/main.js': 'console.log("MAIN_ENTERED");console.log(require("runtime-dependency"));',
      'dist/translations/en.json': '{}',
      'node_modules/.prisma/client/index.js': '// synthetic process fixture',
      'node_modules/.prisma/client/schema.prisma': '// synthetic process fixture',
      'node_modules/.prisma/client/libquery_engine-test.so.node': 'NOT_AN_EXECUTABLE_CLIENT',
      'node_modules/@prisma/client/package.json': '{"name":"process-fixture-only"}',
      'node_modules/runtime-dependency/package.json': '{"name":"runtime-dependency","version":"1.0.0","main":"index.js"}',
      'node_modules/runtime-dependency/index.js': original,
      'node_modules/runtime-dependency/notice with spaces.txt': 'synthetic dependency notice',
      'node_modules/.bin/runtime-tool.cmd': '@echo off\r\nrem synthetic npm Windows shim\r\n',
    };
    for (const [path, contents] of Object.entries(artifacts)) {
      await mkdir(dirname(join(stage.directory, path)), { recursive: true });
      await writeFile(join(stage.directory, path), contents);
    }
    const recorded = run('jrc-image/record-build.mjs');
    assert.equal(recorded.status, 0, recorded.stderr);
    const baseline = run('jrc-image/entrypoint.mjs');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.stdout.trim(), 'MAIN_ENTERED\nORIGINAL_DEPENDENCY');

    for (const mutation of ['modification', 'addition', 'removal', 'junction']) {
      await t.test(mutation, async () => {
        const detached = join(stage.directory, 'detached-runtime-dependency');
        try {
          if (mutation === 'modification') await writeFile(join(packagePath, 'index.js'), 'module.exports = "ALTERED_DEPENDENCY";');
          if (mutation === 'addition') await writeFile(join(packagePath, 'unexpected.js'), '// unexpected dependency file');
          if (mutation === 'removal') await unlink(join(packagePath, 'index.js'));
          if (mutation === 'junction') {
            await rename(packagePath, detached);
            await symlink(detached, packagePath, process.platform === 'win32' ? 'junction' : 'dir');
          }
          const refused = run('jrc-image/entrypoint.mjs');
          assert.equal(refused.error, undefined);
          assert.equal(refused.status, 1, `${mutation}: dependency drift must fail closed`);
          assert.equal(refused.stdout, '', `${mutation}: main must not be imported`);
          assert.match(refused.stderr, /ORIGIN_ENGINE_STARTUP_REFUSED/u);
        } finally {
          if (mutation === 'junction') {
            await unlink(packagePath);
            await rename(detached, packagePath);
          } else if (mutation === 'addition') await unlink(join(packagePath, 'unexpected.js'));
          else await writeFile(join(packagePath, 'index.js'), original);
        }
      });
    }
    await t.test('receipt includes the imported package and Windows bin shims', async () => {
      const receipt = JSON.parse(await readFile(join(stage.directory, 'jrc-engine-build.json'), 'utf8'));
      for (const path of ['node_modules/runtime-dependency/index.js', 'node_modules/runtime-dependency/notice with spaces.txt', 'node_modules/.bin/runtime-tool.cmd']) {
        assert.ok(receipt.artifacts.some(file => file.path === path), `runtime receipt omits ${path}`);
      }
    });
    await t.test('bin shim alteration is refused before main', async () => {
      const shim = join(stage.directory, 'node_modules/.bin/runtime-tool.cmd');
      const content = await readFile(shim, 'utf8');
      try {
        await writeFile(shim, '@echo off\r\nrem ALTERED_SHIM\r\n');
        const refused = run('jrc-image/entrypoint.mjs');
        assert.equal(refused.status, 1);
        assert.equal(refused.stdout, '');
      } finally { await writeFile(shim, content); }
    });
    await t.test('bin junction escape is refused before main', async () => {
      const link = join(stage.directory, 'node_modules/.bin/foreign-tool');
      const external = join(stage.directory, 'external-bin-target');
      await mkdir(external);
      try {
        await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
        const refused = run('jrc-image/entrypoint.mjs');
        assert.equal(refused.status, 1);
        assert.equal(refused.stdout, '');
      } finally { await unlink(link); }
    });
  } finally {
    await removeOwnStage(stage.directory);
  }
});

// Select this case for a lightweight POSIX check: no Git, source staging, Docker
// orchestration, real Prisma client, engine main, database or network is used.
test('runtime bins use the platform representation and confine links', async () => {
  const parent = fileURLToPath(new URL('../.staging/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'engine-'));
  try {
    for (const path of ['dist', 'jrc-origin', 'jrc-image', 'schema', 'prisma', 'public', 'manager']) {
      await mkdir(join(root, path), { recursive: true });
    }
    const moduleSource = 'module.exports = "BIN_POLICY_FIXTURE";';
    const fixture = {
      'dist/main.js': '// never executed', 'dist/translations/en.json': '{}',
      'node_modules/.prisma/client/index.js': '// synthetic fixture',
      'node_modules/.prisma/client/schema.prisma': '// synthetic fixture',
      'node_modules/.prisma/client/libquery_engine-test.so.node': 'NOT_AN_EXECUTABLE_CLIENT',
      'node_modules/@prisma/client/package.json': '{}',
      'node_modules/runtime-dependency/index.js': moduleSource,
      'node_modules/runtime-dependency/alternate.js': moduleSource,
      'outside-bin.js': '// must never be hashed through a link',
      'package.json': '{}', 'package-lock.json': '{}', 'LICENSE': 'fixture', 'NOTICE': 'fixture', 'TRADEMARKS.md': 'fixture',
    };
    for (const [path, content] of Object.entries(fixture)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await mkdir(join(root, 'node_modules/.bin'));
    if (process.platform === 'win32') {
      const shim = 'node synthetic-tool.js\r\n';
      await writeFile(join(root, 'node_modules/.bin/tool.cmd'), shim);
      const rows = await runtimeInventory(root);
      assert.deepEqual(rows.find(row => row.path === 'node_modules/.bin/tool.cmd'), {
        path: 'node_modules/.bin/tool.cmd', sha256: createHash('sha256').update(shim).digest('hex'),
      });
      const alias = join(root, 'node_modules/.bin/directory-alias');
      await symlink(join(root, 'node_modules/runtime-dependency'), alias, 'junction');
      await assert.rejects(runtimeInventory(root), { message: 'ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED' });
      await unlink(alias);
    } else {
      const bin = join(root, 'node_modules/.bin/tool');
      await symlink('../runtime-dependency/index.js', bin, 'file');
      const before = await runtimeInventory(root);
      const expected = { path: 'node_modules/.bin/tool', type: 'bin-symlink', target: '../runtime-dependency/index.js',
        resolvedTarget: 'runtime-dependency/index.js', sha256: createHash('sha256').update(moduleSource).digest('hex') };
      assert.deepEqual(before.find(row => row.path === expected.path), expected);
      await unlink(bin);
      await symlink('../runtime-dependency/alternate.js', bin, 'file');
      const retargeted = (await runtimeInventory(root)).find(row => row.path === expected.path);
      assert.equal(retargeted.sha256, expected.sha256);
      assert.notDeepEqual(retargeted, expected, 'equal bytes do not hide a changed bin target');
      await unlink(bin);
      for (const target of [join(root, 'node_modules/runtime-dependency/index.js'), '../../outside-bin.js', '../runtime-dependency', '../runtime-dependency/missing.js']) {
        await symlink(target, bin, 'file');
        try {
          const error = target.endsWith('/missing.js') ? { code: 'ENOENT' } : { message: 'ORIGIN_ENGINE_DEPENDENCY_SYMLINK_REFUSED' };
          await assert.rejects(runtimeInventory(root), error);
        } finally { await unlink(bin); }
      }
      const nested = join(root, 'node_modules/runtime-dependency/node_modules');
      await mkdir(join(nested, '.bin'), { recursive: true });
      await mkdir(join(nested, 'sub-dependency'));
      await writeFile(join(nested, 'sub-dependency/cli.js'), moduleSource);
      await symlink('../sub-dependency/cli.js', join(nested, '.bin/sub-tool'), 'file');
      const rows = await runtimeInventory(root);
      assert.equal(rows.find(row => row.path.endsWith('/.bin/sub-tool')).resolvedTarget, 'runtime-dependency/node_modules/sub-dependency/cli.js');
    }
  } finally { await removeOwnStage(root); }
});
