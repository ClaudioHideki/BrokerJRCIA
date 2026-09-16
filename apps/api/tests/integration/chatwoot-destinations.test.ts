import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createChatwootDestinationService } from '../../src/modules/integrations/chatwoot-destination.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { PlatformService } from '../../src/modules/platform/service.js';
import { digest } from '../../src/modules/platform/crypto.js';

describe('Chatwoot destinations on isolated PostgreSQL', () => {
  let db: IsolatedPostgresDatabase, app: Pool, org: string, other: string;
  let service: ReturnType<typeof createChatwootDestinationService>;
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    db = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(db.connectionString));
    [org, other] = await runInAdminTransaction(db.pool, async tx => {
      const ids = [];
      for (const slug of ['dest-a', 'dest-b']) {
        const id = (await createOrganization(tx, { name: slug, slug })).id;
        const user = (await tx.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [`${slug}@example.test`, 'synthetic-hash'])).rows[0];
        await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user.id]);
        ids.push(id);
      }
      return ids as [string, string];
    });
    app = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_app') });
    service = createChatwootDestinationService({ enabled: true, managedOrigin: 'https://jrc.example.com',
      transact: (id, work) => withOrganizationTransaction(app, id, work) });
  });
  afterAll(async () => { await app?.end(); await db?.dispose(); });

  it('requires platform approval and blocks tenant reads/writes across organizations', async () => {
    const a = await service.request(org, { baseUrl: 'https://a.example.com', mode: 'EXTERNAL' });
    expect(a).toMatchObject({ organizationId: org, approvalStatus: 'PENDING', revision: 1 });
    await expect(withOrganizationTransaction(app, org, tx => tx.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1", [org])))
      .rejects.toMatchObject({ code: '42501' });
    expect((await withOrganizationTransaction(app, other, tx => tx.query('SELECT * FROM chatwoot_destinations WHERE organization_id=$1', [org]))).rowCount).toBe(0);
    expect((await withOrganizationTransaction(app, other, tx => tx.query("UPDATE chatwoot_destinations SET base_url='https://evil.example.com' WHERE organization_id=$1", [org]))).rowCount).toBe(0);
    await expect(service.request(other, { baseUrl: 'https://other.example.com', mode: 'MANAGED' })).rejects.toMatchObject({ code: 'INVALID_MANAGED_DESTINATION' });
  });
  it('keeps account IDs local to an origin and enforces account/destination consistency', async () => {
    await service.request(other, { baseUrl: 'https://b.example.com', mode: 'EXTERNAL' });
    for (const [id, origin] of [[org, 'https://a.example.com'], [other, 'https://b.example.com']]) {
      await withOrganizationTransaction(app, id!, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id,encrypted_token,status) VALUES($1,$2,1,'synthetic-ciphertext','READY')", [id, origin]));
    }
    await expect(withOrganizationTransaction(app, other, tx => tx.query("UPDATE chatwoot_accounts SET base_url='https://a.example.com' WHERE organization_id=$1", [other])))
      .rejects.toMatchObject({ code: '23505' });
    await expect(withOrganizationTransaction(app, other, tx => tx.query("UPDATE chatwoot_accounts SET base_url='https://missing.example.com' WHERE organization_id=$1", [other])))
      .rejects.toMatchObject({ code: '23503' });
  });
  it('requires current platform administrator, CSRF and the reviewed revision; audits approval', async () => {
    const platform = new Pool({ connectionString: connectionStringForRole(db.connectionString, 'jrc_platform') });
    const admin = new PlatformService(platform, Buffer.alloc(32, 5));
    try {
      for (const role of ['SUPER_ADMIN', 'SUPPORT']) {
        const user = (await db.pool.query("INSERT INTO platform_users(email,password_hash,role,mfa_seed) VALUES($1,'synthetic',$2,'synthetic') RETURNING id", [`${role.toLowerCase()}@example.test`, role])).rows[0];
        await db.pool.query("INSERT INTO platform_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic-csrf',now()+interval '5 minutes')", [digest(role), user.id]);
      }
      await expect(admin.approveChatwootDestination('SUPPORT', 'synthetic-csrf', 'Review external destination', org, { revision: 1, mediaOrigins: [] }))
        .rejects.toMatchObject({ statusCode: 403 });
      await expect(admin.approveChatwootDestination('SUPER_ADMIN', 'wrong', 'Review external destination', org, { revision: 1, mediaOrigins: [] }))
        .rejects.toMatchObject({ statusCode: 403 });
      await expect(admin.approveChatwootDestination('SUPER_ADMIN', 'synthetic-csrf', 'Review external destination', org, { revision: 2, mediaOrigins: [] }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await admin.approveChatwootDestination('SUPER_ADMIN', 'synthetic-csrf', 'Review external destination', org, { revision: 1, mediaOrigins: ['https://cdn.example.com'] }))
        .toMatchObject({ approvalStatus: 'APPROVED', mediaOrigins: ['https://cdn.example.com'] });
      expect((await db.pool.query("SELECT * FROM platform_audit_logs WHERE organization_id=$1 AND action='chatwoot-destination-approve'", [org])).rowCount).toBe(1);
    } finally { await platform.end(); }
  });
  it('invalidates approval and credentials atomically when an unused destination changes', async () => {
    const changed = await service.request(org, { baseUrl: 'https://next.example.com', mode: 'EXTERNAL' });
    expect(changed).toMatchObject({ approvalStatus: 'PENDING', revision: 2 });
    const account = (await withOrganizationTransaction(app, org, tx => tx.query('SELECT * FROM chatwoot_accounts WHERE organization_id=$1', [org]))).rows[0];
    expect(account).toMatchObject({ base_url: changed.baseUrl, encrypted_token: null, account_id: null, status: 'PENDING', credential_version: 2 });
    expect(await service.request(org, { baseUrl: changed.baseUrl, mode: 'EXTERNAL' })).toEqual(changed);
  });
  it('blocks replacement while a provisioning operation may have created remote resources', async () => {
    await withOrganizationTransaction(app, org, tx => tx.query("INSERT INTO chatwoot_provisioning(organization_id,state) VALUES($1,'UNKNOWN')", [org]));
    await expect(service.request(org, { baseUrl: 'https://another.example.com', mode: 'EXTERNAL' })).rejects.toMatchObject({ code: 'DESTINATION_IN_USE', status: 409 });
  });
  it('preserves legacy account creation without credentials or verification promotion', async () => {
    // A new organization, with no new destination request, follows the existing managed path.
    const id = await runInAdminTransaction(db.pool, async tx => {
      const created = (await createOrganization(tx, { name: 'Legacy', slug: 'dest-legacy' })).id;
      const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES('legacy@example.test','synthetic') RETURNING id")).rows[0];
      await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [created, user.id]);
      return created;
    });
    await withOrganizationTransaction(app, id, tx => tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url) VALUES($1,'https://jrc.example.com')", [id]));
    expect(await service.get(id)).toMatchObject({ mode: 'MANAGED', approvalStatus: 'APPROVED', baseUrl: 'https://jrc.example.com' });
    expect((await withOrganizationTransaction(app, id, tx => tx.query('SELECT * FROM chatwoot_accounts WHERE organization_id=$1', [id]))).rows[0])
      .toMatchObject({ encrypted_token: null, capabilities: {}, capabilities_verified_at: null });
  });
  it('allows only one owner when organizations bind the same remote account concurrently', async () => {
    const ids = await runInAdminTransaction(db.pool, async tx => {
      const created = [];
      for (const slug of ['destination-race-a', 'destination-race-b']) {
        const id = (await createOrganization(tx, { name: slug, slug })).id;
        const user = (await tx.query("INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id", [`${slug}@example.test`])).rows[0];
        await tx.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user.id]);
        created.push(id);
      }
      return created;
    });
    const outcomes = await Promise.allSettled(ids.map(id => withOrganizationTransaction(app, id, tx =>
      tx.query("INSERT INTO chatwoot_accounts(organization_id,base_url,account_id) VALUES($1,'https://race.example.com',1)", [id]))));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: '23505' } });
  });
});
