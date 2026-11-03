import { fork } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { registerRuntimeResource, recordRuntimeFailure } from './runtime-lifecycle.mjs';

export async function superviseEngineMain(root, env, admission) {
  const child = fork(join(root, 'jrc-image/main-child.mjs'), [], { cwd: root, env,
    execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: process.platform !== 'win32', windowsHide: true });
  let ready = false, stopping = false, forced = false, outcome, timer, stopSignal = 'SIGTERM';
  // Capture the originating signal before the shared lifecycle closes resources.
  const interrupt = () => { if (!stopping) stopSignal = 'SIGINT'; };
  process.prependListener('SIGINT', interrupt);
  const exited = new Promise(resolve => {
    child.once('error', () => { outcome = { code: 1, signal: null }; });
    child.once('exit', (code, signal) => { outcome = { code, signal }; });
    child.once('close', () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      const code = outcome?.code ?? 128 + (constants.signals[outcome?.signal] ?? 0);
      const exitCode = forced ? 137 : stopping && !ready && code === 0 ? 128 + constants.signals[stopSignal] : code || (outcome ? 0 : 1);
      if (exitCode) recordRuntimeFailure(exitCode);
      const safeSignal = /^[A-Z0-9]+$/u.test(outcome?.signal ?? '') ? outcome.signal : 'none';
      console.error(`ORIGIN_ENGINE_MAIN_EXIT code=${outcome?.code ?? 'null'} signal=${safeSignal} ready=${ready} forced=${forced}`);
      resolve({ exitCode, code: outcome?.code, signal: outcome?.signal, ready, forced });
    });
  });
  const signal = value => {
    if (outcome || !Number.isSafeInteger(child.pid)) return;
    try {
      if (process.platform === 'win32' && ready && value !== 'SIGKILL' && child.connected) {
        child.send({ kind: 'JRC_ENGINE_STOP_V1', signal: value }, error => { if (error && !outcome) child.kill('SIGKILL'); });
      } else if (process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) { if (error.code !== 'ESRCH') throw Error('ORIGIN_ENGINE_CHILD_SIGNAL_FAILED'); }
  };
  child.on('message', message => { if (message?.kind === 'JRC_ENGINE_HTTP_READY_V1') ready = true; });
  registerRuntimeResource(child, async () => {
    stopping = true;
    signal(stopSignal);
    timer = setTimeout(() => { forced = true; signal('SIGKILL'); }, 7000);
    const result = await exited;
    clearTimeout(timer);
    if (result.exitCode !== 0) throw Error('ORIGIN_ENGINE_CHILD_SHUTDOWN_FAILED');
  });
  child.send({ kind: 'JRC_ENGINE_VERIFIED_START_V1', ...admission }, error => {
    if (error && !outcome) { recordRuntimeFailure(1); signal('SIGKILL'); }
  });
  return exited;
}
