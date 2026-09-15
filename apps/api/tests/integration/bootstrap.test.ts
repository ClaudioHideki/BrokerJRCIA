import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createBootstrapFirstTenant } from '../../src/modules/organizations/bootstrap.js';
import { runInAdminTransaction, type AdminTransaction } from '../../src/modules/organizations/repository.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import {
  bootstrapDependencies,
  createRealBootstrap,
  injectFailureAfterRealCall,
  resetTask7Tables,
} from './helpers/task7.js';

type FailurePoint =
  | 'hashPassword'
  | 'createOrganization'
  | 'createUser'
  | 'createOwnerMembership'
  | 'ensureLogicalBaileysAccount'
  | 'writeSecurityAudit';

const REQUEST_ID = '5784eceb-e235-43ce-969d-50c52cf561c0';

function input(overrides: Partial<{
  organizationName: string;
  organizationSlug: string;
  email: string;
  password: string;
}> = {}) {
  return {
    organizationName: 'JRC',
    organizationSlug: 'jrc',
    email: ' Owner@Example.test ',
    password: 'bootstrap-password-canary',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

async function counts(pool: Pool) {
  return oneRow<{
    organizations: number;
    users: number;
    owners: number;
    baileysProviderAccounts: number;
    securityAudits: number;
  }>(
    pool,
    `SELECT
       (SELECT count(*)::int FROM organizations) AS organizations,
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM memberships
         WHERE role = 'OWNER' AND status = 'ACTIVE') AS owners,
       (SELECT count(*)::int FROM provider_accounts
         WHERE provider = 'BAILEYS') AS "baileysProviderAccounts",
       (SELECT count(*)::int FROM security_audit_logs) AS "securityAudits"`,
  );
}

describe('bootstrap administrativo com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
  });

  beforeEach(async () => {
    await resetTask7Tables(database.pool);
  });

  afterAll(async () => {
    await database.dispose();
  });

  it('executa o boundary administrativo como jrc_migrator', async () => {
    const currentUser = await runInAdminTransaction(database.pool, async (transaction) => {
      const result = await transaction.query<{ currentUser: string }>(
        'SELECT current_user AS "currentUser"',
      );
      return result.rows[0]?.currentUser;
    });

    expect(currentUser).toBe('jrc_migrator');
  });

  it('cria atomicamente uma organização, usuário, OWNER e exatamente um BAILEYS', async () => {
    const bootstrapFirstTenant = createRealBootstrap(database.pool);

    const result = await bootstrapFirstTenant(input());

    expect(await counts(database.pool)).toEqual({
      organizations: 1,
      users: 1,
      owners: 1,
      baileysProviderAccounts: 1,
      securityAudits: 1,
    });
    const persisted = await oneRow<{
      email: string;
      passwordHash: string;
      externalReference: string | null;
      credentialReference: string | null;
      eventType: string;
      metadata: unknown;
    }>(
      database.pool,
      `SELECT u.email, u.password_hash AS "passwordHash",
              pa.external_reference AS "externalReference",
              pa.credential_reference AS "credentialReference",
              sal.event_type AS "eventType", sal.metadata
         FROM users u
         CROSS JOIN provider_accounts pa
         CROSS JOIN security_audit_logs sal`,
    );
    expect(persisted).toMatchObject({
      email: 'owner@example.test',
      externalReference: null,
      credentialReference: null,
      eventType: 'BOOTSTRAP_COMPLETED',
      metadata: {},
    });
    expect(persisted.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify({ result, audit: persisted.metadata })).not.toContain(
      'bootstrap-password-canary',
    );

    await expect(bootstrapFirstTenant(input({
      organizationName: 'Second',
      organizationSlug: 'second',
      email: 'second@example.test',
    }))).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
    expect(await counts(database.pool)).toMatchObject({
      organizations: 1,
      users: 1,
      owners: 1,
      baileysProviderAccounts: 1,
      securityAudits: 1,
    });
  });

  it.each<FailurePoint>([
    'hashPassword',
    'createOrganization',
    'createUser',
    'createOwnerMembership',
    'ensureLogicalBaileysAccount',
    'writeSecurityAudit',
  ])('desfaz efeitos dos repositórios reais quando falha após %s', async (failurePoint) => {
    const dependencies = injectFailureAfterRealCall(
      bootstrapDependencies(database.pool),
      failurePoint,
    );
    const bootstrapFirstTenant = createBootstrapFirstTenant(dependencies);

    await expect(bootstrapFirstTenant(input())).rejects.toMatchObject({
      code: 'INJECTED_FAILURE',
    });
    expect(await counts(database.pool)).toEqual({
      organizations: 0,
      users: 0,
      owners: 0,
      baileysProviderAccounts: 0,
      securityAudits: 0,
    });
  });

  it('serializa duas execuções concorrentes pelo advisory lock real', async () => {
    let lockAttempts = 0;
    let signalSecondAttempt!: () => void;
    const secondLockAttempted = new Promise<void>((resolve) => {
      signalSecondAttempt = resolve;
    });
    const base = bootstrapDependencies(database.pool);
    const bootstrapFirstTenant = createBootstrapFirstTenant({
      ...base,
      acquireBootstrapLock: async (transaction: AdminTransaction) => {
        lockAttempts += 1;
        if (lockAttempts === 2) {
          signalSecondAttempt();
        }
        await base.acquireBootstrapLock(transaction);
      },
      countOrganizations: async (transaction: AdminTransaction) => {
        if (lockAttempts === 1) {
          await secondLockAttempted;
        }
        return base.countOrganizations(transaction);
      },
    });

    const settled = await Promise.allSettled([
      bootstrapFirstTenant(input()),
      bootstrapFirstTenant(input({
        organizationName: 'Concurrent',
        organizationSlug: 'concurrent',
        email: 'concurrent@example.test',
      })),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'BOOTSTRAP_ALREADY_COMPLETED' },
    });
    expect(await counts(database.pool)).toEqual({
      organizations: 1,
      users: 1,
      owners: 1,
      baileysProviderAccounts: 1,
      securityAudits: 1,
    });
  });
});
