import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createOrganization } from '../../src/modules/organizations/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import {
  createMembership,
  createOwnerMembership,
  removeMembership,
  setMembershipRole,
  type MembershipRole,
} from '../../src/modules/memberships/repository.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import {
  connectionStringForRole,
  createRealMembershipService,
  resetTask7Tables,
} from './helpers/task7.js';

interface TenantFixture {
  organizationId: string;
  ownerAId: string;
  ownerBId: string;
  adminId: string;
  operatorId: string;
}

const REQUEST_ID = '74d560a5-cbd3-46c1-97b1-25ef21457745';

async function seedTenant(pool: Pool): Promise<TenantFixture> {
  return runInAdminTransaction(pool, async (transaction) => {
    const organization = await createOrganization(transaction, {
      name: 'Membership Tenant',
      slug: 'membership-tenant',
    });
    const ownerA = await createUser(transaction, {
      email: 'owner-a@example.test',
      passwordHash: '$argon2id$membership-test-hash',
    });
    const ownerB = await createUser(transaction, {
      email: 'owner-b@example.test',
      passwordHash: '$argon2id$membership-test-hash',
    });
    const admin = await createUser(transaction, {
      email: 'admin@example.test',
      passwordHash: '$argon2id$membership-test-hash',
    });
    const operator = await createUser(transaction, {
      email: 'operator@example.test',
      passwordHash: '$argon2id$membership-test-hash',
    });
    await createOwnerMembership(transaction, {
      organizationId: organization.id,
      userId: ownerA.id,
    });
    await createMembership(transaction, {
      organizationId: organization.id,
      userId: ownerB.id,
      role: 'OWNER',
    });
    await createMembership(transaction, {
      organizationId: organization.id,
      userId: admin.id,
      role: 'ADMIN',
    });
    await createMembership(transaction, {
      organizationId: organization.id,
      userId: operator.id,
      role: 'OPERATOR',
    });
    return {
      organizationId: organization.id,
      ownerAId: ownerA.id,
      ownerBId: ownerB.id,
      adminId: admin.id,
      operatorId: operator.id,
    };
  });
}

