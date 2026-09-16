import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createOnboardingService } from '../../src/modules/integrations/chatwoot-onboarding.js';
import { createChatwootService } from '../../src/modules/integrations/chatwoot-service.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import type { WhatsAppProvider } from '@jrc/providers';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';

describe('durable Chatwoot onboarding with tenant PostgreSQL', () => {
  let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool, org: string, other: string, owner: string, providerId: string;
  let principal: ChatwootControlPrincipal, auth: ReturnType<typeof createChatwootControlAuth>;
  let service: ReturnType<typeof createOnboardingService>, chatwoot: ReturnType<typeof createChatwootService>, instances: ReturnType<typeof createInstanceService>;
  const transact = <T>(id: string, fn: OrganizationTransaction<T>) => withOrganizationTransaction(pool, id, fn);
  const provision = vi.fn(async () => ({ reference: { id: `synthetic-${randomUUID()}` } }));
  const remote = new Map<number, Record<string, unknown>>(), members = new Map<number, number[]>();
  let inboxPosts = 0, agentPosts = 0, uncertainInbox = false, rejectedAgents = false;
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(new Headers(init?.headers).get('api_access_token')).toBe('synthetic-chatwoot-token');
    // A remote call must not hold the tenant transaction that created the operation.
    const active = await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_app' AND state='idle in transaction'");
    expect(active.rowCount).toBe(0);
    if (path.endsWith('/inboxes') && init?.method === 'POST') {
      inboxPosts++; const id = 30 + inboxPosts;
      const inbox = { id, name: body.name, channel_type: 'Channel::Api', webhook_url: body.channel.webhook_url, secret: 'synthetic-inbox-secret' };
      remote.set(id, inbox);
      if (uncertainInbox) { uncertainInbox = false; throw new TypeError('synthetic response lost'); }
      return Response.json(inbox);
    }
    if (path.endsWith('/inboxes')) return Response.json({ payload: [...remote.values()] });
    if (/\/inboxes\/\d+$/.test(path)) return Response.json(remote.get(Number(path.split('/').at(-1))));
    if (path.endsWith('/agents')) return Response.json([{ id: 1, name: 'Fixture agent', email: 'fixture@example.test', role: 'agent' }]);
    if (path.endsWith('/inbox_members') && init?.method === 'POST') {
      agentPosts++;
      if (rejectedAgents) return Response.json({ error: 'synthetic denied' }, { status: 403 });
      members.set(body.inbox_id, body.user_ids); return Response.json({ payload: [] });
    }
    if (/\/inbox_members\/\d+$/.test(path)) return Response.json({ payload: (members.get(Number(path.split('/').at(-1))) ?? []).map(id => ({ id, name: 'Fixture agent', email: 'fixture@example.test' })) });
    throw new Error('UNEXPECTED_FIXTURE_ROUTE');
  }) as unknown as typeof globalThis.fetch;
  const activateQr = async (id: string, instanceId: string) => transact(id, tx => ensureQrChannel(tx, id, instanceId));
  const restart = () => createOnboardingService({ transact, auth, instances, chatwoot, activateQr });
  const input = () => ({ name: 'Fixture inbox', source: { kind: 'NEW' as const, instanceName: `Fixture ${randomUUID()}`, providerAccountId: providerId }, agentIds: [1], replaceExistingWebhook: false });
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    [org, other, owner] = await runInAdminTransaction(db.pool, async tx => {
      const a = (await createOrganization(tx, { name: 'Onboarding A', slug: 'onboarding-a' })).id;
      const b = (await createOrganization(tx, { name: 'Onboarding B', slug: 'onboarding-b' })).id;
      const u = (await tx.query("INSERT INTO users(email,password_hash) VALUES('onboarding@example.test','synthetic') RETURNING id")).rows[0].id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [a, u]);
      const backup = (await tx.query("INSERT INTO users(email,password_hash) VALUES('backup@example.test','synthetic') RETURNING id")).rows[0].id;
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$3,'OWNER'),($2,$3,'OWNER')", [a, b, backup]);
      return [a, b, u];
    });
    await db.pool.query('UPDATE organization_limits SET max_instances=100 WHERE organization_id=$1', [org]);
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
    auth = createChatwootControlAuth({ enabled: true, hmacSecret: 'synthetic-hmac-at-least-32-characters', managedOrigin: 'https://managed.example.com', transact, resolveCurrentRole: createMessagingMembershipResolver(authPool) });
    await transact(org, async tx => {
      await tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://managed.example.com',1,$2,'READY')", [org, createIntegrationSecrets(encryptionKey).encrypt(`${org}:chatwoot-account`, 'synthetic-chatwoot-token')]);
      providerId = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0].id;
    });
    principal = await auth.authorize({ kind: 'JWT', organizationId: org, actorId: owner, role: 'OWNER' }, 'chatwoot:manage');
    instances = createInstanceService({ repository: createPostgresInstanceRepository(), providers: { getProvider: () => ({ provisionInstance: provision, getStatus: async () => 'DISCONNECTED' }) as unknown as WhatsAppProvider }, runInOrganizationTransaction: transact, writeAudit: writeTenantAudit });
    chatwoot = createChatwootService({ baseUrl: 'https://managed.example.com', publicOrigin: 'https://broker.example.com', encryptionKey, fetch, transact, resolveIntegration: async () => org });
    service = restart();
  });
  afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });
  it('creates one operation concurrently, rejects hash conflicts, resumes with new service objects at every stage', async () => {
    const value = input(), key = randomUUID();
    const [a, b] = await Promise.all([service.start(principal, value, key), service.start(principal, value, key)]);
    expect(a.operationId).toBe(b.operationId);
    expect(await service.list(principal)).toMatchObject({ data: [{ operationId: a.operationId }] });
    await expect(service.start(principal, { ...value, name: 'Different' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(provision).not.toHaveBeenCalled();
    for (const stage of ['ACTIVATE_CHANNEL', 'LINK_INBOX', 'ASSIGN_AGENTS', 'VERIFY', 'DONE']) {
      service = restart(); await service.runOnce(org);
      expect(await service.get(principal, a.operationId)).toMatchObject({ stage });
    }
    expect(await service.get(principal, a.operationId)).toMatchObject({ state: 'SUCCEEDED', inboxId: 31 });
    expect(provision).toHaveBeenCalledTimes(1); expect(inboxPosts).toBe(1); expect(agentPosts).toBe(1);
    const rows = (await transact(org, tx => tx.query('SELECT * FROM chatwoot_onboarding_operations'))).rows;
    expect(JSON.stringify(rows)).not.toMatch(/synthetic-chatwoot-token|synthetic-inbox-secret|QR_CODE/);
    expect((await transact(other, tx => tx.query('SELECT * FROM chatwoot_onboarding_operations'))).rows).toEqual([]);
  });
  it('reconciles a remote inbox created before a lost response without issuing another POST', async () => {
    const op = await service.start(principal, input(), randomUUID());
    await service.runOnce(org); await service.runOnce(org);
    uncertainInbox = true; await service.runOnce(org);
    const failed = await service.get(principal, op.operationId);
    expect(failed.state).toBe('UNKNOWN'); expect(failed.integrationId).toBeTruthy();
    const count = inboxPosts;
    await expect(service.recover(principal, op.operationId, 'RETRY', randomUUID())).rejects.toMatchObject({ code: 'ONBOARDING_RECONCILIATION_REQUIRED' });
    service = restart(); await service.recover(principal, op.operationId, 'RECONCILE', randomUUID());
    await service.runOnce(org); await service.runOnce(org); await service.runOnce(org);
    expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'SUCCEEDED' }); expect(inboxPosts).toBe(count);
  });
  it('agent failure retries only that stage; cancellation preserves all created resources', async () => {
    const op = await service.start(principal, input(), randomUUID());
    await service.runOnce(org); await service.runOnce(org); await service.runOnce(org);
    rejectedAgents = true; await service.runOnce(org);
    expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'FAILED', stage: 'ASSIGN_AGENTS' });
    const count = inboxPosts, instancesBefore = provision.mock.calls.length;
    rejectedAgents = false;
    await service.recover(principal, op.operationId, 'RETRY', randomUUID());
    await service.runOnce(org); await service.runOnce(org);
    expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'SUCCEEDED' });
    expect(inboxPosts).toBe(count); expect(provision).toHaveBeenCalledTimes(instancesBefore);
    const cancel = await service.start(principal, input(), randomUUID()); await service.runOnce(org);
    const before = await service.get(principal, cancel.operationId);
    await service.recover(principal, cancel.operationId, 'CANCEL', randomUUID()); await service.runOnce(org);
    expect(await service.get(principal, cancel.operationId)).toMatchObject({ state: 'FAILED', lastError: 'ONBOARDING_CANCELLED', instanceId: before.instanceId });
    expect((await transact(org, tx => tx.query('SELECT 1 FROM instances WHERE id=$1', [before.instanceId]))).rowCount).toBe(1);
  });
  it('expired lease is UNKNOWN; removed administrators cannot resume the operation', async () => {
    const op = await service.start(principal, input(), randomUUID());
    await transact(org, tx => tx.query("UPDATE chatwoot_onboarding_operations SET state='RUNNING',lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE id=$1", [op.operationId, randomUUID()]));
    const count = provision.mock.calls.length; await service.runOnce(org);
    expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'UNKNOWN' }); expect(provision).toHaveBeenCalledTimes(count);
    await transact(org, tx => tx.query("UPDATE memberships SET status='DISABLED' WHERE user_id=$1", [owner]));
    await expect(service.recover(principal, op.operationId, 'RECONCILE', randomUUID())).rejects.toMatchObject({ status: 403 });
    await transact(org, tx => tx.query("UPDATE memberships SET status='ACTIVE' WHERE user_id=$1", [owner]));
    await service.recover(principal, op.operationId, 'CANCEL', randomUUID());
  });
  it('retains the instance ID before the provider result and reconciles a crash without another provisioning POST', async () => {
    const original = instances.createInstance.bind(instances);
    const crash = vi.spyOn(instances, 'createInstance').mockImplementationOnce(async (...args) => {
      await original(...args); throw new TypeError('synthetic worker stopped after remote creation');
    });
    const op = await service.start(principal, input(), randomUUID()); await service.runOnce(org);
    const saved = await service.get(principal, op.operationId);
    expect(saved).toMatchObject({ stage: 'INSTANCE', state: 'UNKNOWN' }); expect(saved.instanceId).toBeTruthy();
    const count = provision.mock.calls.length; crash.mockRestore(); service = restart();
    await service.recover(principal, op.operationId, 'RECONCILE', randomUUID());
    for (let i = 0; i < 5; i++) await service.runOnce(org);
    expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'SUCCEEDED', instanceId: saved.instanceId });
    expect(provision).toHaveBeenCalledTimes(count);
  });
  it('reports a known quota failure as FAILED and keeps the provider uncalled', async () => {
    const op = await service.start(principal, input(), randomUUID()), count = provision.mock.calls.length;
    await db.pool.query('UPDATE organization_limits SET max_instances=1 WHERE organization_id=$1', [org]);
    try {
      await service.runOnce(org);
      expect(await service.get(principal, op.operationId)).toMatchObject({ state: 'FAILED', lastError: 'INSTANCE_LIMIT_REACHED' });
      expect(provision).toHaveBeenCalledTimes(count);
    } finally { await db.pool.query('UPDATE organization_limits SET max_instances=100 WHERE organization_id=$1', [org]); }
    await service.recover(principal, op.operationId, 'CANCEL', randomUUID());
  });
});
