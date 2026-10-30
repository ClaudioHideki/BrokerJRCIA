import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
import { createChatwootHealth } from '../../src/modules/integrations/chatwoot-health.js';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import type { WhatsAppProvider } from '@jrc/providers';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';
import { createLifecycleService, withLifecycleWorkerTransaction, withLifecyclePlatformTransaction } from '../../src/modules/lifecycle/service.js';
import { createChannelFacade } from '../../src/modules/channels/facade.js';

describe('initial identity enrollment authorized by creation and pair mutations', () => {
  let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool;
  let nextAccount = 1;
  const encryptionKey = Buffer.alloc(32, 21).toString('base64'), vault = createIntegrationSecrets(encryptionKey);
  const transact = <T>(org: string, work: OrganizationTransaction<T>) => withOrganizationTransaction(pool, org, work);
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
  });
  afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });

  async function fixture(connected = false, authenticatedCreation = true, enabled = true, serviceKey = false, lostCreation = false, facadeCreation = false,
    creationLogout?: 'instance' | 'channel' | 'instance-noop') {
    const accountId = nextAccount++;
    const [org, actor] = await runInAdminTransaction(db.pool, async tx => {
      const org = (await createOrganization(tx, { name: 'Initial fixture', slug: randomUUID() })).id;
      const actor = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${randomUUID()}@example.test`])).rows[0].id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')", [org, actor]);
      const backup = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${randomUUID()}@example.test`])).rows[0].id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [org, backup]);
      return [org, actor] as const;
    });
    let state = connected ? 'CONNECTED' : 'DISCONNECTED', phone: string | null = connected ? '15555550100' : null;
    const auth = createChatwootControlAuth({ enabled: true, managedOrigin: 'https://managed.example.com', hmacSecret: 'synthetic-identity-control-hmac-'.repeat(2), transact, resolveCurrentRole: createMessagingMembershipResolver(authPool) });
    const [instance, channel] = await transact(org, async tx => {
      await tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://managed.example.com',$2,$3,'READY')", [org, accountId, vault.encrypt(`${org}:chatwoot-account`, 'synthetic-token')]);
      const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0].id;
      const instance = (await tx.query('INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,$3,$4) RETURNING id', [org, provider, randomUUID(), state])).rows[0].id;
      return [instance, (await ensureQrChannel(tx, org, instance)).id] as const;
    });
    const remote = new Map<number, Record<string, unknown>>(); let nextInbox = 31;
    let duringRead = async () => {};
    const health = createChatwootHealth({ transact, encryptionKey, readIdentity: async () => { await duringRead(); return { connected: state === 'CONNECTED', phone }; } });
    let duringPair = async () => {};
    const beginConnection = vi.fn(async () => {
      await duringPair();
      return { type: 'QR_CODE', encoding: 'BASE64', value: 'synthetic-qr', expiresAt: new Date(Date.now() + 60000).toISOString() };
    });
    const instances = createInstanceService({ repository: createPostgresInstanceRepository(), providers: { getProvider: () => ({ beginConnection, getStatus: async () => state,
      disconnect: async () => { state = 'DISCONNECTED'; phone = null; } }) as unknown as WhatsAppProvider }, runInOrganizationTransaction: transact, writeAudit: writeTenantAudit });
    const options = { baseUrl: 'https://managed.example.com', publicOrigin: 'https://broker.example.com', encryptionKey, transact, resolveIntegration: async () => org,
      activateQr: async (id: string, selected: string) => transact(id, tx => ensureQrChannel(tx, id, selected)),
      health, controlAuth: enabled ? auth : { ...auth, enabled: false },
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/profile')) return Response.json({ accounts: [{ id: accountId, role: 'administrator' }] });
        if (path.endsWith('/inboxes') && init?.method === 'POST') {
          const input = JSON.parse(String(init.body)), inbox = { id: nextInbox++, name: input.name, channel_type: 'Channel::Api', webhook_url: input.channel.webhook_url, secret: 'synthetic-inbox-secret' };
          remote.set(inbox.id, inbox);
          if (lostCreation) throw new TypeError('SYNTHETIC_CREATE_RESPONSE_LOST');
          return Response.json(inbox);
        }
        if (path.endsWith('/inboxes')) return Response.json({ payload: [...remote.values()] });
        const inbox = /\/inboxes\/(\d+)$/.exec(path); if (inbox) return Response.json(remote.get(Number(inbox[1])));
        throw new Error('UNEXPECTED_FIXTURE_ROUTE');
      },
    };
    const chatwoot = createChatwootService(options);
    let control: ReturnType<typeof createChatwootControlService> | undefined;
    const facade = () => createChannelFacade({ instances, meta: { start: vi.fn() }, chatwoot, chatwootControl: control,
      transact, activateQr: options.activateQr });
    const context = { credentialKind: 'JWT' as const, organizationId: org, actorId: actor, requestId: randomUUID(),
      deadline: new Date(Date.now() + 30000), signal: AbortSignal.timeout(30000) };
    let creationLogoutResult: Awaited<ReturnType<typeof instances.disconnectInstance>> | undefined;
    if (creationLogout) duringRead = async () => {
      duringRead = async () => {};
      if (creationLogout === 'instance-noop') await transact(org, tx => tx.query("UPDATE instances SET status='DISCONNECTED' WHERE organization_id=$1 AND id=$2", [org, instance]));
      if (creationLogout !== 'channel') creationLogoutResult = await instances.disconnectInstance(context, { instanceId: instance, idempotencyKey: randomUUID() });
      else await facade().disconnect(context, instance, randomUUID());
      // Model a provider read that still reports connected after an explicit logout.
      // The local DISCONNECT operation is authoritative even if the upstream view lags.
      state = 'CONNECTED'; phone = '15555550100';
    };
    let principal = await auth.authorize({ kind: 'JWT', organizationId: org, actorId: actor, role: 'ADMIN' }, 'chatwoot:manage');
    if (serviceKey) {
      const issued = await auth.issueCredential(principal.authentication, { name: 'Synthetic native service', scopes: ['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair'], expiresAt: null }, randomUUID());
      principal = await auth.authorize({ kind: 'API_KEY', organizationId: org, actorId: null, apiKeyId: issued.id, scopes: [] }, 'chatwoot:manage', undefined, '42');
    }
    let created;
    try {
      if (facadeCreation) {
        await facade().bindDestination(org, instance, { name: 'Fixture', replaceExistingWebhook: false }, actor, principal.authentication);
        created = await chatwoot.status(org);
      } else created = await chatwoot.connect(org, { channelId: channel, name: 'Fixture' }, actor, authenticatedCreation ? (serviceKey ? principal : principal.authentication) : undefined);
    }
    catch (failure) { if (!lostCreation) throw failure; created = await chatwoot.status(org); }
    const integration = created.connections[0]!.id;
    if (lostCreation) await chatwoot.reconcileConnection(org, integration);
    control = createChatwootControlService({ ...options, auth, health, instances, chatwoot });
    const row = () => transact(org, async tx => (await tx.query('SELECT * FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2', [org, integration])).rows[0]);
    const observe = async (number = '15555550100') => {
      state = 'CONNECTED'; phone = number;
      await transact(org, async tx => {
        await health.observe(tx, org, channel, { connected: true, phone });
        await tx.query("UPDATE instances SET status='CONNECTED' WHERE organization_id=$1 AND id=$2", [org, instance]);
      });
    };
    const addConnection = async () => {
      const [additionalInstance, additionalChannel] = await transact(org, async tx => {
        const id = (await tx.query(`INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status)
          SELECT organization_id,provider_account_id,$3,$3,'DISCONNECTED' FROM instances WHERE organization_id=$1 AND id=$2 RETURNING id`, [org, instance, randomUUID()])).rows[0].id;
        return [id, (await ensureQrChannel(tx, org, id)).id] as const;
      });
      const result = await chatwoot.connect(org, { channelId: additionalChannel, name: 'Additional fixture' }, actor, principal.authentication);
      const created = result.connections.find(connection => connection.channelId === additionalChannel)!;
      return { instance: additionalInstance, channel: additionalChannel, integration: created.id, inbox: Number(created.inboxId) };
    };
    return { org, actor, auth, principal, chatwoot, control, health, instances, integration, instance, channel, remote, row, observe, beginConnection, facade: facade(),
      context, addConnection, creationLogout: () => creationLogoutResult,
      async run() { await chatwoot.initialIdentity?.runOnce(org); },
      duringPair(work: () => Promise<void>) { duringPair = work; }, duringRead(work: () => Promise<void>) { duringRead = work; } };
  }

  it('enrolls the connected number once from a new authenticated creation', async () => {
    const t = await fixture(true);
    expect(await t.control.status(t.principal, t.integration)).toMatchObject({ identityApproved: true, identityStatus: 'CONFIRMED' });
    const saved = await t.row(); expect(saved.identity_enforced).toBe(true); expect(saved.initial_identity_intent).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('15555550100');
  });

  it.each(['instance', 'channel'] as const)('fences %s logout during creation even when the provider read still reports connected', async route => {
    const t = await fixture(true, true, true, false, false, false, route);
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await transact(t.org, tx => tx.query("SELECT id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows).toHaveLength(0);
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('fences an accepted no-op instance logout during CREATE without manufacturing a provider operation', async () => {
    const t = await fixture(true, true, true, false, false, false, 'instance-noop');
    expect(t.creationLogout()).toMatchObject({ instance: { status: 'DISCONNECTED' }, operationId: null, replayed: false, pending: false, reconciliationRequired: false });
    expect((await transact(t.org, tx => tx.query("SELECT id FROM provider_operations WHERE organization_id=$1 AND instance_id=$2 AND operation_type='DISCONNECT'", [t.org, t.instance]))).rows).toHaveLength(0);
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await transact(t.org, tx => tx.query("SELECT id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows).toHaveLength(0);
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('fences an accepted no-op instance logout while two PAIR completions observe a stale connected provider', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    let observed = 0, release!: () => void;
    const bothReading = new Promise<void>(resolve => { release = resolve; });
    let logout: ReturnType<typeof t.instances.disconnectInstance> | undefined;
    t.duringRead(async () => {
      if (++observed === 2) release();
      await bothReading;
      if (!logout) {
        await transact(t.org, tx => tx.query("UPDATE instances SET status='DISCONNECTED' WHERE organization_id=$1 AND id=$2", [t.org, t.instance]));
        logout ??= t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: randomUUID() });
      }
      expect(await logout).toMatchObject({ operationId: null, replayed: false, pending: false });
    });
    await Promise.all([t.run(), t.run()]);
    expect((await transact(t.org, tx => tx.query("SELECT id FROM provider_operations WHERE organization_id=$1 AND instance_id=$2 AND operation_type='DISCONNECT'", [t.org, t.instance]))).rows).toHaveLength(0);
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
    expect((await transact(t.org, tx => tx.query("SELECT id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows).toHaveLength(0);
  });

  it('does not cancel a fresh PAIR grant when an older completed no-op logout is only replayed', async () => {
    const t = await fixture(), key = randomUUID();
    expect(await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: key })).toMatchObject({ operationId: null, replayed: false, pending: false });
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => { expect(await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: key })).toMatchObject({ operationId: null, replayed: true, pending: false }); });
    await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
    expect((await transact(t.org, tx => tx.query("SELECT id FROM idempotency_records WHERE organization_id=$1 AND route=$2", [t.org, `/v1/instances/${t.instance}/disconnect`]))).rows).toHaveLength(1);
  });

  it('fences replacement of an expired no-op request even when the number of idempotency rows stays unchanged', async () => {
    const t = await fixture(), key = randomUUID(), route = `/v1/instances/${t.instance}/disconnect`;
    await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: key });
    const old = (await transact(t.org, tx => tx.query('SELECT id FROM idempotency_records WHERE organization_id=$1 AND route=$2', [t.org, route]))).rows[0].id;
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => {
      await transact(t.org, async tx => {
        await tx.query("UPDATE instances SET status='DISCONNECTED' WHERE organization_id=$1 AND id=$2", [t.org, t.instance]);
        await tx.query("UPDATE idempotency_records SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [t.org, old]);
      });
      expect(await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: key })).toMatchObject({ operationId: null, replayed: false });
    });
    await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull();
    const current = (await transact(t.org, tx => tx.query('SELECT id FROM idempotency_records WHERE organization_id=$1 AND route=$2', [t.org, route]))).rows;
    expect(current).toHaveLength(1); expect(current[0].id).not.toBe(old);
  });

  it.each(['other instance', 'other tenant'] as const)('does not cancel initial authority after an accepted no-op logout for an %s', async scope => {
    const t = await fixture();
    const target = scope === 'other instance' ? { ...await t.addConnection(), context: t.context, instances: t.instances } : await fixture();
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => { await target.instances.disconnectInstance(target.context, { instanceId: target.instance, idempotencyKey: randomUUID() }); });
    await t.run(); expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('requires a fresh administrative pair when an older live intent has no disconnect-request fingerprint', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    await transact(t.org, tx => tx.query("UPDATE chatwoot_connection_health SET initial_identity_intent=initial_identity_intent-'disconnectRequestsHash' WHERE organization_id=$1 AND integration_id=$2", [t.org, t.integration]));
    await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('does not starve a fifth eligible connection when the first four remote inboxes fail verification', async () => {
    const t = await fixture();
    const connections = [{ instance: t.instance, channel: t.channel, integration: t.integration, inbox: 31 }];
    for (let i = 0; i < 4; i++) connections.push(await t.addConnection());
    for (const connection of connections) await t.control.pair(t.principal, connection.integration, randomUUID());
    await t.observe();
    for (const [index, connection] of connections.entries()) await transact(t.org, async tx => {
      await t.health.observe(tx, t.org, connection.channel, { connected: true, phone: '15555550100' });
      await tx.query("UPDATE instances SET status='CONNECTED' WHERE organization_id=$1 AND id=$2", [t.org, connection.instance]);
      await tx.query("UPDATE chatwoot_connection_health SET updated_at=clock_timestamp()-interval '1 hour'+($3::integer*interval '1 second') WHERE organization_id=$1 AND integration_id=$2", [t.org, connection.integration, index]);
    });
    for (const connection of connections.slice(0, 4)) t.remote.set(connection.inbox, { ...t.remote.get(connection.inbox), secret: 'synthetic-remote-secret-mismatch' });
    const before = (await transact(t.org, tx => tx.query('SELECT integration_id,updated_at,observed_at FROM chatwoot_connection_health WHERE organization_id=$1 ORDER BY integration_id', [t.org]))).rows;
    await t.run(); await t.run();
    const healthy = (await transact(t.org, tx => tx.query('SELECT approved_fingerprint FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2', [t.org, connections[4]!.integration]))).rows[0];
    expect(healthy.approved_fingerprint).toEqual(expect.any(String));
    for (const connection of connections.slice(0, 4)) {
      const failed = (await transact(t.org, tx => tx.query('SELECT approved_fingerprint,updated_at,observed_at FROM chatwoot_connection_health WHERE organization_id=$1 AND integration_id=$2', [t.org, connection.integration]))).rows[0];
      expect(failed.approved_fingerprint).toBeNull();
      expect(failed.updated_at).toEqual(before.find(row => row.integration_id === connection.integration)!.updated_at);
      expect(failed.observed_at).toEqual(before.find(row => row.integration_id === connection.integration)!.observed_at);
    }
  });

  it('GET observation and the worker cannot approve a new connection before an administrative pair intent', async () => {
    const t = await fixture(); await t.observe();
    expect(await t.control.status(t.principal, t.integration)).toMatchObject({ identityApproved: false });
    await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
  });

  it('survives a connection callback arriving before the authorized pair response', async () => {
    const t = await fixture(); t.duringPair(() => t.observe());
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.run();
    expect(await t.control.status(t.principal, t.integration)).toMatchObject({ identityApproved: true, identityStatus: 'CONFIRMED' });
    expect((await t.row()).initial_identity_intent).toBeNull();
  });

  it('retains initial enrollment when the created inbox is recovered after a lost create response', async () => {
    const t = await fixture(false, true, true, false, true);
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('enrolls a connected number through the administrative channel facade destination mutation', async () => {
    const t = await fixture(true, true, true, false, false, true);
    await t.control.status(t.principal, t.integration);
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it.each(['pair', 'reconnect'] as const)('arms initial authority from the administrative channel facade %s mutation', async action => {
    const t = await fixture();
    await t.facade[action](t.context, t.instance, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('does not let an operator arm initial authority through the channel facade', async () => {
    const t = await fixture();
    await db.pool.query("UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2", [t.org, t.actor]);
    await expect(t.facade.pair(t.context, t.instance, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
  });

  it('cancels armed initial authority through the channel facade disconnect mutation', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID());
    await t.facade.disconnect(t.context, t.instance, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull();
  });

  it.each([false, true])('rejects a direct instance disconnect after pair intent (already connected: %s)', async alreadyConnected => {
    const t = await fixture(false, true, true, false, alreadyConnected);
    if (alreadyConnected) await t.observe();
    await t.control.pair(t.principal, t.integration, randomUUID());
    await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: randomUUID() });
    await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('fences direct logout during the fresh provider identity read', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => {
      await t.instances.disconnectInstance(t.context, { instanceId: t.instance, idempotencyKey: randomUUID() });
      await t.observe();
    });
    await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
  });

  it('preserves opaque idempotency keys when pairing through the channel facade', async () => {
    const t = await fixture(), key = 'channel/key.with spaces';
    await t.facade.pair(t.context, t.instance, key);
    await t.facade.pair(t.context, t.instance, key);
    expect(t.beginConnection).toHaveBeenCalledTimes(1);
  });

  it('never enrolls an existing unapproved connection through GET, pair or the worker', async () => {
    const t = await fixture(false, false); await t.control.status(t.principal, t.integration);
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe(); await t.run();
    expect(await t.control.status(t.principal, t.integration)).toMatchObject({ identityApproved: false, identityStatus: 'CONFIRMATION_REQUIRED' });
  });

  it('does not overwrite an approved number after a different identity is observed', async () => {
    const t = await fixture(true); await t.control.status(t.principal, t.integration);
    const before = await t.row(); await t.observe('15555550199'); await t.run();
    expect((await t.row()).approved_fingerprint).toBe(before.approved_fingerprint);
    expect(await t.control.status(t.principal, t.integration)).toMatchObject({ identityApproved: true, identityStatus: 'CONFIRMATION_REQUIRED' });
  });

  it('revokes an armed initial intent when the administrative creator loses membership', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID());
    await db.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2", [t.org, t.actor]);
    await t.observe(); await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await t.row()).initial_identity_intent).toBeNull();
  });

  it('does not opt legacy configuration into enrollment when the control facade is disabled', async () => {
    const t = await fixture(false, true, false); await t.control.status(t.principal, t.integration);
    expect((await t.row()).identity_enforced).toBe(false);
    expect((await t.row()).initial_identity_intent).toBeNull();
  });

  it('retains the attributed native actor when a manage-scoped account key creates the connection', async () => {
    const t = await fixture(true, true, true, true);
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
    const audit = (await transact(t.org, tx => tx.query("SELECT actor_api_key_id,external_actor_id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows;
    expect(audit).toEqual([{ actor_api_key_id: t.principal.authentication.kind === 'API_KEY' ? t.principal.authentication.apiKeyId : null, external_actor_id: '42' }]);
  });

  it('does not amplify a pair-only key into initial administrative authority', async () => {
    const t = await fixture(), issued = await t.auth.issueCredential(t.principal.authentication, { name: 'Synthetic weak key', scopes: ['chatwoot:read', 'chatwoot:pair'], expiresAt: null }, randomUUID());
    const p = await t.auth.authorize({ kind: 'API_KEY', organizationId: t.org, actorId: null, apiKeyId: issued.id, scopes: ['chatwoot:manage'] }, 'chatwoot:read', t.integration);
    await expect(t.control.pair(p, t.integration, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
  });

  it('does not approve a changed number between arming the grant and its first completion', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID());
    await t.observe(); await t.observe('15555550199'); await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull(); expect((await t.row()).initial_identity_intent).toBeNull();
  });

  it('refuses expired pair authority while allowing a new explicit administrative pair intent', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID());
    await db.pool.query("UPDATE chatwoot_connection_health SET initial_identity_pair_expires_at=clock_timestamp()-interval '1 second',pair_window_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [t.org]);
    await t.observe(); await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.run();
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
  });

  it('retires an unused initial intent after its finite creation deadline', async () => {
    const t = await fixture();
    await db.pool.query("UPDATE chatwoot_connection_health SET initial_identity_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [t.org]);
    await t.run(); expect((await t.row()).initial_identity_intent).toBeNull();
  });

  it('cancels active initial enrollment when the administrator explicitly disconnects', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID());
    await t.control.disconnect(t.principal, t.integration, randomUUID()); await t.observe(); await t.run();
    expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await t.row()).initial_identity_pair_expires_at).toBeNull();
  });

  it.each(['credential', 'destination', 'binding', 'key'] as const)('refuses an armed native grant after its %s changes', async change => {
    const t = await fixture(false, true, true, true); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    const sql = change === 'credential' ? 'UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1'
      : change === 'destination' ? 'UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1'
        : change === 'binding' ? 'UPDATE chatwoot_control_bindings SET active=false WHERE organization_id=$1'
          : 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE organization_id=$1';
    await db.pool.query(sql, [t.org]); await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
  });

  it('rechecks context after provider I/O before accepting its initial observation', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => { await db.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1', [t.org]); });
    await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
  });

  it.each(['suspension', 'role', 'key', 'binding'] as const)('revalidates %s after provider I/O before consuming initial authority', async change => {
    const t = await fixture(false, true, true, change === 'key' || change === 'binding');
    await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    t.duringRead(async () => {
      const sql = change === 'suspension' ? "UPDATE organizations SET status='SUSPENDED' WHERE id=$1"
        : change === 'role' ? "UPDATE memberships SET role='OPERATOR' WHERE organization_id=$1 AND user_id=$2"
          : change === 'key' ? 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE organization_id=$1'
            : 'UPDATE chatwoot_control_bindings SET active=false WHERE organization_id=$1';
      await db.pool.query(sql, change === 'role' ? [t.org, t.actor] : [t.org]);
    });
    await t.run(); expect((await t.row()).approved_fingerprint).toBeNull();
    expect((await transact(t.org, tx => tx.query("SELECT id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows).toHaveLength(0);
  });

  it('consumes a live intent once when two worker objects race to finish enrollment', async () => {
    const t = await fixture(); await t.control.pair(t.principal, t.integration, randomUUID()); await t.observe();
    await Promise.all([t.run(), t.run()]);
    expect((await t.row()).approved_fingerprint).toEqual(expect.any(String));
    expect((await transact(t.org, tx => tx.query("SELECT id FROM integration_audit WHERE organization_id=$1 AND resource_id=$2 AND action='CONTROL_IDENTITY_CONFIRMED'", [t.org, t.integration]))).rows).toHaveLength(1);
  });

  it('keeps tenant RLS and denies authentication roles access to enrollment metadata', async () => {
    const t = await fixture(), other = await fixture();
    expect((await transact(other.org, tx => tx.query('SELECT initial_identity_intent FROM chatwoot_connection_health WHERE organization_id=$1', [t.org]))).rows).toEqual([]);
    await expect(authPool.query('SELECT initial_identity_intent FROM chatwoot_connection_health')).rejects.toMatchObject({ code: '42501' });
    expect(await transact(t.org, tx => probeRequiredRuntimeSchema(sql => tx.query(sql)))).toBe(true);
  });

  it('purges enrollment with its channel while preserving another tenant', async () => {
    const t = await fixture(), other = await fixture();
    const worker = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_lifecycle') });
    const platform = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_platform') });
    try {
      const lifecycle = createLifecycleService({ transact: work => withLifecycleWorkerTransaction(worker, work), deprovision: vi.fn(async () => {}) });
      const requests = createLifecycleService({ transact: work => withLifecyclePlatformTransaction(platform, work), deprovision: vi.fn(async () => {}) });
      const name = (await db.pool.query('SELECT name FROM instances WHERE organization_id=$1 AND id=$2', [t.org, t.instance])).rows[0].name;
      const requested = await requests.requestChannel(t.org, t.instance, name, 'Synthetic cleanup', 'TENANT', t.actor);
      expect(requested.status).toBe('REQUESTED'); expect(await lifecycle.processOne()).toBe(true);
      expect((await db.pool.query('SELECT initial_identity_intent FROM chatwoot_connection_health WHERE organization_id=$1', [t.org])).rows).toEqual([]);
      expect((await other.row()).initial_identity_intent).not.toBeNull();
    } finally { await worker.end(); await platform.end(); }
  });
});
