import { execFileSync } from 'node:child_process';

const project = 'jrc-phase1-entrypoint-test';
const composeArgs = ['compose', '-p', project, '-f', 'infra/app/compose.test.yaml'];
if (process.env.JRC_TEST_COMPOSE_OVERRIDE) composeArgs.push('-f', process.env.JRC_TEST_COMPOSE_OVERRIDE);

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 120_000,
  });
}

try {
  docker([...composeArgs, 'up', '--detach', '--wait'], { timeout: 180_000 });
  const mapping = docker([...composeArgs, 'port', 'api', '3000'], { capture: true }).trim();
  const port = mapping.slice(mapping.lastIndexOf(':') + 1);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok || (await response.json()).status !== 'ok') {
    throw new Error(`Container health endpoint returned HTTP ${response.status}`);
  }
  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  if (!ready.ok) throw new Error(`Container dependencies/schema are not ready: HTTP ${ready.status}`);

  const uid = docker([...composeArgs, 'exec', '-T', 'api', 'id', '-u'], { capture: true }).trim();
  if (uid === '0') throw new Error('API container must not run as root');
  process.stdout.write(`Container entrypoint healthy as uid ${uid}\n`);
} finally {
  docker([...composeArgs, 'down', '--volumes', '--remove-orphans'], { timeout: 120_000 });
}
