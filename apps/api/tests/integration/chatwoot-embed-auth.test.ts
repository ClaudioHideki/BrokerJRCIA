import { Pool } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import { createEmbedService } from '../../src/modules/integrations/embed/authorization.js';
import type { AuthenticationContext } from '../../src/http/plugins/authorization.js';

let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool;
let service: ReturnType<typeof createEmbedService>, control: ReturnType<typeof createChatwootControlAuth>;
let owner: AuthenticationContext, agent: AuthenticationContext, outsider: AuthenticationContext, integration: string, otherIntegration: string, appId: string;
const transact = <T>(org: string, work: OrganizationTransaction<T>) => withOrganizationTransaction(pool, org, work);
const proof = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
beforeAll(async () => {
  const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
  pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
  authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
  const data = await runInAdminTransaction(db.pool, async tx => {
    const orgs = [];
    for (const label of ['embed-a', 'embed-b']) orgs.push((await createOrganization(tx, { name: label, slug: label })).id);
    const users = [];
    for (const [index, role] of [[0, 'OWNER'], [0, 'OPERATOR'], [1, 'OWNER']] as const) {
      const id = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${index}-${role.toLowerCase()}@example.test`])).rows[0].id;
      await tx.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [orgs[index], id, role]); users.push(id);
    }
    return { orgs, users };
  });
  owner = { kind: 'JWT', organizationId: data.orgs[0]!, actorId: data.users[0], role: 'OWNER' };
  agent = { kind: 'JWT', organizationId: data.orgs[0]!, actorId: data.users[1], role: 'OPERATOR' };
  outsider = { kind: 'JWT', organizationId: data.orgs[1]!, actorId: data.users[2], role: 'OWNER' };
  const ids = [];
  for (const org of data.orgs) ids.push(await transact(org, async tx => {
    await tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://managed.example.com',$2,'synthetic','READY')", [org, ids.length + 1]);
    const provider = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0].id;
    const instance = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Fixture',$3,'DISCONNECTED') RETURNING id", [org, provider, randomUUID()])).rows[0].id;
    const channel = await ensureQrChannel(tx, org, instance);
    const id = (await tx.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status,encrypted_webhook_secret) VALUES($1,$2,31,'Fixture','READY','synthetic') RETURNING id", [org, channel.id])).rows[0].id;
    await tx.query("INSERT INTO chatwoot_connection_health(organization_id,integration_id,channel_id,approved_fingerprint) VALUES($1,$2,$3,'synthetic-approved')", [org, id, channel.id]);
    return id;
  }));
  [integration, otherIntegration] = ids;
  control = createChatwootControlAuth({ enabled: true, transact, managedOrigin: 'https://managed.example.com', hmacSecret: 'synthetic-hmac-at-least-32-characters', resolveCurrentRole: createMessagingMembershipResolver(authPool) });
  service = createEmbedService({ enabled: true, pool, transact, control, managedOrigin: 'https://managed.example.com',
    rateLimitStore: new MemoryRateLimitStore(), rateLimitSecret: 'synthetic-hmac-at-least-32-characters' });
  appId = (await service.apps.register(owner)).embedId;
});
afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });

it('registers once per current destination and exposes only approved public origin', async () => {
  expect((await service.apps.register(owner)).embedId).toBe(appId);
  expect(await service.apps.policy(appId)).toEqual({ origin: 'https://managed.example.com' });
  await expect(service.apps.register(agent)).rejects.toMatchObject({ status: 403 });
  expect((await transact(outsider.organizationId, tx => tx.query('SELECT * FROM chatwoot_embed_apps'))).rows).toEqual([]);
  await expect(authPool.query('SELECT * FROM chatwoot_embed_sessions')).rejects.toMatchObject({ code: '42501' });
});

it('keeps an unapproved request pending and exchanges atomically exactly once', async () => {
  const p = proof(), started = await service.start(appId, p.challenge, '192.0.2.1');
  expect(await service.exchange(started.requestId, p.verifier)).toEqual({ status: 'PENDING' });
  await service.approve(owner, started.requestId, [integration]);
  await db.pool.query('UPDATE chatwoot_embed_authorizations SET next_exchange_at=NULL WHERE id=$1', [started.requestId]);
  const results = await Promise.allSettled([service.exchange(started.requestId, p.verifier), service.exchange(started.requestId, p.verifier)]);
  const successes = results.filter(r => r.status === 'fulfilled'); expect(successes).toHaveLength(1);
  const issued = (successes[0] as PromiseFulfilledResult<{ token: string; expiresAt: string }>).value;
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const rows = (await transact(owner.organizationId, tx => tx.query('SELECT * FROM chatwoot_embed_sessions'))).rows;
  expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain(issued.token);
  const principal = await service.sessions.authorize(issued.token, integration, 'chatwoot:pair');
  await expect(transact(owner.organizationId, tx => control.revalidate(tx, principal, 'chatwoot:disconnect', integration))).rejects.toMatchObject({ status: 403 });
  await expect(service.sessions.authorize(issued.token, otherIntegration, 'chatwoot:read')).rejects.toMatchObject({ status: 403 });
  await db.pool.query("UPDATE chatwoot_embed_sessions SET expires_at=now()-interval '1 second'");
  await expect(service.sessions.authorize(issued.token, integration, 'chatwoot:read')).rejects.toMatchObject({ status: 403 });
});

it('refuses wrong organization, wrong proof, denial, expiry and replay without issuing a session', async () => {
  const p = proof(), started = await service.start(appId, p.challenge, '192.0.2.2');
  await expect(service.approve(outsider, started.requestId, [otherIntegration])).rejects.toMatchObject({ status: 403 });
  await expect(service.approve(owner, started.requestId, [otherIntegration])).rejects.toMatchObject({ status: 404 });
  await expect(service.exchange(started.requestId, proof().verifier)).rejects.toMatchObject({ status: 403 });
  expect((await db.pool.query('SELECT failed_attempts FROM chatwoot_embed_authorizations WHERE id=$1', [started.requestId])).rows[0].failed_attempts).toBe(1);
  await service.deny(owner, started.requestId);
  await expect(service.exchange(started.requestId, p.verifier)).rejects.toMatchObject({ status: 403 });
  const expiring = await service.start(appId, p.challenge, '192.0.2.3');
  await db.pool.query("UPDATE chatwoot_embed_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1", [expiring.requestId]);
  await expect(service.approve(owner, expiring.requestId, [integration])).rejects.toMatchObject({ status: 403 });
});

it('bounds start and pending exchange attempts, including across service replicas', async () => {
  const replica = createEmbedService(service.options);
  const p = proof();
  for (let n = 0; n < 10; n++) await service.start(appId, p.challenge, '192.0.2.4');
  await expect(replica.start(appId, p.challenge, '192.0.2.4')).rejects.toMatchObject({ status: 429 });
  const started = await service.start(appId, p.challenge, '192.0.2.5');
  await service.exchange(started.requestId, p.verifier);
  await expect(replica.exchange(started.requestId, p.verifier)).rejects.toMatchObject({ status: 429 });
});

it('permanently denies a request after five failed proofs without issuing a session', async () => {
  const p = proof(), started = await service.start(appId, p.challenge, '192.0.2.7');
  await service.approve(owner, started.requestId, [integration]);
  for (let n = 0; n < 5; n++) {
    await db.pool.query('UPDATE chatwoot_embed_authorizations SET next_exchange_at=NULL WHERE id=$1', [started.requestId]);
    await expect(service.exchange(started.requestId, proof().verifier)).rejects.toMatchObject({ status: 403 });
  }
  await expect(service.exchange(started.requestId, p.verifier)).rejects.toMatchObject({ status: 403 });
  expect((await db.pool.query('SELECT state,failed_attempts FROM chatwoot_embed_authorizations WHERE id=$1', [started.requestId])).rows[0]).toEqual({ state: 'DENIED', failed_attempts: 5 });
  expect((await db.pool.query('SELECT id FROM chatwoot_embed_sessions WHERE authorization_id=$1', [started.requestId])).rows).toEqual([]);
});

it('cannot issue a session when authorization expires during permission checks', async () => {
  const p = proof(), started = await service.start(appId, p.challenge, '192.0.2.8');
  await service.approve(owner, started.requestId, [integration]);
  const original = service.approvedPrincipal.bind(service);
  const delayed = vi.spyOn(service, 'approvedPrincipal').mockImplementationOnce(async (tx, request) => {
    const principal = await original(tx, request);
    await tx.query("UPDATE chatwoot_embed_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [request.id]);
    return principal;
  });
  try { expect(await service.exchange(started.requestId, p.verifier).then(() => 200, error => error.status)).toBe(403); }
  finally { delayed.mockRestore(); }
  expect((await db.pool.query('SELECT id FROM chatwoot_embed_sessions WHERE authorization_id=$1', [started.requestId])).rows).toEqual([]);
});

it('rechecks grants, identity, credential rotation, destination and account status before each action', async () => {
  await control.setOperatorGrants(owner, integration, { grants: [{ userId: agent.actorId!, canPair: true }] }, randomUUID());
  const p = proof(), started = await service.start(appId, p.challenge, '192.0.2.6');
  await service.approve(agent, started.requestId, [integration]);
  const issued = await service.exchange(started.requestId, p.verifier);
  if (issued.status !== 'AUTHORIZED') throw new Error('Missing authorization');
  const principal = await service.sessions.authorize(issued.token, integration, 'chatwoot:pair');
  await control.setOperatorGrants(owner, integration, { grants: [] }, randomUUID());
  await expect(transact(owner.organizationId, tx => control.revalidate(tx, principal, 'chatwoot:pair', integration))).rejects.toMatchObject({ status: 403 });
  await control.setOperatorGrants(owner, integration, { grants: [{ userId: agent.actorId!, canPair: true }] }, randomUUID());
  for (const [table, column, changed, restored] of [
    ['chatwoot_connection_health', 'identity_revision', 2, 1],
    ['chatwoot_connection_health', 'approved_fingerprint', 'different-identity', 'synthetic-approved'],
    ['chatwoot_accounts', 'credential_version', 2, 1],
    ['chatwoot_destinations', 'revision', 2, 1],
    ['chatwoot_accounts', 'status', 'DISABLED', 'READY'],
  ]) {
    await db.pool.query(`UPDATE ${table} SET ${column}=$1 WHERE organization_id=$2`, [changed, owner.organizationId]);
    await expect(service.sessions.authorize(issued.token, integration, 'chatwoot:pair')).rejects.toBeDefined();
    await db.pool.query(`UPDATE ${table} SET ${column}=$1 WHERE organization_id=$2`, [restored, owner.organizationId]);
  }
  for (const statement of [
    { change: "UPDATE memberships SET status='DISABLED' WHERE user_id=$1", restore: "UPDATE memberships SET status='ACTIVE' WHERE user_id=$1", id: agent.actorId },
    { change: "UPDATE users SET status='DISABLED' WHERE id=$1", restore: "UPDATE users SET status='ACTIVE' WHERE id=$1", id: agent.actorId },
    { change: 'UPDATE chatwoot_embed_sessions SET revoked_at=now() WHERE authorization_id=$1', restore: 'UPDATE chatwoot_embed_sessions SET revoked_at=NULL WHERE authorization_id=$1', id: started.requestId },
    { change: 'UPDATE chatwoot_embed_apps SET active=false WHERE id=$1', restore: 'UPDATE chatwoot_embed_apps SET active=true WHERE id=$1', id: appId },
  ]) {
    await db.pool.query(statement.change, [statement.id]);
    try { await expect(service.sessions.authorize(issued.token, integration, 'chatwoot:pair')).rejects.toBeDefined(); }
    finally { await db.pool.query(statement.restore, [statement.id]); }
  }
  await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [owner.organizationId]);
  await expect(service.sessions.authorize(issued.token, integration, 'chatwoot:pair')).rejects.toBeDefined();
  await db.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1", [owner.organizationId]);
});
