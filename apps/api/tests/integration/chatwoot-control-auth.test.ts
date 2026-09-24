import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createApiKeyService } from '../../src/modules/api-keys/service.js';
import { createPostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createMessagingMembershipResolver } from '../../src/modules/messaging/membership.js';
import { ensureQrChannel } from '../../src/modules/messaging/qr-service.js';
import type { AuthenticationContext } from '../../src/http/plugins/authorization.js';
import { IssueApiKeyRequestSchema } from '@jrc/contracts';

describe('scoped Chatwoot control credentials in PostgreSQL', () => {
  let db: IsolatedPostgresDatabase, pool: Pool, authPool: Pool, org: string, other: string, owner: string, viewer: string, outsider: string, integration: string;
  let control: ReturnType<typeof createChatwootControlAuth>, keys: ReturnType<typeof createApiKeyService>;
  let issued: Awaited<ReturnType<typeof control.issueCredential>>, jwt: AuthenticationContext, key: AuthenticationContext;
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl(); db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    [org, other, owner, viewer, outsider] = await runInAdminTransaction(db.pool, async tx => {
      const a = (await createOrganization(tx, { name: 'Control A', slug: 'control-a' })).id;
      const b = (await createOrganization(tx, { name: 'Control B', slug: 'control-b' })).id;
      const users: string[] = [];
      for (const [label, organizationId, role] of [['owner', a, 'OWNER'], ['viewer', a, 'VIEWER'], ['outsider', b, 'OWNER']]) {
        const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${label}@example.test`])).rows[0];
        await tx.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [organizationId, user.id, role]); users.push(user.id);
      }
      return [a, b, ...users] as [string, string, string, string, string];
    });
    pool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    authPool = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_auth') });
    const transact = <T>(id: string, work: Parameters<typeof withOrganizationTransaction<T>>[2]) => withOrganizationTransaction(pool, id, work);
    control = createChatwootControlAuth({ enabled: true, hmacSecret: 'synthetic-hmac-at-least-32-characters', managedOrigin: 'https://managed.example.com',
      transact, resolveCurrentRole: createMessagingMembershipResolver(authPool) });
    keys = createApiKeyService({ repository: createPostgresApiKeyRepository(), hmacSecret: 'synthetic-hmac-at-least-32-characters', runInOrganizationTransaction: transact, writeAudit: writeTenantAudit });
    for (const [id, account] of [[org, 1], [other, 2]] as const) await transact(id, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,'https://managed.example.com',$2,'synthetic-cipher','READY')", [id, account]));
    integration = await transact(org, async tx => {
      const p = (await tx.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Fixture') RETURNING id", [org])).rows[0];
      const i = (await tx.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Fixture','synthetic-control-instance','CONNECTED') RETURNING id", [org, p.id])).rows[0];
      const channel = await ensureQrChannel(tx, org, i.id);
      return (await tx.query("INSERT INTO chatwoot_connections(organization_id,channel_id,inbox_id,name,status) VALUES($1,$2,31,'Fixture','READY') RETURNING id", [org, channel.id])).rows[0].id;
    });
    jwt = { kind: 'JWT', organizationId: org, actorId: owner, role: 'OWNER' };
  });
  afterAll(async () => { await pool?.end(); await authPool?.end(); await db?.dispose(); });
  const input = { name: 'Rails scoped key', scopes: ['chatwoot:read', 'chatwoot:pair'] as ('chatwoot:read' | 'chatwoot:pair')[], expiresAt: null };
  it('offers only tenant QR resources to current administrators, never generic provider credentials', async () => {
    const resources = await control.resources(jwt);
    expect(resources.providers).toEqual([{ id: expect.any(String), name: 'Fixture' }]);
    expect(resources.instances).toEqual([]); // The existing instance already has an inbox.
    expect(resources.connections).toEqual([{ integrationId: integration, inboxId: 31, instanceId: expect.any(String), name: 'Fixture' }]);
    expect(await control.resources({ ...jwt, organizationId: other, actorId: outsider })).toEqual({ providers: [], instances: [], connections: [] });
    await expect(control.resources({ ...jwt, actorId: viewer, role: 'OWNER' })).rejects.toMatchObject({ status: 403 });
  });
  it('issues only from a current owner/admin, persists HMAC and binding atomically, never replays the secret', async () => {
    await expect(control.issueCredential({ ...jwt, kind: 'JWT', actorId: viewer, role: 'OWNER' }, input, 'issue-fixture-001')).rejects.toMatchObject({ status: 403 });
    issued = await control.issueCredential(jwt, input, 'issue-fixture-001');
    expect(issued.binding).toEqual({ organizationId: org, accountId: 1, destinationRevision: 1 });
    const authenticated = await keys.authenticateApiKey(issued.secret); expect(authenticated?.apiKeyId).toBe(issued.id);
    key = { kind: 'API_KEY', organizationId: org, actorId: null, apiKeyId: issued.id, scopes: issued.scopes };
    await expect(control.resources(key)).rejects.toMatchObject({ status: 403 });
    const saved = await withOrganizationTransaction(pool, org, tx => tx.query('SELECT * FROM api_keys WHERE organization_id=$1', [org]));
    expect(JSON.stringify(saved.rows)).not.toContain(issued.secret); expect(saved.rows[0].key_hmac).toBeTruthy();
    await expect(control.issueCredential(jwt, input, 'issue-fixture-001')).rejects.toMatchObject({ code: 'CONTROL_CREDENTIAL_ALREADY_ISSUED' });
    await expect(control.issueCredential(jwt, { ...input, name: 'Different' }, 'issue-fixture-001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(IssueApiKeyRequestSchema.safeParse(input).success).toBe(false);
    expect(await keys.authenticateApiKey('chatwoot-application-token')).toBeNull();
  });
  it('enforces scopes from storage and exact current account/revision instead of claimed values', async () => {
    expect(await control.context(key)).toMatchObject({ organizationId: org, accountId: 1 });
    await expect(control.authorize({ ...key, kind: 'API_KEY', actorId: null, apiKeyId: issued.id, scopes: ['chatwoot:manage'] }, 'chatwoot:manage')).rejects.toMatchObject({ status: 403 });
    for (const column of ['account_id', 'destination_revision']) {
      await withOrganizationTransaction(pool, org, tx => tx.query(`UPDATE chatwoot_control_bindings SET ${column}=99 WHERE api_key_id=$1`, [issued.id]));
      await expect(control.context(key)).rejects.toMatchObject({ status: 403 });
      await withOrganizationTransaction(pool, org, tx => tx.query(`UPDATE chatwoot_control_bindings SET ${column}=1 WHERE api_key_id=$1`, [issued.id]));
    }
    await expect(control.context({ ...key, organizationId: other })).rejects.toMatchObject({ status: 403 });
  });
  it('requires explicit grants for viewers, rechecks membership and revocation, and keeps admin-only actions restricted', async () => {
    const principal: AuthenticationContext = { kind: 'JWT', organizationId: org, actorId: viewer, role: 'OWNER' };
    await expect(control.authorize(principal, 'chatwoot:pair', integration)).rejects.toMatchObject({ status: 403 });
    await expect(control.setOperatorGrants(jwt, integration, { grants: [{ userId: outsider, canPair: true }] }, 'grant-other-user')).rejects.toMatchObject({ status: 403 });
    await control.setOperatorGrants(jwt, integration, { grants: [{ userId: viewer, canPair: true }] }, 'grant-viewer-user');
    expect(await control.authorize(principal, 'chatwoot:pair', integration)).toMatchObject({ accountId: 1 });
    await expect(control.authorize(principal, 'chatwoot:disconnect', integration)).rejects.toMatchObject({ status: 403 });
    await withOrganizationTransaction(pool, org, tx => tx.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2", [org, viewer]));
    await expect(control.authorize(principal, 'chatwoot:pair', integration)).rejects.toMatchObject({ status: 403 });
    await withOrganizationTransaction(pool, org, tx => tx.query("UPDATE memberships SET status='ACTIVE' WHERE organization_id=$1 AND user_id=$2", [org, viewer]));
    await control.setOperatorGrants(jwt, integration, { grants: [] }, 'revoke-viewer-user');
    await expect(control.authorize(principal, 'chatwoot:pair', integration)).rejects.toMatchObject({ status: 403 });
  });
  it('separates service actor from attributed remote user and denies suspended organizations', async () => {
    const principal = await control.authorize(key, 'chatwoot:pair', integration, '42');
    const delegate = control.delegate(principal, { requestId: randomUUID(), deadline: new Date(Date.now() + 10000), signal: new AbortController().signal }, integration);
    if (delegate.credentialKind !== 'CHATWOOT_CONTROL') throw new Error('Wrong delegation kind');
    await expect(withOrganizationTransaction(pool, org, tx => delegate.authorize(tx, 'pair', randomUUID()))).rejects.toMatchObject({ status: 403 });
    const instance = (await withOrganizationTransaction(pool, org, tx => tx.query('SELECT id FROM instances WHERE organization_id=$1', [org]))).rows[0].id;
    await withOrganizationTransaction(pool, org, tx => delegate.authorize(tx, 'pair', instance));
    await expect(withOrganizationTransaction(pool, org, tx => delegate.authorize(tx, 'disconnect', instance))).rejects.toMatchObject({ status: 403 });
    const audit = (await withOrganizationTransaction(pool, org, tx => tx.query("SELECT * FROM integration_audit WHERE action='CONTROL_PAIR_REQUESTED'"))).rows[0];
    expect(audit).toMatchObject({ actor_id: null, actor_api_key_id: issued.id, external_actor_id: '42' });
    expect(JSON.stringify(audit)).not.toContain(issued.secret);
    await db.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [org]);
    await expect(control.context(key)).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_ACTIVE' });
    await db.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1", [org]);
  });
  it('enforces cross-tenant RLS/FKs and atomically disables the binding on existing key revocation', async () => {
    expect((await withOrganizationTransaction(pool, other, tx => tx.query('SELECT * FROM chatwoot_control_bindings'))).rowCount).toBe(0);
    await expect(withOrganizationTransaction(pool, other, tx => tx.query(`INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,2,1)`, [issued.id, org]))).rejects.toMatchObject({ code: '42501' });
    const otherKey = await keys.issueApiKey({ credentialKind: 'JWT', organizationId: other, actorId: outsider, requestId: randomUUID() }, { name: 'Other key', scopes: ['instances:read'], expiresAt: null });
    await expect(withOrganizationTransaction(pool, org, tx => tx.query(`INSERT INTO chatwoot_control_bindings(api_key_id,organization_id,account_id,destination_revision) VALUES($1,$2,1,1)`, [otherKey.id, org]))).rejects.toMatchObject({ code: '23503' });
    expect(await keys.revokeApiKey({ credentialKind: 'JWT', organizationId: org, actorId: owner, requestId: randomUUID() }, issued.id)).toBe(true);
    expect((await withOrganizationTransaction(pool, org, tx => tx.query('SELECT active FROM chatwoot_control_bindings WHERE api_key_id=$1', [issued.id]))).rows[0].active).toBe(false);
    expect(await keys.authenticateApiKey(issued.secret)).toBeNull();
    await expect(control.context(key)).rejects.toMatchObject({ status: 403 });
  });
});
