import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { hashPassword } from '@jrc/security';
import { PlatformService } from '../../src/modules/platform/service.js';
import { registerPlatformRoutes } from '../../src/http/routes/platform.js';
import { runMigrations } from '../../src/db/migrate.js';
import { encryptSeed } from '../../src/modules/platform/crypto.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';

let db: IsolatedPostgresDatabase;
let pool: Pool;
let service: PlatformService;
let admin: Awaited<ReturnType<PlatformService['login']>>;
let support: typeof admin;
const companies: { id: string; name: string }[] = [];
const reason = 'Synthetic group lifecycle verification';

beforeAll(async () => {
  const url = requireTestDatabaseAdminUrl();
  db = await createIsolatedPostgresDatabase(url);
  await withGlobalRoleLock(url, () => runMigrations(db.connectionString));
  const runtime = new URL(db.connectionString); runtime.username = 'jrc_platform';
  pool = new Pool({ connectionString: runtime.toString() });
  const key = Buffer.alloc(32, 5);
  service = new PlatformService(pool, key, { mode: 'password', origin: 'https://console.example.test' });
  for (const [email, role] of [['groups-admin@example.test', 'SUPER_ADMIN'], ['groups-support@example.test', 'SUPPORT']]) {
    await db.pool.query('INSERT INTO platform_users(email,password_hash,role,mfa_seed) VALUES($1,$2,$3,$4)',
      [email, await hashPassword('synthetic-groups-password'), role, encryptSeed(Buffer.alloc(20, 7), key)]);
  }
  admin = await service.login('groups-admin@example.test', 'synthetic-groups-password', '', '127.0.0.1');
  support = await service.login('groups-support@example.test', 'synthetic-groups-password', '', '127.0.0.2');
  for (const [index, name] of ['GoPure sintética', 'Operadora sintética', 'Construtora sintética'].entries()) {
    const created = await service.execute(admin.token, reason, 'create', undefined, {
      name, slug: `groups-fixture-${index}`, ownerEmail: `groups-owner-${index}@example.test`, ownerPassword: 'synthetic-owner-password',
    }) as { organization: { id: string } };
    companies.push({ id: created.organization.id, name });
  }
});
afterAll(async () => { await pool?.end(); await db?.dispose(); });

it('renames and removes only the grouping after an explicit preview, preserving every company and membership', async () => {
  const group = await service.createGroup(admin.token, reason, { name: 'Grupo JRC sintético' });
  await service.assignGroupOrganizations(admin.token, reason, group.id, { revision: 1, organizationIds: companies.map(c => c.id) });
  const memberships = (await db.pool.query('SELECT * FROM memberships ORDER BY organization_id,user_id')).rows;
  const organizations = (await db.pool.query('SELECT * FROM organizations ORDER BY id')).rows;
  const providers = (await db.pool.query('SELECT * FROM provider_accounts ORDER BY id')).rows;
  const renamed = await service.updateEconomicGroup(admin.token, reason, group.id, { name: 'Grupo JRC reorganizado', expectedRevision: 2 });
  expect(renamed).toMatchObject({ id: group.id, name: 'Grupo JRC reorganizado', revision: 3 });
  expect(new Set(renamed.organizationIds)).toEqual(new Set(companies.map(c => c.id)));
  const preview = await service.previewEconomicGroupRemoval(admin.token, reason, group.id);
  expect(preview).toMatchObject({ id: group.id, revision: 3, organizations: expect.arrayContaining(companies) });
  await expect(service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 3, detachCompanies: false }))
    .rejects.toMatchObject({ statusCode: 409, code: 'GROUP_DETACH_CONFIRMATION_REQUIRED' });
  await expect(service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 2, detachCompanies: true }))
    .rejects.toMatchObject({ statusCode: 409, code: 'GROUP_REVISION_CHANGED' });
  expect(await service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 3, detachCompanies: true }))
    .toEqual({ removed: true, preservedOrganizationIds: expect.arrayContaining(companies.map(c => c.id)) });
  expect((await db.pool.query('SELECT * FROM economic_groups WHERE id=$1', [group.id])).rowCount).toBe(0);
  expect((await db.pool.query('SELECT * FROM organizations ORDER BY id')).rows).toEqual(organizations);
  expect((await db.pool.query('SELECT * FROM memberships ORDER BY organization_id,user_id')).rows).toEqual(memberships);
  expect((await db.pool.query('SELECT * FROM provider_accounts ORDER BY id')).rows).toEqual(providers);
  expect((await db.pool.query("SELECT action FROM platform_audit_logs WHERE action LIKE 'economic-group-%:' || $1", [group.id])).rows)
    .toEqual(expect.arrayContaining([{ action: `economic-group-update:${group.id}` }, { action: `economic-group-remove:${group.id}` }]));
});

