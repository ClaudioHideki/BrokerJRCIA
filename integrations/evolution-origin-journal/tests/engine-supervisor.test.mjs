import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { get } from 'node:http';
import { stagePinnedEngine, removeOwnStage } from '../build/stage-engine.mjs';

test('verified engine supervision preserves startup cancellation, ready drain and child outcomes', { timeout: 120000 }, async t => {
  const stage = await stagePinnedEngine({ imageContext: true });
  const fixture = `console.log('FIXTURE_PID '+process.pid);
const mode=process.env.SYNTHETIC_ENGINE_MODE;
if(mode.startsWith('busy')){console.log('FIXTURE_BUSY');const end=Date.now()+4000;while(Date.now()<end){};process.exit(0);}
if(mode==='exit')process.exit(23);
if(mode==='crash')process.kill(process.pid,'SIGKILL');
if(mode==='hung'){process.on('SIGTERM',()=>{});process.send({kind:'JRC_ENGINE_HTTP_READY_V1'});console.log('FIXTURE_HUNG');while(true){}}
if(mode==='ready')(async()=>{const lifecycle=await import('../jrc-origin/runtime-lifecycle.mjs');lifecycle.installRuntimeLifecycle();
 const server=require('node:http').createServer((_req,res)=>{console.log('FIXTURE_REQUEST');setTimeout(()=>res.end('drained'),150);});
 lifecycle.registerRuntimeHttp(server);lifecycle.registerRuntimeResource({},async()=>console.log('FIXTURE_RESOURCE_CLOSED'));
 server.listen(0,'127.0.0.1',()=>{lifecycle.markRuntimeReady?.();console.log('FIXTURE_READY '+server.address().port);});})();`;
  try {
    for (const [path, content] of Object.entries({
      'dist/main.js': fixture, 'dist/translations/en.json': '{}',
      'node_modules/.prisma/client/index.js': '// fixture', 'node_modules/.prisma/client/schema.prisma': '// fixture',
      'node_modules/.prisma/client/libquery_engine-test.so.node': 'NOT_EXECUTABLE', 'node_modules/@prisma/client/package.json': '{}',
    })) { await mkdir(dirname(join(stage.directory, path)), { recursive: true }); await writeFile(join(stage.directory, path), content); }
    await writeFile(join(stage.directory, 'signal-driver.mjs'), `import {startEngine} from './jrc-image/entrypoint.mjs';
import {installRuntimeLifecycle,runtimeShutdownSignal} from './jrc-origin/runtime-lifecycle.mjs';
installRuntimeLifecycle();process.on('message',message=>{if(message==='stop')process.emit('SIGTERM');if(message==='stop-int')process.emit('SIGINT');});process.channel.unref();
await startEngine(process.cwd(),process.env,{signal:runtimeShutdownSignal()});`);
    const recorded = spawnSync(process.execPath, ['jrc-image/record-build.mjs'], { cwd: stage.directory, encoding: 'utf8', timeout: 30000 });
    assert.equal(recorded.status, 0, recorded.stderr);
    for (const mode of ['busy', 'busy-int', 'ready', 'exit', 'crash', 'hung']) await t.test(mode, { timeout: 15000 }, async () => {
      const child = fork(join(stage.directory, 'signal-driver.mjs'), [], { cwd: stage.directory, execArgv: ['--max-old-space-size=128'],
        env: { ...process.env, JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'false', DATABASE_PROVIDER: 'postgresql', SYNTHETIC_ENGINE_MODE: mode },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '', stderr = '', signalAt, response, requestStarted = false, mainPid, forced = false;
      const stop = () => { if (signalAt !== undefined) return; signalAt = performance.now();
        if (process.platform === 'win32') child.send(mode === 'busy-int' ? 'stop-int' : 'stop'); else child.kill(mode === 'busy-int' ? 'SIGINT' : 'SIGTERM'); };
      child.stdout.on('data', chunk => {
        stdout += chunk;
        mainPid = Number(/FIXTURE_PID (\d+)/u.exec(stdout)?.[1]) || mainPid;
        if (mode.startsWith('busy') && stdout.includes('FIXTURE_BUSY')) stop();
        if (mode === 'hung' && stdout.includes('FIXTURE_HUNG')) setTimeout(stop, 50);
        const port = /FIXTURE_READY (\d+)/u.exec(stdout)?.[1];
        if (mode === 'ready' && port && !requestStarted) {
          requestStarted = true;
          response = new Promise((resolve, reject) => {
            get(`http://127.0.0.1:${port}/`, res => { let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolve(body)); }).on('error', reject);
          }); response.catch(() => {});
        }
        if (mode === 'ready' && stdout.includes('FIXTURE_REQUEST')) stop();
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
      try {
        const outcome = await new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
        if (mode.startsWith('busy')) {
          assert.equal(outcome.code, mode === 'busy-int' ? 130 : 143, 'cancelled main import must preserve the requested signal');
          assert.ok(performance.now() - signalAt < 2000, 'supervisor must remain responsive while main import is synchronous');
          assert.doesNotMatch(stderr, /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u);
        } else if (mode === 'ready') {
          assert.equal(await response, 'drained'); assert.equal(outcome.code, 0, stderr);
          assert.match(stdout, /FIXTURE_RESOURCE_CLOSED/u); assert.match(stderr, /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u);
        } else if (mode === 'hung') {
          assert.equal(outcome.code, 137, stderr);
          assert.ok(performance.now() - signalAt >= 7000);
          assert.ok(performance.now() - signalAt < 9000);
          assert.match(stderr, /ORIGIN_ENGINE_MAIN_EXIT .*ready=true forced=true/u);
          assert.doesNotMatch(stderr, /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u);
        } else if (mode === 'exit') assert.equal(outcome.code, 23);
        else assert.equal(outcome.code, process.platform === 'win32' ? 1 : 137, 'child crash must be preserved as a failed parent outcome');
        assert.notEqual(mainPid, child.pid, 'compiled engine must execute in the supervised child');
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // Host-only fixture cleanup: Docker PID1 death is a separate physical
        // namespace gate, never inferred from Windows signal emulation.
        if (forced && mainPid && mainPid !== child.pid) try { process.kill(mainPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    for (const scenario of ['capture', 'receipt']) await t.test(`child independently refuses ${scenario} before main`, { timeout: 10000 }, async () => {
      const raw = await readFile(join(stage.directory, 'jrc-engine-build.json'));
      const child = fork(join(stage.directory, 'jrc-image/main-child.mjs'), [], { cwd: stage.directory, execArgv: ['--max-old-space-size=128'],
        env: { ...process.env, JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: scenario === 'capture' ? 'true' : 'false', DATABASE_PROVIDER: 'postgresql' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      child.send({ kind: 'JRC_ENGINE_VERIFIED_START_V1', sourceManifestSha256: JSON.parse(raw).sourceManifestSha256,
        receiptSha256: scenario === 'receipt' ? '0'.repeat(64) : createHash('sha256').update(raw).digest('hex') });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        assert.deepEqual(await exited, { code: 1, signal: null });
        assert.equal(stdout, ''); assert.match(stderr, scenario === 'capture' ? /ORIGIN_ENGINE_OWNERSHIP_UNPROVEN/u : /ORIGIN_ENGINE_MAIN_REFUSED/u);
      } finally { clearTimeout(timer); }
    });
  } finally { await removeOwnStage(stage.directory); }
});
