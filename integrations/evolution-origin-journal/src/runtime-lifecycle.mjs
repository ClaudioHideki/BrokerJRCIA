// One registry even when tsup bundles this module and the image entrypoint
// imports its ESM copy. No runtime option can assert delivery ownership.
const key = Symbol.for('jrc.evolution.runtime-lifecycle.v1');
const state = () => globalThis[key] ??= { servers: new Set(), drains: new Set(), resources: new Map(), closing: false, installed: false, abort: new AbortController() };

export function registerRuntimeResource(resource, close) {
  const current = state();
  if (current.closing) throw Error('ORIGIN_ENGINE_RUNTIME_CLOSING');
  if (typeof close !== 'function') throw Error('ORIGIN_ENGINE_RESOURCE_INVALID');
  current.resources.set(resource, close);
}

export function registerRuntimeHttp(server) {
  const current = state();
  if (current.closing) throw Error('ORIGIN_ENGINE_RUNTIME_CLOSING');
  server.on('request', (_request, response) => response.once('finish', () => {
    if (current.closing) setImmediate(() => server.closeIdleConnections());
  }));
  current.servers.add(server);
}

export function registerRuntimeDrain(drain) {
  const current = state();
  if (current.closing) throw Error('ORIGIN_ENGINE_RUNTIME_CLOSING');
  current.drains.add(drain);
}

export function runtimeClosing() { return state().closing; }
export function runtimeShutdownSignal() { return state().abort.signal; }
export function recordRuntimeFailure(code = 1) {
  state().failureCode = Number.isSafeInteger(code) && code > 0 && code <= 255 ? code : 1;
}
export function markRuntimeReady() {
  if (!state().closing && typeof process.send === 'function' && process.connected) process.send({ kind: 'JRC_ENGINE_HTTP_READY_V1' });
}

export function installRuntimeLifecycle({ deadlineMs = 8000 } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 8000) throw Error('ORIGIN_ENGINE_SHUTDOWN_CONFIG_INVALID');
  const current = state();
  if (current.installed) return;
  current.installed = true;
  const shutdown = async () => {
    if (current.closing) return;
    current.closing = true;
    current.abort.abort();
    // Never turn an upstream failure into success. A deadline is a failed drain,
    // not an expanded Docker stop grace period or evidence of graceful shutdown.
    const priorFailure = process.exitCode || 0;
    process.exitCode = 1;
    const watchdog = setTimeout(() => {
      console.error('ORIGIN_ENGINE_SHUTDOWN_TIMEOUT');
      process.exit(1);
    }, deadlineMs);
    try {
      // close() stops admission immediately and waits for admitted responses.
      await Promise.all([...current.servers].map(server => new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      })));
      await Promise.all([...current.drains].map(drain => drain()));
      const outcomes = await Promise.allSettled([...current.resources.values()].map(close => close()));
      if (outcomes.some(result => result.status === 'rejected')) throw Error();
      // Exit naturally only after all handles settle; a leaked handle still
      // triggers the deadline. No process.exit(0) can conceal pending work.
      watchdog.unref();
      process.once('beforeExit', () => {
        clearTimeout(watchdog);
        process.exitCode = current.failureCode || priorFailure || 0;
        console.error(process.exitCode ? 'ORIGIN_ENGINE_SHUTDOWN_FAILED' : 'ORIGIN_ENGINE_SHUTDOWN_COMPLETE');
      });
    } catch {
      clearTimeout(watchdog);
      console.error('ORIGIN_ENGINE_SHUTDOWN_FAILED');
      process.exit(current.failureCode || 1);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
