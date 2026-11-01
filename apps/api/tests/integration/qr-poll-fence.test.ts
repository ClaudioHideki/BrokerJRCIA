import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeProviderAdapter, ProviderRegistry, type ProviderStatus } from '@jrc/providers';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { persistConnectionFact } from '../../src/modules/messaging/qr-connection-order.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const mutation = vi.hoisted(() => ({ bypassClockFence: false }));
vi.mock('../../src/modules/messaging/qr-connection-order.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/modules/messaging/qr-connection-order.js')>();
  return {
    ...original,
    isSameConnectionClock: (...args: Parameters<typeof original.isSameConnectionClock>) =>
      mutation.bypassClockFence || original.isSameConnectionClock(...args),
  };
});

const INITIAL_CLOCK = new Date('2030-01-01T00:00:00.000Z');
const NEXT_CLOCK = new Date('2030-01-01T00:00:01.000Z');
const INITIAL_UPDATED_AT = '2030-01-01T00:00:00.123100Z';
const NEXT_UPDATED_AT = '2030-01-01T00:00:00.123900Z';
const FIRST_BINDING = 'a'.repeat(64), NEXT_BINDING = 'b'.repeat(64);

describe('QR polling fence with PostgreSQL watermark and RLS', () => {
  let database: IsolatedPostgresDatabase, pool: Pool;
  let tenant: { organizationId: string; ownerId: string; accountId: string };
  let other: typeof tenant;
  const repository = createPostgresInstanceRepository();

  async function seedTenant(slug: string) {
    return runInAdminTransaction(database.pool, async (tx) => {
      const organization = await createOrganization(tx, { name: slug, slug });
      const owner = await createUser(tx, { email: `${slug}@example.test`, passwordHash: 'synthetic-test-hash' });
      await createOwnerMembership(tx, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(tx, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
  }

  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(database.connectionString));
    tenant = await seedTenant('qr-fence-a');
    other = await seedTenant('qr-fence-b');
    pool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
  }, 180_000);

  afterAll(async () => {
    mutation.bypassClockFence = false;
    await pool?.end();
    await database?.dispose();
  });

  async function insertInstance() {
    return withOrganizationTransaction(pool, tenant.organizationId, async (tx) => {
      const id = (await tx.query<{ id: string }>(`INSERT INTO instances
        (organization_id,provider_account_id,name,upstream_instance_key,status,updated_at,connection_observed_at,connection_binding_fingerprint)
        VALUES($1,$2,$3,$3,'CONNECTED',$4,$5,$6) RETURNING id`,
      [tenant.organizationId, tenant.accountId, `synthetic-${randomUUID()}`, INITIAL_UPDATED_AT, INITIAL_CLOCK, FIRST_BINDING])).rows[0]!.id;
      return id;
    });
  }

  async function race(changed: 'watermark' | 'binding' | 'unchanged') {
    const id = await insertInstance();
    const before = await withOrganizationTransaction(pool, tenant.organizationId,
      (tx) => repository.findById(tx, tenant.organizationId, id));
    expect(before).toMatchObject({ connectionObservedAt: INITIAL_CLOCK, connectionBindingFingerprint: FIRST_BINDING });
    const provider = new FakeProviderAdapter();
    let started!: () => void, release!: (state: ProviderStatus) => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    provider.getStatus = async () => {
      started();
      return new Promise<ProviderStatus>((resolve) => { release = resolve; });
    };
    const service = createInstanceService({
      repository, providers: new ProviderRegistry([provider], [['BAILEYS', provider]]), writeAudit: writeTenantAudit,
      runInOrganizationTransaction: (org, work) => withOrganizationTransaction(pool, org, work),
    });
    const pending = service.getInstanceStatus({ credentialKind: 'JWT', organizationId: tenant.organizationId,
      actorId: tenant.ownerId, requestId: randomUUID(), deadline: new Date(Date.now() + 30_000),
      signal: new AbortController().signal }, id);
    let result!: Awaited<typeof pending>;
    await upstreamStarted;
    try {
      if (changed !== 'unchanged') {
        await withOrganizationTransaction(pool, tenant.organizationId, async (tx) => {
          expect(await persistConnectionFact(tx, {
            organizationId: tenant.organizationId, instanceId: id, state: 'CONNECTED',
            observedAt: changed === 'watermark' ? NEXT_CLOCK : INITIAL_CLOCK,
            fingerprint: changed === 'binding' ? NEXT_BINDING : FIRST_BINDING,
          })).toBe(true);
          // Construct a deterministic microsecond collision rather than relying on machine speed.
          await tx.query('UPDATE instances SET updated_at=$3 WHERE organization_id=$1 AND id=$2',
            [tenant.organizationId, id, NEXT_UPDATED_AT]);
        });
        const during = await withOrganizationTransaction(pool, tenant.organizationId,
          (tx) => repository.findByIdForUpdate(tx, tenant.organizationId, id));
        expect(during!.status).toBe(before!.status);
        expect(during!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
        expect(during).toMatchObject({
          connectionObservedAt: changed === 'watermark' ? NEXT_CLOCK : INITIAL_CLOCK,
          connectionBindingFingerprint: changed === 'binding' ? NEXT_BINDING : FIRST_BINDING,
        });
        const exact = await withOrganizationTransaction(pool, tenant.organizationId,
          (tx) => tx.query<{ changed: boolean }>('SELECT updated_at<>$3::timestamptz AS changed FROM instances WHERE organization_id=$1 AND id=$2',
            [tenant.organizationId, id, INITIAL_UPDATED_AT]));
        expect(exact.rows[0]!.changed).toBe(true);
      }
    } finally {
      release('DISCONNECTED');
      result = await pending;
    }
    const persisted = await withOrganizationTransaction(pool, tenant.organizationId,
      (tx) => repository.findById(tx, tenant.organizationId, id));
    expect(persisted!.status).toBe(result.status);
    expect(persisted).toMatchObject({
      connectionObservedAt: changed === 'watermark' ? NEXT_CLOCK : INITIAL_CLOCK,
      connectionBindingFingerprint: changed === 'binding' ? NEXT_BINDING : FIRST_BINDING,
    });
    return result.status;
  }

  it.each(['watermark', 'binding'] as const)('rejects a stale poll after concurrent authenticated %s change', async (changed) => {
    expect(await race(changed)).toBe('CONNECTED');
  });

  it('accepts a poll whose captured source clock is unchanged', async () => {
    expect(await race('unchanged')).toBe('DISCONNECTED');
  });

  it('mutation control reproduces the stale overwrite when only the clock fence is bypassed', async () => {
    mutation.bypassClockFence = true;
    try {
      expect(await race('watermark')).toBe('DISCONNECTED');
    } finally {
      mutation.bypassClockFence = false;
    }
  });

  it('keeps direct app authority and tenant isolation on the persisted clock', async () => {
    const identity = await pool.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(identity.rows[0]).toMatchObject({ current_user: 'jrc_app', session_user: 'jrc_app', rolsuper: false, rolbypassrls: false });
    const policy = await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='instances'::regclass");
    expect(policy.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const id = await insertInstance();
    await withOrganizationTransaction(pool, other.organizationId, async (tx) => {
      expect(await repository.findByIdForUpdate(tx, other.organizationId, id)).toBeNull();
      expect(await persistConnectionFact(tx, { organizationId: other.organizationId, instanceId: id,
        state: 'DISCONNECTED', observedAt: NEXT_CLOCK, fingerprint: NEXT_BINDING })).toBe(false);
      expect((await tx.query('SELECT id FROM instances WHERE id=$1', [id])).rows).toEqual([]);
    });
    expect(await withOrganizationTransaction(pool, tenant.organizationId,
      (tx) => repository.findById(tx, tenant.organizationId, id))).toMatchObject({
      status: 'CONNECTED', connectionObservedAt: INITIAL_CLOCK, connectionBindingFingerprint: FIRST_BINDING,
    });
  });
});
