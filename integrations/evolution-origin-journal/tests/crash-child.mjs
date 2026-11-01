// Test-only disposable process. Parent actually kills it; no simulated throw/restart.
import { Pool } from 'pg';
import { createOriginJournal } from '../src/journal.mjs';
import { createOriginCaptureHook } from '../src/hook.mjs';
import { createOriginDispatcher } from '../src/dispatcher.mjs';
import { createOriginHttpTransport } from '../src/http-transport.mjs';
import { createOriginWorker } from '../src/worker.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';
import { source } from './fixtures.mjs';

process.once('message', async config => {
  try {
    validateTestAdminUrl(config.connectionString);
    const pool = new Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000 });
    const journal = createOriginJournal({ pool, encryptionKey: Buffer.from(config.key, 'hex') });
    const env = { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' };
    if (config.mode === 'capture') {
      await createOriginCaptureHook({ env, journal, binding: config.binding }).capture(source());
      process.send({ phase: 'SOURCE_COMMITTED' });
    } else if (config.mode === 'claim') {
      const claim = await journal.claim(config.binding, { leaseMs: 1000 });
      process.send({ phase: 'LEASE_COMMITTED', id: claim.id });
    } else {
      const timeoutMs = config.timeoutMs ?? 1000;
      const deliver = createOriginHttpTransport({ endpoint: config.endpoint, binding: config.binding, bearerToken: config.bearerToken ?? 'synthetic-test-only', allowInsecureLoopbackForTests: true, timeoutMs });
      const dispatcher = createOriginDispatcher({ env, journal, resolveBinding: async () => config.binding, deliver, timeoutMs });
      await createOriginWorker({ dispatcher, binding: config.binding, maxIterations: 1 }).start();
      process.send({ phase: 'DISPATCH_SETTLED' });
    }
    // IPC channel intentionally remains open at the committed boundary until SIGKILL.
  } catch { process.send({ phase: 'CHILD_FAILED' }); process.exitCode = 1; process.disconnect(); }
});
