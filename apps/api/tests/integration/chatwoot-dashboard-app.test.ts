import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction, type OrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import { createEmbedService } from '../../src/modules/integrations/embed/authorization.js';
import { ChatwootClient, ChatwootError } from '../../src/modules/integrations/chatwoot-client.js';
import type { AuthenticationContext } from '../../src/http/plugins/authorization.js';
let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool;
let service: ReturnType<typeof createEmbedService>, owner: AuthenticationContext, agent: AuthenticationContext, outsider: AuthenticationContext, appId: string;
const remote = new ChatwootClient({ baseUrl: 'https://chatwoot.example.test', token: 'synthetic-never-network', fetch: vi.fn() });
const list = vi.spyOn(remote, 'listDashboardApps'), create = vi.spyOn(remote, 'createDashboardApp'), verify = vi.spyOn(remote, 'verifyAccount');
const transact = <T>(org: string, work: OrganizationTransaction<T>) => withOrganizationTransaction(pool, org, work);
const app = (url: string, id = 9) => ({ id, title: 'Any title', content: [{ type: 'frame', url }] });
beforeAll(async () => {
  const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
  await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
  pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
  authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
  [owner, agent, outsider] = await runInAdminTransaction(db.pool, async tx => {
    const org = (await createOrganization(tx, { name: 'Dashboard Lab', slug: 'dashboard-lab' })).id;
    const other = (await createOrganization(tx, { name: 'Other Lab', slug: 'other-lab' })).id;
    const actors: AuthenticationContext[] = [];
    for (const [organizationId, role] of [[org, 'OWNER'], [org, 'OPERATOR'], [other, 'OWNER']] as const) {
      const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${role.toLowerCase()}-${organizationId}@example.test`])).rows[0].id;
      await tx.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [organizationId, user, role]);
      actors.push({ kind: 'JWT', organizationId, actorId: user, role });
    }
    return actors;
  });
  await transact(owner.organizationId, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://chatwoot.example.test',1,'synthetic','READY')", [owner.organizationId]));
  const control = createChatwootControlAuth({ enabled: true, transact, managedOrigin: 'https://chatwoot.example.test', hmacSecret: 'synthetic-hmac-at-least-32-characters', resolveCurrentRole: createMessagingMembershipResolver(authPool) });
  service = createEmbedService({ enabled: true, pool, transact, control, managedOrigin: 'https://chatwoot.example.test', publicOrigin: 'https://broker.example.test', dashboardClient: () => remote,
    rateLimitStore: new MemoryRateLimitStore(), rateLimitSecret: 'synthetic-hmac-at-least-32-characters' });
  appId = (await service.apps.register(owner)).embedId;
});
beforeEach(async () => {
  list.mockReset().mockResolvedValue([]); verify.mockReset().mockResolvedValue();
  create.mockReset().mockImplementation(async (_account, payload) => app(payload.dashboard_app.content[0]!.url));
  await db.pool.query("UPDATE chatwoot_embed_apps SET install_state='UNCONFIGURED',install_lease=NULL,install_lease_until=NULL,remote_app_id=NULL");
});
afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });
it('reconciles the exact URL, does not duplicate on repetition, and recreates a deleted app', async () => {
  const meta = await service.apps.describe(owner, appId);
  list.mockResolvedValueOnce([app(meta.url + '?wrong=1')]);
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'INSTALLED', remoteAppId: 9 });
  list.mockResolvedValueOnce([app(meta.url)]);
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'INSTALLED' }); expect(create).toHaveBeenCalledTimes(1);
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'INSTALLED' }); expect(create).toHaveBeenCalledTimes(2);
});
it('preserves UNKNOWN across service restarts and never blindly repeats POST after a lost response', async () => {
  create.mockRejectedValueOnce(new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN', false, true));
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'UNKNOWN' });
  const restarted = createEmbedService(service.options);
  expect(await restarted.apps.install(owner, appId)).toMatchObject({ state: 'UNKNOWN' }); expect(create).toHaveBeenCalledOnce();
  const meta = await restarted.apps.describe(owner, appId); list.mockResolvedValueOnce([app(meta.url, 15)]);
  expect(await restarted.apps.install(owner, appId)).toMatchObject({ state: 'INSTALLED', remoteAppId: 15 }); expect(create).toHaveBeenCalledOnce();
});
it.each([403, 404])('offers manual setup on capability HTTP %i, without changing transport', async status => {
  list.mockRejectedValueOnce(new ChatwootError('CHATWOOT_REQUEST_REJECTED', false, false, status));
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'MANUAL', url: expect.stringContaining(`/embed/chatwoot/${appId}`) });
  expect(create).not.toHaveBeenCalled();
  expect((await db.pool.query('SELECT status FROM chatwoot_accounts')).rows[0].status).toBe('READY');
});
it('does not erase a previous uncertain create when permission to reconcile is lost', async () => {
  create.mockRejectedValueOnce(new ChatwootError('CHATWOOT_OUTCOME_UNKNOWN', false, true));
  await service.apps.install(owner, appId);
  list.mockRejectedValueOnce(new ChatwootError('CHATWOOT_REQUEST_REJECTED', false, false, 403));
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'UNKNOWN' });
  expect(await service.apps.install(owner, appId)).toMatchObject({ state: 'UNKNOWN' }); expect(create).toHaveBeenCalledOnce();
});
it('rejects non-admin, other tenant and changed credentials without a remote create', async () => {
  await expect(service.apps.install(agent, appId)).rejects.toMatchObject({ status: 403 });
  await expect(service.apps.describe(outsider, appId)).rejects.toBeDefined();
  verify.mockImplementationOnce(async () => { await db.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1'); });
  await expect(service.apps.install(owner, appId)).rejects.toBeDefined(); expect(create).not.toHaveBeenCalled();
});
it('serializes two replicas without holding a transaction during remote I/O', async () => {
  let finish!: () => void;
  verify.mockImplementationOnce(async () => {
    const txs = await db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='jrc_app' AND xact_start IS NOT NULL");
    expect(txs.rows).toEqual([]);
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const pending = service.apps.install(owner, appId); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await expect(createEmbedService(service.options).apps.install(owner, appId)).rejects.toMatchObject({ status: 409 });
  finish(); expect(await pending).toMatchObject({ state: 'INSTALLED' }); expect(create).toHaveBeenCalledOnce();
});
