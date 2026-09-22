import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decryptBackup } from './backup.mjs';

const project = 'jrc-restore-drill';
const compose = resolve('infra/operations/restore-drill.compose.yaml');
const args = ['compose', '-p', project, '-f', compose];
const docker = (rest, options = {}) => execFileSync('docker', [...args, ...rest], {
  cwd: process.cwd(), encoding: options.binary ? undefined : 'utf8', stdio: options.inherit ? 'inherit' : 'pipe',
  input: options.input, timeout: options.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024,
});
const sql = (database, statement) => docker(['exec', '-T', 'postgres', 'psql', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', statement]);

const workspace = await mkdtemp(join(tmpdir(), 'jrc-restore-drill-'));
const backupDirectory = join(workspace, 'backup');
const runtimeEnvironment = join(workspace, 'runtime.env');
const key = Buffer.alloc(32, 7).toString('base64');
const startedAt = Date.now();
try {
  docker(['up', '--detach', '--wait'], { inherit: true, timeout: 180_000 });
  sql('postgres', 'CREATE DATABASE jrc_broker');
  sql('postgres', 'CREATE DATABASE jrc_evolution');
  sql('jrc_broker', "CREATE ROLE jrc_app LOGIN NOSUPERUSER NOBYPASSRLS; CREATE TABLE restore_drill_tenants(organization_id uuid PRIMARY KEY,name text NOT NULL); ALTER TABLE restore_drill_tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE restore_drill_tenants FORCE ROW LEVEL SECURITY; CREATE POLICY restore_drill_tenant ON restore_drill_tenants USING (organization_id=current_setting('app.current_organization_id',true)::uuid); INSERT INTO restore_drill_tenants VALUES ('11111111-1111-4111-8111-111111111111','Alpha'),('22222222-2222-4222-8222-222222222222','Beta');");
  sql('jrc_evolution', "CREATE TABLE restore_drill_sessions(id text PRIMARY KEY,state text NOT NULL); INSERT INTO restore_drill_sessions VALUES ('session-alpha','CONNECTED');");
  docker(['exec', '-T', 'evolution', 'sh', '-c', "mkdir -p /evolution/instances/alpha && printf 'synthetic-session' > /evolution/instances/alpha/state.txt"]);
  await writeFile(runtimeEnvironment, 'SYNTHETIC_RESTORE_DRILL=true\n', { mode: 0o600 });
  const backupStartedAt = Date.now();
  execFileSync(process.execPath, ['scripts/operations/backup.mjs', 'backup', compose, runtimeEnvironment, backupDirectory], {
    cwd: process.cwd(), env: { ...process.env, JRC_BACKUP_KEY: key, JRC_BACKUP_COMPOSE_PROJECT: project }, stdio: 'inherit', timeout: 180_000,
  });
  const backupMs = Date.now() - backupStartedAt;
  execFileSync(process.execPath, ['scripts/operations/backup.mjs', 'verify', backupDirectory], {
    cwd: process.cwd(), env: { ...process.env, JRC_BACKUP_KEY: key }, stdio: 'inherit', timeout: 120_000,
  });
  const brokerDump = join(workspace, 'broker.dump');
  const engineDump = join(workspace, 'engine.dump');
  const engineFiles = join(workspace, 'engine-files.tar.gz');
  await decryptBackup(join(backupDirectory, 'broker.dump.jrcbak'), brokerDump, key);
  await decryptBackup(join(backupDirectory, 'engine.dump.jrcbak'), engineDump, key);
  await decryptBackup(join(backupDirectory, 'engine-files.tar.gz.jrcbak'), engineFiles, key);
  const restoreStartedAt = Date.now();
  sql('postgres', 'CREATE DATABASE jrc_broker_restored');
  sql('postgres', 'CREATE DATABASE jrc_evolution_restored');
  docker(['exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', 'jrc_broker_restored'], { input: await readFile(brokerDump), binary: true });
  docker(['exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', 'jrc_evolution_restored'], { input: await readFile(engineDump), binary: true });
  const tenants = Number(sql('jrc_broker_restored', 'SELECT count(*) FROM restore_drill_tenants').trim());
  const sessions = Number(sql('jrc_evolution_restored', 'SELECT count(*) FROM restore_drill_sessions').trim());
  const role = sql('postgres', "SELECT rolbypassrls FROM pg_roles WHERE rolname='jrc_app'").trim() === 'f';
  const archive = execFileSync('tar', ['-tzf', engineFiles], { encoding: 'utf8' });
  const restoreMs = Date.now() - restoreStartedAt;
  if (tenants !== 2 || sessions !== 1 || !role || !archive.includes('alpha/state.txt')) throw new Error('RESTORE_DRILL_VALIDATION_FAILED');
  const evidence = { passed: true, backupMs, restoreMs, rpoSeconds: 0, tenants, sessions, runtimeBypassRls: false, engineSessionFile: true, totalMs: Date.now() - startedAt };
  await mkdir(resolve('.sessions'), { recursive: true });
  await writeFile(resolve('.sessions/restore-drill.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Restore drill PASS (backup ${backupMs} ms, restore ${restoreMs} ms)\n`);
} finally {
  try { docker(['down', '--volumes', '--remove-orphans'], { inherit: true }); } finally { await rm(workspace, { recursive: true, force: true }); }
}
