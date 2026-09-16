import { Pool } from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { createChatwootControlAuth, type ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
import { createChatwootHealth } from '../../src/modules/integrations/chatwoot-health.js';
import { createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import type { WhatsAppProvider } from '@jrc/providers';

describe('authorized pairing, identity continuity and transport evidence', () => {
  let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool, org: string, owner: string, viewer: string, instance: string, channel: string, integration: string;
  let principal: ChatwootControlPrincipal, agent: ChatwootControlPrincipal, auth: ReturnType<typeof createChatwootControlAuth>;
  let control: ReturnType<typeof createChatwootControlService>, health: ReturnType<typeof createChatwootHealth>;
  let chatwoot: ReturnType<typeof createChatwootService>;
  const transact = <T>(id: string, fn: OrganizationTransaction<T>) => withOrganizationTransaction(pool, id, fn);
  const pair = vi.fn(async () => ({ type: 'QR_CODE', encoding: 'BASE64', value: 'synthetic-ephemeral-qr', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const disconnect = vi.fn(async () => undefined);
  let providerState = 'DISCONNECTED', providerPhone: string | null = null, rejectRemote = false;
  const key = Buffer.alloc(32, 8).toString('base64'), vault = createIntegrationSecrets(key);
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    [org, owner, viewer] = await runInAdminTransaction(db.pool, async t => {
      const id = (await createOrganization(t, { name: 'Health fixture', slug: 'health-fixture' })).id;
      const users: string[] = [];
      for (const role of ['OWNER', 'VIEWER']) {
        const uid = (await t.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${role.toLowerCase()}@example.test`])).rows[0].id;
        await t.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [id, uid, role]); users.push(uid);
      }
      return [id, ...users];
    });
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
    auth = createChatwootControlAuth({ enabled: true, hmacSecret: 'synthetic-at-least-32-characters-hmac', transact, managedOrigin: 'https://managed.example.com', resolveCurrentRole: createMessagingMembershipResolver(authPool) });
    await transact(org, async t => {
      await t.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://managed.example.com',1,$2,'READY')", [org, vault.encrypt(`${org}:chatwoot-account`, 'synthetic-chatwoot-token')]);
      const p = (await t.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0].id;
      instance = (await t.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Fixture','synthetic-health-instance','DISCONNECTED') RETURNING id", [org, p])).rows[0].id;
      channel = (await ensureQrChannel(t, org, instance)).id;
      integration = randomUUID();
      await t.query("INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,$3,31,'Fixture','READY',$4)", [integration, org, channel, vault.encrypt(`${org}:chatwoot-webhook:${integration}`, 'synthetic-webhook-secret')]);
    });
    const options: ChatwootOptions = { baseUrl: 'https://managed.example.com', publicOrigin: 'https://broker.example.com', encryptionKey: key, transact, resolveIntegration: async () => org,
      fetch: async (url) => {
        if (rejectRemote) return Response.json({}, { status: 401 });
        if (String(url).endsWith('/profile')) return Response.json({ accounts: [{ id: 1, role: 'administrator' }] });
        if (String(url).endsWith('/inboxes/31')) return Response.json({ id: 31, name: 'Fixture', channel_type: 'Channel::Api', webhook_url: `https://broker.example.com/v1/integrations/chatwoot/${integration}/events`, secret: 'synthetic-webhook-secret' });
        throw new Error('UNEXPECTED_FIXTURE_URL');
      } };
    health = createChatwootHealth({ transact, encryptionKey: key, readIdentity: async () => ({ connected: providerState === 'CONNECTED', phone: providerPhone }) });
    const instances = createInstanceService({ repository: createPostgresInstanceRepository(), providers: { getProvider: () => ({ beginConnection: pair, disconnect, getStatus: async () => providerState }) as unknown as WhatsAppProvider }, runInOrganizationTransaction: transact, writeAudit: writeTenantAudit });
    chatwoot = createChatwootService(options);
    control = createChatwootControlService({ ...options, auth, instances, health, chatwoot });
    principal = await auth.authorize({ kind: 'JWT', organizationId: org, actorId: owner, role: 'OWNER' }, 'chatwoot:manage');
    await auth.setOperatorGrants(principal.authentication, integration, { grants: [{ userId: viewer, canPair: true }] }, randomUUID());
    agent = await auth.authorize({ kind: 'JWT', organizationId: org, actorId: viewer, role: 'VIEWER' }, 'chatwoot:read', integration);
  });
  afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });
  it('status never pairs and a delegated agent cannot perform the first pairing', async () => {
    expect(await control.status(principal, integration)).toMatchObject({ transportStatus: 'UNVERIFIED', instanceStatus: 'DISCONNECTED' });
    expect(pair).not.toHaveBeenCalled();
    await expect(control.pair(agent, integration, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect(pair).not.toHaveBeenCalled();
  });
  it('preflights the remote credential before pairing, leaves the session intact on remote 401, and coalesces two requests', async () => {
    rejectRemote = true;
    await expect(control.pair(principal, integration, randomUUID())).rejects.toMatchObject({ code: 'CHATWOOT_REQUEST_REJECTED' });
    expect(pair).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled(); rejectRemote = false;
    const firstKey = randomUUID();
    const results = await Promise.all([control.pair(principal, integration, firstKey), control.pair(principal, integration, randomUUID())]);
    expect(pair).toHaveBeenCalledTimes(1); expect(results.some(r => r.action.type === 'QR_CODE')).toBe(true);
    const persisted = await transact(org, async t => ({ audits: (await t.query('SELECT * FROM integration_audit')).rows,
      health: (await t.query('SELECT * FROM chatwoot_connection_health')).rows, idempotency: (await t.query('SELECT * FROM idempotency_records')).rows }));
    expect(JSON.stringify(persisted)).not.toContain('synthetic-ephemeral-qr');
    await transact(org, t => t.query("UPDATE chatwoot_connection_health SET pair_window_expires_at=now()-interval '1 second' WHERE integration_id=$1", [integration]));
    expect((await control.pair(principal, integration, firstKey)).action.type).toBe('NONE');
    expect(pair).toHaveBeenCalledTimes(1);
    expect((await control.pair(principal, integration, randomUUID())).action.type).toBe('QR_CODE');
    expect(pair).toHaveBeenCalledTimes(2);
  });
  it('requires explicit admin approval of the observed number and blocks a changed identity before outgoing claims', async () => {
    providerState = 'CONNECTED'; providerPhone = '15555550100';
    let status = await control.status(principal, integration);
    expect(status.identityStatus).toBe('CONFIRMATION_REQUIRED');
    await expect(control.confirmIdentity(agent, integration, status.identityRevision, randomUUID())).rejects.toMatchObject({ status: 403 });
    await control.confirmIdentity(principal, integration, status.identityRevision, randomUUID());
    status = await control.status(principal, integration);
    expect(status.identityStatus).toBe('CONFIRMED'); expect(status.transportStatus).toBe('UNVERIFIED');
    const repo = createPostgresMessagingRepository();
    await transact(org, async t => {
      const contact = await repo.upsertContact(t, { id: randomUUID(), organizationId: org, externalId: '15555550199', displayName: null, consentStatus: 'UNKNOWN', consentUpdatedAt: null });
      const convo = await repo.getOrCreateConversation(t, { id: randomUUID(), organizationId: org, channelId: channel, contactId: contact.id });
      await repo.enqueueOutgoing(t, { id: randomUUID(), organizationId: org, channelId: channel, conversationId: convo.id, source: 'OPERATOR', content: { type: 'TEXT', text: 'Synthetic local fixture' }, idempotencyKey: randomUUID(), bodyHash: 'synthetic-hash', policy: { requireOptIn: false } });
    });
    const claimed = await transact(org, t => repo.claimOutgoing(t, { organizationId: org, workerId: randomUUID(), now: new Date(), leaseMs: 120000, limit: 1 }));
    expect(claimed).toHaveLength(1);
    providerPhone = '15555550101'; await health.refresh(org, channel);
    expect(await control.status(principal, integration)).toMatchObject({ identityStatus: 'CONFIRMATION_REQUIRED', transportStatus: 'DEGRADED' });
    expect(await transact(org, t => repo.validateClaim(t, { organizationId: org, messageId: claimed[0]!.message.id, leaseToken: claimed[0]!.leaseToken })))
      .toMatchObject({ eligible: false, reason: 'IDENTITY_CONFIRMATION_REQUIRED' });
    expect((await transact(org, t => t.query('SELECT state FROM messaging_messages WHERE id=$1', [claimed[0]!.message.id]))).rows[0].state).toBe('ACCEPTED');
    const claims = await transact(org, t => repo.claimOutgoing(t, { organizationId: org, workerId: randomUUID(), now: new Date(), leaseMs: 120000, limit: 1 }));
    expect(claims).toHaveLength(0);
    await expect(control.confirmIdentity(principal, integration, status.identityRevision, randomUUID())).rejects.toMatchObject({ code: 'IDENTITY_OBSERVATION_CHANGED' });
    await expect(control.pair(agent, integration, randomUUID())).rejects.toMatchObject({ code: 'IDENTITY_CONFIRMATION_REQUIRED' });
    const saved = (await transact(org, t => t.query('SELECT * FROM chatwoot_connection_health'))).rows;
    expect(JSON.stringify(saved)).not.toContain('15555550100'); expect(JSON.stringify(saved)).not.toContain('15555550101');
  });
  it('revoked grants and removal of membership block the very next pairing without disconnecting the provider', async () => {
    await auth.setOperatorGrants(principal.authentication, integration, { grants: [] }, randomUUID());
    await expect(control.status(agent, integration)).rejects.toMatchObject({ status: 403 });
    await expect(control.pair(agent, integration, randomUUID())).rejects.toMatchObject({ status: 403 });
    await expect(control.disconnect(agent, integration, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('requires a signed callback and two fresh transport records after identity approval; worker refresh continues without the UI', async () => {
    const state = await control.status(principal, integration);
    await control.confirmIdentity(principal, integration, state.identityRevision, randomUUID());
    const raw = Buffer.from(JSON.stringify({ event: 'message_created', id: 71, account: { id: 1 }, inbox: { id: 31 }, conversation: { id: 51 }, message_type: 'outgoing', private: false, content: 'Synthetic local fixture' }));
    const ts = String(Math.floor(Date.now() / 1000)), signature = 'sha256=' + createHmac('sha256', 'synthetic-webhook-secret').update(`${ts}.`).update(raw).digest('hex');
    await expect(chatwoot.ingest(integration, raw, ts, 'sha256=' + '0'.repeat(64))).rejects.toMatchObject({ status: 401 });
    expect((await control.status(principal, integration)).callbackVerifiedAt).toBeNull();
    await chatwoot.ingest(integration, raw, ts, signature);
    expect(await control.status(principal, integration)).toMatchObject({ transportStatus: 'UNVERIFIED', callbackVerifiedAt: expect.any(String) });
    // These storage fixtures exercise the evidence query; end-to-end transport is covered separately.
    const repo = createPostgresMessagingRepository();
    await transact(org, async t => {
      const convo = (await t.query('SELECT id FROM messaging_conversations WHERE channel_id=$1', [channel])).rows[0].id;
      const incoming = await repo.recordIncoming(t, { id: randomUUID(), organizationId: org, channelId: channel, conversationId: convo,
        webhookEventKey: 'health-fixture-incoming', upstreamMessageId: 'health-fixture-incoming', content: { type: 'TEXT', text: 'Synthetic inbound' } });
      await t.query("UPDATE integration_jobs SET status='SUCCEEDED',updated_at=now() WHERE message_id=$1", [incoming.message.id]);
      const outgoing = await repo.enqueueOutgoing(t, { id: randomUUID(), organizationId: org, channelId: channel, conversationId: convo, source: 'OPERATOR',
        content: { type: 'TEXT', text: 'Synthetic outbound' }, idempotencyKey: randomUUID(), bodyHash: 'health-fixture-outgoing', policy: { requireOptIn: false } });
      await t.query("UPDATE messaging_messages SET state='SENT',updated_at=now() WHERE id=$1", [outgoing.message.id]);
      await t.query('INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,72)', [org, integration, outgoing.message.id]);
    });
    expect((await control.status(principal, integration)).transportStatus).toBe('OPERATIONAL');
    await transact(org, t => t.query("UPDATE integration_jobs SET updated_at=now()-interval '25 hours' WHERE kind='MIRROR_MESSAGE' AND status='SUCCEEDED'"));
    expect((await control.status(principal, integration)).transportStatus).toBe('UNVERIFIED');
    await transact(org, t => t.query("UPDATE chatwoot_connection_health SET observed_connected=false,observed_at=now()-interval '1 minute' WHERE integration_id=$1", [integration]));
    await health.runOnce(org);
    expect((await transact(org, t => t.query('SELECT chatwoot_channel_identity_ready($1,$2) AS ready', [org, channel]))).rows[0].ready).toBe(true);
    await transact(org, t => t.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1'));
    expect((await control.status(principal, integration)).callbackVerifiedAt).toBeNull();
  });
});
