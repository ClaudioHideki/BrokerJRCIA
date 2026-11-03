// Explicit manual laboratory gate. Provisions a NEW disposable schema with the
// candidate's own Prisma CLI, then boots/stops the real default-false entrypoint.
// No backup, restore, existing data, WhatsApp session, public port or production.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.JRC_ENGINE_IMAGE_GATE_ID;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u, 'explicit immutable local image required');
const binary = process.env.JRC_ENGINE_DOCKER_EXECUTABLE || 'docker';
const task = 'engine-provisioned-20261102', nonce = randomUUID().replaceAll('-', '').slice(0, 10);
const network = `jrc-engine-provisioned-${nonce}`, pg = `${network}-pg`, redis = `${network}-redis`, engine = `${network}-engine`;
const provisioner = `${network}-schema`, custody = `${network}-custody`;
const realHook = `${network}-real-hook`;
const verifying = `${network}-verifying`, starting = `${network}-starting`;
const directory = fileURLToPath(new URL(`../build/provisioned-gate-${nonce}/`, import.meta.url));
const pgSecret = `JRC_SYNTHETIC_PG_${nonce}`, apiSecret = `JRC_SYNTHETIC_API_${nonce}`;
const databaseUri = `postgresql://jrc_lab:${pgSecret}@${pg}:5432/jrc_engine_lab?schema=public`;
const redisUri = `redis://${redis}:6379/0`;
const secrets = [databaseUri, redisUri, pgSecret, apiSecret];
const containers = new Set(), report = { image, task, nonce, ownership: 'UNPROVEN', capture: false,
  productionApproved: false, operationallyReady: false, realEngineBootAttempted: false,
  postgresInitiallyPristine: true, explicitSchemaProvisioning: true, automaticStartupMigration: false,
  publishedPorts: false, externalNetwork: false };
let networkCreated = false;
const sanitize = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED_SYNTHETIC]'), String(value));
const docker = (args, timeout = 20000) => spawnSync(binary, ['--context', 'desktop-linux', ...args], {
  encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
});
const must = args => {
  const result = docker(args);
  assert.ok(!result.error && result.status === 0, `local Docker ${args[0]} failed: ${sanitize(result.stderr ?? '')}`);
  return result.stdout;
};
const logs = (name, since) => {
  const result = docker(['logs', ...(since ? ['--since', since] : []), name]);
  assert.ok(!result.error && result.status === 0, 'task container log read failed');
  return (result.stdout ?? '') + (result.stderr ?? '');
};
const absent = result => !result.error && result.status !== 0 &&
  /No such (?:container|object|network):|Error response from daemon: network [^\r\n]+ not found/iu.test(result.stderr ?? '');
