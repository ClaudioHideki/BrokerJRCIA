// Manual POSIX/PID1 gate. The immutable image is only the Node interpreter;
// a fully receipted synthetic main replaces the engine in an isolated stage.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stagePinnedEngine, removeOwnStage } from '../build/stage-engine.mjs';

const image = process.env.JRC_ENGINE_IMAGE_GATE_ID;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u);
const binary = process.env.JRC_ENGINE_DOCKER_EXECUTABLE || 'docker';
const allModes = ['busy', 'busy-int', 'ready', 'exit', 'crash', 'hung', 'parent-kill'];
const modes = process.argv.length > 2 ? process.argv.slice(2) : allModes;
assert.ok(modes.length <= allModes.length && new Set(modes).size === modes.length && modes.every(mode => allModes.includes(mode)));
const task = 'engine-supervisor-20261102', nonce = randomUUID().replaceAll('-', '').slice(0, 10);
const directory = fileURLToPath(new URL(`../build/supervisor-linux-${nonce}/`, import.meta.url));
const containers = [], results = [], cleanup = [];
const docker = (args, timeout = 20000) => spawnSync(binary, ['--context', 'desktop-linux', ...args], { encoding: 'utf8', timeout });
const must = args => { const result = docker(args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
const inspect = name => JSON.parse(must(['inspect', '--format', '{{json .}}', name]));
const logs = name => { const result = docker(['logs', name]); assert.equal(result.status, 0); return result.stdout + result.stderr; };
const owned = value => { assert.equal(value.Config.Labels['jrc.task'], task); assert.equal(value.Config.Labels['jrc.nonce'], nonce); };
const stage = await stagePinnedEngine({ imageContext: true });
await mkdir(directory);
try {
  const fixture = `const mode=process.env.SYNTHETIC_ENGINE_MODE;console.log('FIXTURE_PID '+process.pid);
if(mode.startsWith('busy')||mode==='parent-kill'){const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('FIXTURE_DESCENDANT '+child.pid);console.log('FIXTURE_BUSY');while(true){}}
if(mode==='exit')process.exit(23);if(mode==='crash')process.kill(process.pid,'SIGKILL');
if(mode==='hung'){process.on('SIGTERM',()=>{});process.send({kind:'JRC_ENGINE_HTTP_READY_V1'});console.log('FIXTURE_HUNG');while(true){}}
if(mode==='ready')(async()=>{const lifecycle=await import('../jrc-origin/runtime-lifecycle.mjs');lifecycle.installRuntimeLifecycle();
const server=require('node:http').createServer((_req,res)=>{console.log('FIXTURE_REQUEST');setTimeout(()=>res.end('drained'),500);});
lifecycle.registerRuntimeHttp(server);lifecycle.registerRuntimeResource({},async()=>console.log('FIXTURE_RESOURCE_CLOSED'));
server.listen(8080,'127.0.0.1',()=>{lifecycle.markRuntimeReady();console.log('FIXTURE_READY');});})();`;
  for (const [path, content] of Object.entries({ 'dist/main.js': fixture, 'dist/translations/en.json': '{}',
    'node_modules/.prisma/client/index.js': '// fixture', 'node_modules/.prisma/client/schema.prisma': '// fixture',
    'node_modules/.prisma/client/libquery_engine-test.so.node': 'NOT_EXECUTABLE', 'node_modules/@prisma/client/package.json': '{}',
  })) { await mkdir(dirname(join(stage.directory, path)), { recursive: true }); await writeFile(join(stage.directory, path), content); }
  const recorded = spawnSync(process.execPath, ['jrc-image/record-build.mjs'], { cwd: stage.directory, encoding: 'utf8', timeout: 30000 });
  assert.equal(recorded.status, 0, recorded.stderr);
  async function observe(name, pattern, count = 1) {
    const started = performance.now();
    while ([...logs(name).matchAll(new RegExp(pattern.source, 'gu'))].length < count) {
      assert.ok(inspect(name).State.Running, 'fixture exited before observation');
      assert.ok(performance.now() - started < 20000, 'fixture observation deadline'); await delay(50);
    }
  }
  function assertStopped(name, code) {
    const state = inspect(name); owned(state);
    assert.equal(state.State.Running, false); assert.equal(state.State.OOMKilled, false);
    assert.equal(state.State.ExitCode, code); assert.equal(state.State.Pid, 0);
    assert.notEqual(docker(['top', name, '-eo', 'pid,ppid,comm']).status, 0, 'stopped namespace cannot retain inspectable processes');
  }
  for (const mode of modes) {
    const name = `jrc-supervisor-${nonce}-${mode}`; containers.push(name);
    must(['run', '--detach', '--name', name, '--label', `jrc.task=${task}`, '--label', `jrc.nonce=${nonce}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--cpus', '1',
      '--mount', `type=bind,src=${stage.directory},dst=/evolution,readonly`, '--workdir', '/evolution', '--entrypoint', 'node',
      '--env', 'NODE_OPTIONS=--max-old-space-size=96', '--env', 'JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false',
      '--env', `SYNTHETIC_ENGINE_MODE=${mode}`, image, 'jrc-image/entrypoint.mjs']);
    const metadata = inspect(name); owned(metadata);
    assert.deepEqual(metadata.HostConfig.PortBindings, {}); assert.equal(metadata.HostConfig.NetworkMode, 'none');
    let request, signalDurationMs, signalTimestamp;
    if (['busy', 'busy-int', 'ready', 'hung', 'parent-kill'].includes(mode)) {
      await observe(name, mode === 'ready' ? /FIXTURE_READY/u : mode === 'hung' ? /FIXTURE_HUNG/u : /FIXTURE_BUSY/u);
      if (mode === 'ready') {
        const command = spawn(binary, ['--context', 'desktop-linux', 'exec', name, 'node', '--eval',
          'fetch("http://127.0.0.1:8080/").then(async r=>console.log(await r.text()))'], { stdio: ['ignore', 'pipe', 'pipe'] });
        request = new Promise(resolve => { let stdout = ''; command.stdout.on('data', part => { stdout += part; }); command.on('close', code => resolve({ code, stdout })); });
        await observe(name, /FIXTURE_REQUEST/u);
      }
      if (mode === 'parent-kill') {
        const processes = must(['top', name, '-eo', 'pid,ppid,comm']).trim().split('\n');
        assert.ok(processes.length >= 4, 'PID1, blocked main and descendant must exist before namespace kill');
      }
      const signalAt = performance.now();
      signalTimestamp = Date.now();
      must(mode === 'parent-kill' ? ['kill', '--signal', 'SIGKILL', name] : mode === 'busy-int' ? ['kill', '--signal', 'SIGINT', name] : ['stop', '--time', '10', name]);
      if (mode === 'busy-int') must(['wait', name]);
      signalDurationMs = Math.round(performance.now() - signalAt);
    } else assert.equal(Number(must(['wait', name]).trim()), mode === 'exit' ? 23 : 137);
    const expected = mode === 'ready' ? 0 : mode === 'exit' ? 23 : mode === 'busy-int' ? 130 : mode === 'busy' ? 143 : 137;
    const finalState = inspect(name).State;
    const result = { mode, exitCode: finalState.ExitCode, signalDurationMs,
      daemonExitAfterSignalMs: signalTimestamp ? Date.parse(finalState.FinishedAt) - signalTimestamp : undefined,
      oomKilled: finalState.OOMKilled, stoppedNamespacePid: finalState.Pid };
    results.push(result);
    assertStopped(name, expected);
    const output = logs(name);
    await writeFile(join(directory, `${mode}.log`), output);
    if (mode.startsWith('busy')) {
      assert.ok(result.daemonExitAfterSignalMs < 10000);
      assert.match(output, /ready=false forced=false/u); assert.doesNotMatch(output, /SHUTDOWN_COMPLETE/u);
    }
    if (mode === 'ready') { assert.deepEqual(await request, { code: 0, stdout: 'drained\n' }); assert.match(output, /FIXTURE_RESOURCE_CLOSED/u); }
    // Docker Desktop's CLI may return seconds after the process has exited.
    // Enforce the unchanged stop10 budget on daemon FinishedAt; retain both
    // measurements so client delay cannot be presented as process drain time.
    if (mode === 'hung') {
      assert.ok(result.daemonExitAfterSignalMs >= 7000 && result.daemonExitAfterSignalMs < 10000);
      assert.match(output, /ready=true forced=true/u);
    }
    if (mode !== 'ready') assert.doesNotMatch(output, /SHUTDOWN_COMPLETE/u);
    if (mode === 'parent-kill') {
      must(['start', name]); await observe(name, /FIXTURE_BUSY/u, 2);
      // Require a fresh marker because Docker logs persist over restart.
      assert.equal(inspect(name).State.Running, true);
      must(['stop', '--time', '10', name]); assertStopped(name, 143);
      result.restartStoppedCode = 143;
    }
  }
} catch (error) { process.exitCode = 1; results.push({ failure: error.message }); }
finally {
  for (const name of containers.reverse()) {
    try {
      owned(inspect(name)); await writeFile(join(directory, `${name}-final.log`), logs(name));
      must(['rm', '--force', name]); assert.notEqual(docker(['inspect', name]).status, 0); cleanup.push({ name, removed: true });
    }
    catch { process.exitCode = 1; cleanup.push({ name, removed: false }); }
  }
  await removeOwnStage(stage.directory);
  const report = { image, requestedCases: modes, scope: 'SYNTHETIC_RECEIPTED_MAIN_IN_DOCKER_PID1', actualEngineImported: false,
    standaloneParentKillProven: false, results, cleanup, evidenceDirectory: directory };
  await writeFile(join(directory, 'report.log'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