async function roleFor(pool: Pool, organizationId: string, userId: string) {
  const result = await pool.query<{ role: MembershipRole }>(
    'SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2',
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function activeOwnerCount(pool: Pool, organizationId: string): Promise<number> {
  const { count } = await oneRow<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM memberships
      WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
    [organizationId],
  );
  return count;
}

describe('invariante de OWNER e autorização de memberships', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let tenant: TenantFixture;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    appPool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
      max: 4,
    });
  });

  beforeEach(async () => {
    await resetTask7Tables(database.pool);
    tenant = await seedTenant(database.pool);
  });

  afterAll(async () => {
    await appPool.end();
    await database.dispose();
  });

  it('executa alterações reais pela role jrc_app com contexto tenant', async () => {
    const identity = await withOrganizationTransaction(
      appPool,
      tenant.organizationId,
      async (transaction) => {
        const result = await transaction.query<{ currentUser: string; organizationId: string }>(
          `SELECT current_user AS "currentUser",
                  current_setting('app.organization_id', true) AS "organizationId"`,
        );
        return result.rows[0];
      },
    );

    expect(identity).toEqual({
      currentUser: 'jrc_app',
      organizationId: tenant.organizationId,
    });
  });

  it('ADMIN não promove, remove ou rebaixa OWNER', async () => {
    const { changeMembership } = createRealMembershipService(appPool);
    const actor = { organizationId: tenant.organizationId, userId: tenant.adminId };

    await expect(changeMembership(actor, {
      type: 'SET_ROLE',
      userId: tenant.operatorId,
      role: 'OWNER',
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(changeMembership(actor, {
      type: 'SET_ROLE',
      userId: tenant.ownerAId,
      role: 'ADMIN',
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(changeMembership(actor, {
      type: 'REMOVE',
      userId: tenant.ownerAId,
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(await roleFor(database.pool, tenant.organizationId, tenant.ownerAId)).toBe('OWNER');
    expect(await roleFor(database.pool, tenant.organizationId, tenant.operatorId)).toBe('OPERATOR');
  });

  it('ADMIN gerencia papel não-OWNER sem assumir propriedade implicitamente', async () => {
    const { changeMembership } = createRealMembershipService(appPool);

    await changeMembership(
      { organizationId: tenant.organizationId, userId: tenant.adminId },
      {
        type: 'SET_ROLE',
        userId: tenant.operatorId,
        role: 'VIEWER',
        requestId: REQUEST_ID,
      },
    );

    expect(await roleFor(database.pool, tenant.organizationId, tenant.adminId)).toBe('ADMIN');
    expect(await roleFor(database.pool, tenant.organizationId, tenant.operatorId)).toBe('VIEWER');
    expect(await activeOwnerCount(database.pool, tenant.organizationId)).toBe(2);
  });

  it('somente OWNER pode alterar propriedade quando ainda resta outro OWNER', async () => {
    const { changeMembership } = createRealMembershipService(appPool);

    await changeMembership(
      { organizationId: tenant.organizationId, userId: tenant.ownerAId },
      {
        type: 'SET_ROLE',
        userId: tenant.ownerBId,
        role: 'ADMIN',
        requestId: REQUEST_ID,
      },
    );

    expect(await roleFor(database.pool, tenant.organizationId, tenant.ownerBId)).toBe('ADMIN');
    expect(await activeOwnerCount(database.pool, tenant.organizationId)).toBe(1);
  });

  it.each(['REMOVE', 'SET_ROLE'] as const)(
    'recusa %s sobre o último OWNER com erro LAST_OWNER',
    async (type) => {
      const { changeMembership } = createRealMembershipService(appPool);
      await changeMembership(
        { organizationId: tenant.organizationId, userId: tenant.ownerAId },
        {
          type: 'SET_ROLE',
          userId: tenant.ownerBId,
          role: 'ADMIN',
          requestId: REQUEST_ID,
        },
      );
      const command = type === 'REMOVE'
        ? { type, userId: tenant.ownerAId, requestId: REQUEST_ID }
        : { type, userId: tenant.ownerAId, role: 'ADMIN' as const, requestId: REQUEST_ID };

      await expect(changeMembership(
        { organizationId: tenant.organizationId, userId: tenant.ownerAId },
        command,
      )).rejects.toMatchObject({ code: 'LAST_OWNER' });
      expect(await roleFor(database.pool, tenant.organizationId, tenant.ownerAId)).toBe('OWNER');
      expect(await activeOwnerCount(database.pool, tenant.organizationId)).toBe(1);
    },
  );

  it('mantém um OWNER quando transações jrc_app concorrentes removem e rebaixam owners', async () => {
    let readyCount = 0;
    let releaseBoth!: () => void;
    const bothReady = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const awaitPeer = async () => {
      readyCount += 1;
      if (readyCount === 2) {
        releaseBoth();
      }
      await bothReady;
    };
    const removing = withOrganizationTransaction(
      appPool,
      tenant.organizationId,
      async (transaction) => {
        await removeMembership(transaction, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerAId,
        });
        await awaitPeer();
      },
    );
    const demoting = withOrganizationTransaction(
      appPool,
      tenant.organizationId,
      async (transaction) => {
        await setMembershipRole(transaction, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerBId,
          role: 'ADMIN',
        });
        await awaitPeer();
      },
    );

    const settled = await Promise.allSettled([removing, demoting]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: '23514' },
    });
    expect(await activeOwnerCount(database.pool, tenant.organizationId)).toBe(1);
  });

  it('não expõe canários em retorno ou auditoria de alteração de membership', async () => {
    const { changeMembership } = createRealMembershipService(appPool);
    const result = await changeMembership(
      { organizationId: tenant.organizationId, userId: tenant.adminId },
      {
        type: 'SET_ROLE',
        userId: tenant.operatorId,
        role: 'VIEWER',
        requestId: REQUEST_ID,
        password: 'membership-password-canary',
        passwordHash: '$argon2id$membership-hash-canary',
      } as never,
    );
    const audit = await oneRow<{ metadata: unknown }>(
      database.pool,
      `SELECT metadata FROM audit_logs
        WHERE organization_id = $1 AND event_type = 'MEMBERSHIP_CHANGED'`,
      [tenant.organizationId],
    );

    expect(result).toBeUndefined();
    expect(JSON.stringify(audit)).not.toContain('membership-password-canary');
    expect(JSON.stringify(audit)).not.toContain('membership-hash-canary');
  });
});
