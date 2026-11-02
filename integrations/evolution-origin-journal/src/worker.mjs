/** Explicit laboratory bootstrap. Serial and finite; never installs itself on an engine. */
export function createOriginWorker({ dispatcher, binding, pollMs = 1000, maxIterations = 1000 }) {
  if (typeof dispatcher?.runOnce !== 'function' || !binding || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 30000
    || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 100000) throw new Error('ORIGIN_WORKER_CONFIGURATION_INVALID');
  const fixedBinding = Object.freeze({ ...binding });
  let running, stopping = false, wake;
  return Object.freeze({
    start() {
      if (running) return running;
      running = (async () => {
        for (let i = 0; i < maxIterations && !stopping; i++) {
          await dispatcher.runOnce(fixedBinding);
          if (!stopping && i + 1 < maxIterations) await new Promise(resolve => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => { clearTimeout(timer); resolve(); };
          });
        }
      })();
      return running;
    },
    async stop() { stopping = true; wake?.(); await running; },
  });
}