const inspectContainer = name => JSON.parse(must(['container', 'inspect', '--format', '{{json .}}', name]));
const owned = metadata => {
  assert.equal(metadata.Config.Labels['jrc.task'], task);
  assert.equal(metadata.Config.Labels['jrc.nonce'], nonce);
};
async function evidence(name, contents) { await writeFile(join(directory, name), sanitize(contents)); }
function allowedLogLines(text) {
  return text.split('\n').filter(line => line.length < 1200 &&
    /^(?:\{"artifactRuntime":|\{"sourceMainImported":|\[Evolution API\]|\d{4}-\d{2}-\d{2}|\d+:[A-Z]|PrismaClient\w*Error|TypeError:|Error:|Node\.js|ORIGIN_ENGINE_|\s+(?:at\b|code:|meta:|modelName:|table:|clientVersion:))|P2021|does not exist/iu.test(line)).join('\n') + '\n';
}
function start(name, args, imageId, command = [], allowedReadOnlyMount) {
  containers.add(name);
  must(['run', '--detach', '--name', name, '--label', `jrc.task=${task}`, '--label', `jrc.nonce=${nonce}`,
    '--network', network, '--security-opt', 'no-new-privileges', ...args, imageId, ...command]);
  const metadata = inspectContainer(name);
  owned(metadata);
  assert.deepEqual(metadata.HostConfig.PortBindings, {});
  assert.equal(metadata.HostConfig.NetworkMode, network);
  assert.ok(metadata.Mounts.every(mount => mount.Type === 'tmpfs' ||
    (allowedReadOnlyMount && mount.Type === 'bind' && mount.Destination === allowedReadOnlyMount && mount.RW === false)),
  'only task tmpfs and the exact readonly gate script are allowed');
}
async function waitStopped(name, deadlineMs) {
  const started = performance.now();
  for (;;) {
    const metadata = inspectContainer(name); owned(metadata);
    if (!metadata.State.Running) {
      assert.equal(metadata.State.OOMKilled, false);
      assert.equal(metadata.State.ExitCode, 0, 'task subprocess failed');
      return Math.round(performance.now() - started);
    }
    assert.ok(performance.now() - started < deadlineMs, 'task subprocess deadline');
    await delay(1000);
  }
}
const catalogSql = `BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
 'schemas',(SELECT COALESCE(json_agg(row_to_json(s) ORDER BY s.name),'[]'::json) FROM
   (SELECT nspname AS name,nspowner AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema') s),
 'relations',(SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.schema,r.name),'[]'::json) FROM
   (SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relpersistence,c.relowner,c.relacl::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') r),
 'columns',(SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.schema,a.relation,a.attnum),'[]'::json) FROM
   (SELECT n.nspname AS schema,c.relname AS relation,a.attname,a.attnum,a.atttypid,a.attnotnull,a.attidentity,a.attgenerated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') a),
 'constraints',(SELECT COALESCE(json_agg(row_to_json(c) ORDER BY c.schema,c.name),'[]'::json) FROM
   (SELECT n.nspname AS schema,c.conname AS name,c.contype,c.conrelid,c.confrelid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') c),
 'functions',(SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.schema,p.name,p.oid),'[]'::json) FROM
   (SELECT n.nspname AS schema,p.proname AS name,p.oid,p.proargtypes::text,p.prorettype FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') p),
 'types',(SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.schema,t.name),'[]'::json) FROM
   (SELECT n.nspname AS schema,t.typname AS name,t.typtype,t.typelem,t.typbasetype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') t),
 'triggers',(SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.schema,t.name),'[]'::json) FROM
   (SELECT n.nspname AS schema,t.tgname AS name,t.tgrelid,t.tgfoid,t.tgtype,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') t),
 'extensions',(SELECT COALESCE(json_agg(row_to_json(e) ORDER BY e.extname),'[]'::json) FROM (SELECT extname,extversion,extnamespace FROM pg_extension) e)
); COMMIT;`;
function catalog() {
  const text = must(['exec', pg, 'psql', '-X', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
    '--username', 'jrc_lab', '--dbname', 'jrc_engine_lab', '--command', catalogSql]).trim();
  const value = JSON.parse(text);
  return { text, value, sha256: createHash('sha256').update(text).digest('hex') };
}

await mkdir(directory);
try {
  const configured = JSON.parse(must(['image', 'inspect', '--format', '{{json .}}', image]));
  assert.equal(configured.Id, image);
  assert.equal(configured.Config.User, 'node');
  assert.deepEqual(configured.Config.Entrypoint, ['node', 'jrc-image/entrypoint.mjs']);
  assert.equal(configured.Config.Labels['com.jrc.delivery-ownership'], 'UNPROVEN');
  assert.ok(configured.Config.Env.includes('JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED=false'));
  const pgImage = must(['image', 'inspect', '--format', '{{.Id}}', 'postgres:16-alpine']).trim();
  const redisImage = must(['image', 'inspect', '--format', '{{.Id}}', 'redis:7.4.0-alpine']).trim();
  assert.match(pgImage, /^sha256:[a-f0-9]{64}$/u); assert.match(redisImage, /^sha256:[a-f0-9]{64}$/u);
  report.postgresImage = pgImage; report.redisImage = redisImage;
  must(['network', 'create', '--internal', '--label', `jrc.task=${task}`, '--label', `jrc.nonce=${nonce}`, network]);
  networkCreated = true;
  const networkMetadata = JSON.parse(must(['network', 'inspect', '--format', '{{json .}}', network]));
  assert.equal(networkMetadata.Internal, true);
  assert.equal(networkMetadata.Labels['jrc.nonce'], nonce);
  start(pg, ['--memory', '192m', '--cpus', '0.5', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_USER=jrc_lab', '--env', 'POSTGRES_DB=jrc_engine_lab', '--env', `POSTGRES_PASSWORD=${pgSecret}`],
  pgImage, ['postgres', '-c', 'shared_buffers=16MB', '-c', 'max_connections=12', '-c', 'log_statement=ddl']);
  start(redis, ['--memory', '64m', '--cpus', '0.25', '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/data:rw,noexec,nosuid,size=8m',
    '--user', 'redis'], redisImage, ['redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '16mb']);
  for (let attempt = 0; ; attempt++) {
    const ready = docker(['exec', pg, 'pg_isready', '--username', 'jrc_lab', '--dbname', 'jrc_engine_lab']);
    const mainProcess = docker(['exec', pg, 'cat', '/proc/1/comm']);
    if (ready.status === 0 && mainProcess.status === 0 && mainProcess.stdout.trim() === 'postgres') break;
    assert.ok(attempt < 30, 'isolated PostgreSQL readiness deadline');
    await delay(1000);
  }
  assert.equal(must(['exec', redis, 'redis-cli', 'PING']).trim(), 'PONG');
  assert.equal(must(['exec', redis, 'redis-cli', 'DBSIZE']).trim(), '0');
  const pristine = catalog();
  assert.equal(pristine.value.relations.length, 0, 'database must have no user relations before explicit provisioning');
  report.pristineCatalogSha256 = pristine.sha256;
  start(provisioner, ['--memory', '384m', '--cpus', '1', '--read-only', '--cap-drop', 'ALL', '--user', 'node',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,uid=1000,gid=1000', '--env', 'NODE_OPTIONS=--max-old-space-size=192',
    '--env', 'CHECKPOINT_DISABLE=1', '--env', `DATABASE_CONNECTION_URI=${databaseUri}`, '--entrypoint', 'node'], image,
  ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', 'prisma/postgresql-schema.prisma', '--skip-generate']);
  report.schemaProvisioningMs = await waitStopped(provisioner, 120000);
  const provisionLog = logs(provisioner);
  assert.equal(secrets.some(secret => provisionLog.includes(secret)), false, 'provisioner disclosed a synthetic secret');
  report.explicitSchemaProvisioned = /in sync with your Prisma schema/u.test(provisionLog);
  assert.equal(report.explicitSchemaProvisioned, true);
  const before = catalog();
  assert.ok(before.value.relations.some(relation => relation.name === 'Instance'));
  assert.equal(must(['exec', pg, 'psql', '-X', '--tuples-only', '--no-align', '--username', 'jrc_lab', '--dbname', 'jrc_engine_lab',
    '--command', 'SELECT count(*) FROM public."Instance"']).trim(), '0');
  report.provisionedRelations = before.value.relations.length;
  await evidence('catalog-before.log', before.text + '\n');
  report.catalogBeforeSha256 = before.sha256;
  const engineObservationSince = new Date().toISOString();
  report.engineObservationSince = engineObservationSince;
  const engineArgs = ['--memory', '512m', '--cpus', '1', '--cap-drop', 'ALL', '--read-only', '--user', 'node',
    '--tmpfs', '/evolution/store:rw,noexec,nosuid,size=8m,uid=1000,gid=1000',
    '--tmpfs', '/evolution/instances:rw,noexec,nosuid,size=8m,uid=1000,gid=1000',
    '--tmpfs', '/evolution/temp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000',
    '--env', 'NODE_OPTIONS=--max-old-space-size=256', '--env', `DATABASE_CONNECTION_URI=${databaseUri}`,
    '--env', 'SERVER_TYPE=http', '--env', 'SERVER_PORT=8080', '--env', `SERVER_URL=http://${engine}:8080`,
    '--env', `AUTHENTICATION_API_KEY=${apiSecret}`, '--env', 'DATABASE_SAVE_DATA_INSTANCE=true',
    '--env', 'CACHE_REDIS_ENABLED=true', '--env', `CACHE_REDIS_URI=${redisUri}`,
    '--env', 'CACHE_REDIS_SAVE_INSTANCES=false', '--env', 'TELEMETRY_ENABLED=false', '--env', 'SENTRY_DSN=',
    '--env', 'WEBHOOK_GLOBAL_ENABLED=false', '--env', 'WEBSOCKET_ENABLED=false', '--env', 'RABBITMQ_ENABLED=false',
    '--env', 'NATS_ENABLED=false', '--env', 'SQS_ENABLED=false', '--env', 'KAFKA_ENABLED=false',
    '--env', 'PUSHER_ENABLED=false', '--env', 'TYPEBOT_ENABLED=false', '--env', 'CHATWOOT_ENABLED=false',
    '--env', 'PROVIDER_ENABLED=false', '--env', 'S3_ENABLED=false', '--env', 'PROMETHEUS_METRICS=false',
    '--env', 'LOG_LEVEL=ERROR,WARN,INFO,LOG'];
  report.startupSignalCases = [];
  for (const [name, phase] of [[verifying, 'integrity-scan'], [starting, 'main-import']]) {
    start(name, engineArgs, image);
    const began = performance.now();
    if (phase === 'main-import') {
      while (!/ORIGIN_ENGINE_INTEGRITY_VERIFIED/u.test(logs(name))) {
        assert.equal(inspectContainer(name).State.Running, true);
        assert.ok(performance.now() - began < 240000, 'startup signal observation deadline');
        await delay(100);
      }
    }
    const beforeSignal = logs(name);
    assert.doesNotMatch(beforeSignal, /HTTP - ON: 8080/u, 'signal gate missed its pre-listen observation window');
    if (phase === 'integrity-scan') assert.doesNotMatch(beforeSignal, /ORIGIN_ENGINE_INTEGRITY_VERIFIED/u);
    const signalAt = performance.now();
    must(['stop', '--time', '10', name]);
    const stopped = inspectContainer(name); owned(stopped);
    const stoppedLogs = logs(name);
    const result = { phase, stopDurationMs: Math.round(performance.now() - signalAt), exitCode: stopped.State.ExitCode,
      oomKilled: stopped.State.OOMKilled, graceful: /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u.test(stoppedLogs) };
    report.startupSignalCases.push(result);
    await evidence(`${phase}-signal.log`, allowedLogLines(stoppedLogs));
    assert.equal(secrets.some(secret => stoppedLogs.includes(secret)), false);
    assert.equal(stopped.State.Running, false); assert.equal(stopped.State.OOMKilled, false);
    assert.notEqual(stopped.State.ExitCode, 137, 'startup stop must not need Docker SIGKILL');
    if (phase === 'integrity-scan') {
      assert.equal(stopped.State.ExitCode, 0); assert.equal(result.graceful, true);
      assert.doesNotMatch(stoppedLogs, /ORIGIN_ENGINE_INTEGRITY_VERIFIED|HTTP - ON: 8080/u);
    } else {
      assert.equal(stopped.State.ExitCode, 143, 'cancelled main startup must preserve SIGTERM as failure');
      assert.equal(result.graceful, false, 'cancelled startup cannot claim graceful readiness');
      assert.match(stoppedLogs, /ORIGIN_ENGINE_MAIN_EXIT .*ready=false forced=false/u);
    }
  }
  const started = performance.now();
  start(engine, engineArgs, image);
  report.realEngineBootAttempted = true;
  let output = '', state, reachedHttp = false;
  for (;;) {
    output = logs(engine);
    state = inspectContainer(engine); owned(state);
    reachedHttp = /HTTP - ON: 8080/u.test(output);
    if (reachedHttp || !state.State.Running || performance.now() - started > 240000) break;
    await delay(2000);
  }
  report.observationMs = Math.round(performance.now() - started);
  report.engineHeapMiB = 256; report.engineContainerLimitMiB = 512;
  report.engineRunningAtObservation = state.State.Running; report.engineExitCodeAtObservation = state.State.ExitCode;
  report.engineOOMKilled = state.State.OOMKilled; report.httpListenerObserved = reachedHttp;
  const scan = /ORIGIN_ENGINE_INTEGRITY_VERIFIED artifacts=(\d+) durationMs=(\d+)/u.exec(output);
  assert.ok(scan, 'entrypoint must report its own complete inventory measurement');
  report.inventoryArtifactCount = Number(scan[1]); report.inventoryScanMs = Number(scan[2]);
  assert.equal(reachedHttp, true, 'real engine HTTP listener not reached');
  const response = JSON.parse(must(['exec', engine, 'node', '--input-type=module', '--eval',
    'const response=await fetch("http://127.0.0.1:8080/instance/fetchInstances",{headers:{apikey:process.env.AUTHENTICATION_API_KEY}});const body=await response.json();console.log(JSON.stringify({status:response.status,array:Array.isArray(body),count:Array.isArray(body)?body.length:null}));']));
  assert.deepEqual(response, { status: 200, array: true, count: 0 });
  report.authenticatedEmptyInstanceRead = response;
  await evidence('resource-sample.log', must(['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}', engine, pg, redis]));
  // End the observed application lifetime before the after-catalog snapshot.
  // No engine remains able to mutate the catalog between snapshot and cleanup.
  const stopStarted = performance.now();
  must(['stop', '--time', '10', engine]);
  report.stopDurationMs = Math.round(performance.now() - stopStarted);
  const stoppedEngine = inspectContainer(engine); owned(stoppedEngine);
  assert.equal(stoppedEngine.State.Running, false);
  report.engineStoppedBeforeAfterSnapshot = true;
  report.engineFinalExitCode = stoppedEngine.State.ExitCode;
  assert.equal(report.engineFinalExitCode, 0, 'real candidate must exit gracefully without Docker SIGKILL');
  report.engineOOMKilled ||= stoppedEngine.State.OOMKilled;
  const allLogs = { engine: logs(engine), postgres: logs(pg), redis: logs(redis), postgres_observation: logs(pg, engineObservationSince) };
  assert.match(allLogs.engine, /ORIGIN_ENGINE_SHUTDOWN_COMPLETE/u);
  assert.doesNotMatch(allLogs.engine, /P2021|ORIGIN_ENGINE_SHUTDOWN_(?:FAILED|TIMEOUT)/u);
  report.syntheticSecretDisclosed = Object.values(allLogs).some(log => secrets.some(secret => log.includes(secret)));
  report.ddlStatementLogCount = (allLogs.postgres_observation.match(/\b(?:statement|execute [^:]+):\s*(?:CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE|SECURITY LABEL)\b/giu) ?? []).length;
  for (const [name, content] of Object.entries(allLogs)) await evidence(`${name}-sanitized.log`, allowedLogLines(content));
  const after = catalog();
  await evidence('catalog-after.log', after.text + '\n');
  report.catalogAfterSha256 = after.sha256; report.catalogUnchanged = before.text === after.text;
  report.userRelationsAfter = after.value.relations.length;
  report.redisKeysAfter = Number(must(['exec', redis, 'redis-cli', 'DBSIZE']).trim());
  assert.equal(report.syntheticSecretDisclosed, false, 'synthetic credential/URI leaked in logs');
  assert.equal(report.engineOOMKilled, false);
  assert.equal(report.catalogUnchanged, true, 'engine altered explicitly provisioned database catalog');
  assert.equal(report.userRelationsAfter, before.value.relations.length);
  assert.equal(report.ddlStatementLogCount, 0, 'DDL statement observed during engine lifetime');
  report.emptyEngineBootAndShutdownVerified = true;
  const custodyScript = fileURLToPath(new URL('./engine-artifact-custody.mjs', import.meta.url));
  start(custody, ['--memory', '384m', '--cpus', '1', '--read-only', '--cap-drop', 'ALL', '--user', 'node',
    '--env', 'NODE_ENV=test', '--env', `DATABASE_CONNECTION_URI=${databaseUri}`, '--entrypoint', 'node',
    '--mount', `type=bind,src=${custodyScript},dst=/gate/engine-artifact-custody.mjs,readonly`], image,
  ['--max-old-space-size=128', '/gate/engine-artifact-custody.mjs'], '/gate/engine-artifact-custody.mjs');
  report.artifactCustodyMs = await waitStopped(custody, 60000);
  const custodyLog = logs(custody);
  assert.equal(secrets.some(secret => custodyLog.includes(secret)), false);
  report.artifactCustody = JSON.parse(custodyLog.trim());
  assert.equal(report.artifactCustody.gate, 'ARTIFACT_MODULES_CUSTODY_CRASH_VERIFIED');
  assert.equal(report.artifactCustody.cases.length, 2);
  await evidence('artifact-custody.log', JSON.stringify(report.artifactCustody, null, 2) + '\n');
  report.gate = 'PROVISIONED_EMPTY_ENGINE_SHUTDOWN_AND_ARTIFACT_CUSTODY_VERIFIED';
  if (process.env.JRC_ENGINE_REAL_HOOK_GATE === 'true') {
    const hookScript = fileURLToPath(new URL('./engine-real-hook-gate.mjs', import.meta.url));
    start(realHook, [...engineArgs, '--memory', '640m', '--env', 'NODE_ENV=test', '--entrypoint', 'node',
      '--mount', `type=bind,src=${hookScript},dst=/gate/engine-real-hook-gate.mjs,readonly`], image,
    ['--max-old-space-size=128', '/gate/engine-real-hook-gate.mjs'], '/gate/engine-real-hook-gate.mjs');
    report.realHookMs = await waitStopped(realHook, 240000);
    const hookLog = logs(realHook);
    assert.equal(secrets.some(secret => hookLog.includes(secret)), false);
    report.realHook = JSON.parse(hookLog.trim());
    assert.equal(report.realHook.gate, 'REAL_ENGINE_HOOK_AND_SOURCE_CRASH_VERIFIED');
    await evidence('real-hook.log', JSON.stringify(report.realHook, null, 2) + '\n');
    report.gate = 'PROVISIONED_ENGINE_AND_REAL_HOOK_SOURCE_CRASH_VERIFIED';
  }
} catch (error) {
  report.gate = 'FAILED_OR_INCONCLUSIVE'; report.failure = sanitize(error.message);
  for (const container of containers) {
    try { await evidence(`${container}-failure-sanitized.log`, allowedLogLines(logs(container))); } catch { /* report retains original failure */ }
  }
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const container of [...containers].reverse()) {
    const result = docker(['container', 'inspect', '--format', '{{json .}}', container]);
    if (absent(result)) { cleanup.push({ container, status: 'confirmed_absent' }); continue; }
    if (result.error || result.status !== 0) { cleanup.push({ container, status: 'cleanup_unproven' }); continue; }
    try {
      owned(JSON.parse(result.stdout));
      docker(['stop', '--time', '3', container]);
      const stopped = inspectContainer(container); owned(stopped);
      assert.equal(stopped.State.Running, false);
      must(['container', 'rm', container]);
      cleanup.push({ container, status: absent(docker(['container', 'inspect', container])) ? 'confirmed_removed' : 'cleanup_unproven' });
    } catch (error) { cleanup.push({ container, status: 'cleanup_unproven', reason: sanitize(error.message) }); }
  }
  if (networkCreated) {
    try {
      const metadata = JSON.parse(must(['network', 'inspect', '--format', '{{json .}}', network]));
      assert.equal(metadata.Labels['jrc.task'], task); assert.equal(metadata.Labels['jrc.nonce'], nonce);
      assert.equal(Object.keys(metadata.Containers).length, 0);
      must(['network', 'rm', network]);
      cleanup.push({ network, status: absent(docker(['network', 'inspect', network])) ? 'confirmed_removed' : 'cleanup_unproven' });
    } catch (error) { cleanup.push({ network, status: 'cleanup_unproven', reason: sanitize(error.message) }); }
  }
  report.cleanupConfirmed = cleanup.every(item => item.status !== 'cleanup_unproven');
  if (!report.cleanupConfirmed) process.exitCode = 1;
  await evidence('cleanup.log', JSON.stringify(cleanup, null, 2) + '\n');
  await evidence('report.log', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidenceDirectory: directory }));
}
