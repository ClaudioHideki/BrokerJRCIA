import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { runMigrations } from '../../../apps/api/dist/db/migrate.js';
import { withOrganizationTransaction } from '../../../apps/api/dist/db/tenant-transaction.js';
import { createQrMessagingService, ensureQrChannel } from '../../../apps/api/dist/modules/messaging/qr-service.js';
import { registerIntegrationRoutes } from '../../../apps/api/dist/http/routes/integrations.js';
import { validateTestAdminUrl } from './lab-database.mjs';
import { createOriginJournal, installOriginJournal } from '../src/journal.mjs';
import { projectTextBatch } from '../src/projection.mjs';
import { createOriginLabBootstrap } from '../src/bootstrap.mjs';
import { source } from './fixtures.mjs';

// Requires the repository build, never stale source emulation or a synthetic receipt receiver.
test('real Broker HTTP/PG COMMIT then sender SIGKILL before ACK replays one message and receipt', { timeout: 180000 }, async () => {
  const target = validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL);
  const admin = new Pool({ connectionString: target.href, max: 1 });
  const databases = [], pools = [];
  let app, child, releaseAck;
  try {
    async function database() {
      const name = `jrc_test_origin_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${name}"`); databases.push(name);
      const url = new URL(target); url.pathname = `/${name}`; return url;
    }
    const originUrl = await database(), brokerUrl = await database();
    // Same global-role lock used by repository integration tests; init-roles is lab-only.
    const lock = await admin.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended('jrc-test-global-roles',0))");
      await runMigrations(brokerUrl.href);
    } finally { await lock.query("SELECT pg_advisory_unlock(hashtextextended('jrc-test-global-roles',0))"); lock.release(); }
    const originPool = new Pool({ connectionString: originUrl.href, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 10000 }); pools.push(originPool);
    const brokerAdmin = new Pool({ connectionString: brokerUrl.href, max: 1 }); pools.push(brokerAdmin);
    const appUrl = new URL(brokerUrl); appUrl.username = 'jrc_app'; appUrl.password = '';
    const appPool = new Pool({ connectionString: appUrl.href, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 10000 }); pools.push(appPool);
    for (const pool of [originPool, brokerAdmin]) {
      assert.equal((await pool.query('SHOW fsync')).rows[0].fsync, 'on');
      assert.equal((await pool.query('SHOW full_page_writes')).rows[0].full_page_writes, 'on');
      assert.equal((await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'on');
    }
    await installOriginJournal(originPool);
    const org = randomUUID(), engine = `synthetic-${randomUUID()}`;
    const seed = await brokerAdmin.connect();
    try {
      await seed.query('BEGIN');
      await seed.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Synthetic origin lab',$2)", [org, engine]);
      const actor = randomUUID();
      await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic-test-only')", [actor, `${actor}@example.test`]);
      await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org, actor]);
      await seed.query('COMMIT');
    } catch (error) { await seed.query('ROLLBACK'); throw error; } finally { seed.release(); }
    const provider = (await brokerAdmin.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic origin') RETURNING id", [org])).rows[0].id;
    const instance = (await brokerAdmin.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic origin',$3,'CONNECTED') RETURNING id", [org, provider, engine])).rows[0].id;
    const transact = (organization, work) => withOrganizationTransaction(appPool, organization, work);
    const channel = (await transact(org, tx => ensureQrChannel(tx, org, instance))).id;
    const binding = { instanceId: instance, instanceName: engine, generation: 1, destinationId: channel, revision: 1 };
    const key = randomBytes(32), journal = createOriginJournal({ pool: originPool, encryptionKey: key });
    const [accepted] = await journal.acceptBatch(binding, projectTextBatch(binding, source()));
    const signingKey = 'synthetic-origin-crash-signing-key-'.repeat(2);
    const bearerToken = createHmac('sha256', signingKey).update(`qr-webhook\0${org}\0${channel}`).digest('base64url');
    const qr = createQrMessagingService({ baseUrl: 'https://synthetic-engine.invalid', apiKey: 'synthetic-test-only', webhookOrigin: 'https://synthetic-broker.invalid', signingKey,
      transact, resolveChannel: async id => id === channel ? { organizationId: org, instanceId: instance } : undefined });
    app = Fastify({ logger: false }); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    let committedResolve, sends = 0;
    const committed = new Promise(resolve => { committedResolve = resolve; });
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 200 && ++sends === 1) {
        const receipt = JSON.parse(payload);
        assert.equal(receipt.sourceEventId, accepted.id); assert.equal(receipt.durablyAccepted, true);
        // Actual route already awaited actual service + direct jrc_app transaction COMMIT.
        committedResolve(); await new Promise(resolve => { releaseAck = resolve; });
      }
      return payload;
    });
    await registerIntegrationRoutes(app, { qr, jwtSecret: 'synthetic-test-only', authenticateApiKey: async () => null, resolveCurrentRole: async () => null });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = `${address}/v1/webhooks/whatsapp/${channel}`;
    child = fork(new URL('./crash-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.send({ mode: 'dispatch', connectionString: originUrl.href, key: key.toString('hex'), binding, endpoint, bearerToken, timeoutMs: 10000 });
    let timer;
    try { await Promise.race([committed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('REAL_BROKER_COMMIT_NOT_OBSERVED')), 15000); })]); }
    finally { clearTimeout(timer); }
    // Verify durable Broker state independently while the first ACK remains held.
    const count = async table => Number((await brokerAdmin.query(`SELECT count(*) AS n FROM ${table} WHERE channel_id=$1`, [channel])).rows[0].n);
    assert.equal(await count('messaging_messages'), 1); assert.equal(await count('qr_origin_receipts'), 1);
    const exit = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await exit, [null, 'SIGKILL']); child = undefined;
    releaseAck(); releaseAck = undefined;
    assert.equal(await journal.claim(binding), null);
    const until = (await originPool.query('SELECT lease_until FROM jrc_evolution_origin.events WHERE id=$1', [accepted.id])).rows[0].lease_until;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(until).getTime() - Date.now()) + 50));
    const bootstrap = createOriginLabBootstrap({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, journal, binding, resolveBinding: async () => binding,
      transport: { endpoint, bearerToken, allowInsecureLoopbackForTests: true }, worker: { maxIterations: 1 } });
    await bootstrap.start(); await bootstrap.stop();
    assert.equal((await originPool.query('SELECT state FROM jrc_evolution_origin.events WHERE id=$1', [accepted.id])).rows[0].state, 'DELIVERED');
    assert.equal(sends, 2); assert.equal(await count('messaging_messages'), 1); assert.equal(await count('qr_origin_receipts'), 1);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    releaseAck?.(); await app?.close();
    for (const pool of pools.reverse()) await pool.end();
    try { for (const name of databases.reverse()) if (/^jrc_test_origin_[a-f0-9]{32}$/u.test(name)) await admin.query(`DROP DATABASE "${name}"`); }
    finally { await admin.end(); }
  }
});
