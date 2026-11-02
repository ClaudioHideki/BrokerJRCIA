import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireLabOnly } from './cclx-receiver.mjs';

try {
  if (process.argv.length !== 3 || process.argv[2] !== '--lab-only') throw new Error('LAB_ONLY_REQUIRED');
  requireLabOnly({ labOnly: true });
  // Fixed test path; no caller-controlled command, URL, DB, provider or environment file.
  const child = spawn(process.execPath, ['--test', ...['cclx-receiver.test.mjs', 'extended.test.mjs', 'scenario.test.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)))], {
    stdio: 'inherit', env: { NODE_ENV: 'test', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  child.once('error', () => { console.error('LAB_TEST_PROCESS_ERROR'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