it('removes an empty group and serializes removal against a newer association', async () => {
  const group = await service.createGroup(admin.token, reason, { name: 'Concurrent group' });
  const preview = await service.previewEconomicGroupRemoval(admin.token, reason, group.id);
  const outcomes = await Promise.allSettled([
    service.assignGroupOrganizations(admin.token, reason, group.id, { revision: preview.revision, organizationIds: [companies[0]!.id] }),
    service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: preview.revision, detachCompanies: false }),
  ]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const remaining = (await db.pool.query('SELECT revision FROM economic_groups WHERE id=$1', [group.id])).rows[0];
  if (remaining) {
    expect(remaining.revision).toBe(2);
    expect((await db.pool.query('SELECT organization_id FROM economic_group_organizations WHERE group_id=$1', [group.id])).rows)
      .toEqual([{ organization_id: companies[0]!.id }]);
    await service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 2, detachCompanies: true });
  }
  const empty = await service.createGroup(admin.token, reason, { name: 'Empty group' });
  await expect(service.removeEconomicGroup(admin.token, reason, empty.id, { expectedRevision: 1, detachCompanies: false }))
    .resolves.toEqual({ removed: true, preservedOrganizationIds: [] });
});

it('denies SUPPORT mutations and rechecks role changes on an open session', async () => {
  const group = await service.createGroup(admin.token, reason, { name: 'Protected group' });
  await expect(service.updateEconomicGroup(support.token, reason, group.id, { name: 'Denied', expectedRevision: 1 })).rejects.toMatchObject({ statusCode: 403 });
  await expect(service.removeEconomicGroup(support.token, reason, group.id, { expectedRevision: 1, detachCompanies: false })).rejects.toMatchObject({ statusCode: 403 });
  await db.pool.query("UPDATE platform_users SET role='SUPPORT' WHERE id=$1", [admin.user.id]);
  try {
    await expect(service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 1, detachCompanies: false })).rejects.toMatchObject({ statusCode: 403 });
  } finally { await db.pool.query("UPDATE platform_users SET role='SUPER_ADMIN' WHERE id=$1", [admin.user.id]); }
  await service.removeEconomicGroup(admin.token, reason, group.id, { expectedRevision: 1, detachCompanies: false });
});

it('moves a company by explicit ungrouping without changing its identity and rolls back removal if auditing fails', async () => {
  const source = await service.createGroup(admin.token, reason, { name: 'Source group' });
  const target = await service.createGroup(admin.token, reason, { name: 'Target group' });
  const id = companies[1]!.id;
  await service.assignGroupOrganizations(admin.token, reason, source.id, { revision: 1, organizationIds: [id] });
  await expect(service.assignGroupOrganizations(admin.token, reason, target.id, { revision: 1, organizationIds: [id] }))
    .rejects.toMatchObject({ code: 'ORGANIZATION_ALREADY_GROUPED' });
  await service.assignGroupOrganizations(admin.token, reason, source.id, { revision: 2, organizationIds: [] });
  await service.assignGroupOrganizations(admin.token, reason, target.id, { revision: 1, organizationIds: [id] });
  await db.pool.query("CREATE FUNCTION fail_group_removal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'economic-group-remove:%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_group_removal_audit BEFORE INSERT ON platform_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_group_removal_audit()");
  try {
    await expect(service.removeEconomicGroup(admin.token, reason, target.id, { expectedRevision: 2, detachCompanies: true })).rejects.toThrow('synthetic audit failure');
    expect((await db.pool.query('SELECT group_id FROM economic_group_organizations WHERE organization_id=$1', [id])).rows).toEqual([{ group_id: target.id }]);
    expect((await db.pool.query('SELECT name FROM organizations WHERE id=$1', [id])).rows).toEqual([{ name: companies[1]!.name }]);
  } finally { await db.pool.query('DROP TRIGGER fail_group_removal_audit ON platform_audit_logs; DROP FUNCTION fail_group_removal_audit()'); }
  await service.removeEconomicGroup(admin.token, reason, target.id, { expectedRevision: 2, detachCompanies: true });
  await service.removeEconomicGroup(admin.token, reason, source.id, { expectedRevision: 3, detachCompanies: false });
});

it('serves the preview and requires origin, CSRF, revision and an explicit detach decision for removal', async () => {
  const app = Fastify();
  await registerPlatformRoutes(app, { service, origin: 'https://console.example.test', secureCookies: true });
  const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: { origin: 'https://console.example.test' },
    payload: { email: 'groups-admin@example.test', password: 'synthetic-groups-password' } });
  expect(login.statusCode).toBe(200);
  const headers = { cookie: login.headers['set-cookie'] as string, origin: 'https://console.example.test', 'x-csrf-token': login.json().csrfToken, 'x-platform-reason': reason };
  const group = await service.createGroup(admin.token, reason, { name: 'HTTP group' });
  try {
    expect((await app.inject({ url: `/v1/platform/groups/${group.id}/removal-preview`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/v1/platform/groups/${group.id}`, headers, payload: { name: 'Renamed HTTP group', expectedRevision: 1 } })).json()).toMatchObject({ revision: 2 });
    const payload = { expectedRevision: 2, detachCompanies: false };
    expect((await app.inject({ method: 'DELETE', url: `/v1/platform/groups/${group.id}`, headers: { ...headers, 'x-csrf-token': '' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/v1/platform/groups/${group.id}`, headers: { ...headers, origin: 'https://other.example.test' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/v1/platform/groups/${group.id}`, headers, payload: { expectedRevision: 2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/v1/platform/groups/${group.id}`, headers, payload })).json()).toEqual({ removed: true, preservedOrganizationIds: [] });
  } finally { await app.close(); }
});
