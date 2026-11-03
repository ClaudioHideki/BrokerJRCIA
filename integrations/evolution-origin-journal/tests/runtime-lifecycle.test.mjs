import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Breaks caught: default termination interrupts an admitted HTTP response;
// asynchronous cleanup errors/hangs must never be reported as graceful exit0.
for (const mode of ['normal', 'failed', 'hung']) {
  test(`runtime shutdown ${mode} drains or fails explicitly`, { timeout: 5000 }, async () => {
    const child = fork(fileURLToPath(new URL('./runtime-lifecycle-child.mjs', import.meta.url)), [mode], {
      execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '', stderr = '', response = false, signalled = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 2500);
    child.on('message', message => {
      if (message.state === 'request_admitted' && !signalled) {
        signalled = true;
        if (process.platform === 'win32') child.send('signal');
        else child.kill('SIGTERM');
      }
      if (message.state === 'response') { response = true; child.send('disconnect'); }
    });
    try {
      const result = await new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
      assert.equal(response, true, 'an admitted HTTP response must finish before resource closure');
      assert.equal(result.signal, null, 'shutdown must not require SIGKILL');
      assert.equal(result.code, mode === 'normal' ? 0 : 1);
      if (mode === 'normal') {
        assert.deepEqual(JSON.parse(stdout).marks, ['RESPONSE_FINISHED', 'RESOURCE_CLOSED']);
        assert.match(stderr, /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u);
      } else assert.match(stderr, /ORIGIN_ENGINE_SHUTDOWN_(?:FAILED|TIMEOUT)/u);
      assert.doesNotMatch(stderr, /SYNTHETIC_SECRET_MUST_NOT_LEAK/u);
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
}
