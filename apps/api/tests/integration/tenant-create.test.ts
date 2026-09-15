import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createTenantCreator } from '../../src/modules/organizations/tenant-create.js';
import { runInAdminTransaction, type AdminTransaction } from '../../src/modules/organizations/repository.js';
import { createUser, setUserStatus } from '../../src/modules/users/repository.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import {
  ADMIN_CREDENTIAL,
  createRealBootstrap,
  createRealTenantCreator,
  injectFailureAfterRealCall,
  resetTask7Tables,
  tenantDependencies,
} from './helpers/task7.js';

type FailurePoint =
  | 'hashPassword'
  | 'createOrganization'
  | 'createUser'
  | 'createOwnerMembership'
  | 'ensureLogicalBaileysAccount'
  | 'writeTenantAudit';

const REQUEST_ID = '85ba9cd7-0527-4df9-9793-ce8e2769f24c';

interface CreateNewInput {
  administrativeCredential: string;
  organizationName: string;
  organizationSlug: string;
  ownerMode: 'CREATE_NEW';
  ownerEmail: string;
  ownerPassword: string;
  requestId: string;
  evolutionAdministrativeCredential?: string;
}

interface LinkExistingInput {
  administrativeCredential: string;
  organizationName: string;
  organizationSlug: string;
  ownerMode: 'LINK_EXISTING';
  ownerEmail: string;
  confirmLinkExisting: boolean;
  requestId: string;
}

function createNewInput(overrides: Partial<CreateNewInput> = {}): CreateNewInput {
  return {
    administrativeCredential: ADMIN_CREDENTIAL,
    organizationName: 'Cliente',
    organizationSlug: 'cliente',
    ownerMode: 'CREATE_NEW',
    ownerEmail: ' New.Owner@Example.test ',
    ownerPassword: 'owner-password-canary',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function linkExistingInput(overrides: Partial<LinkExistingInput> = {}): LinkExistingInput {
  return {
    administrativeCredential: ADMIN_CREDENTIAL,
    organizationName: 'Cliente Link',
    organizationSlug: 'cliente-link',
    ownerMode: 'LINK_EXISTING',
    ownerEmail: ' Existing.Owner@Example.test ',
    confirmLinkExisting: true,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

async function seedExistingUser(
  pool: Pool,
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
): Promise<{ id: string; passwordHash: string }> {
  const passwordHash = '$argon2id$existing-original-hash-canary';
  return runInAdminTransaction(pool, async (transaction) => {
    const user = await createUser(transaction, {
      email: 'existing.owner@example.test',
      passwordHash,
    });
    if (status === 'DISABLED') {
      await setUserStatus(transaction, user.id, status);
    }
    return { id: user.id, passwordHash };
  });
}

async function totals(pool: Pool) {
  return oneRow<{
    organizations: number;
    users: number;
    memberships: number;
    providerAccounts: number;
    audits: number;
  }>(
    pool,
    `SELECT
       (SELECT count(*)::int FROM organizations) AS organizations,
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM memberships) AS memberships,
       (SELECT count(*)::int FROM provider_accounts) AS "providerAccounts",
       (SELECT count(*)::int FROM audit_logs) AS audits`,
  );
}

async function tenantCounts(pool: Pool, slug: string) {
  return oneRow<{
    organizations: number;
    users: number;
    owners: number;
    baileysProviderAccounts: number;
  }>(
    pool,
    `SELECT
       count(DISTINCT o.id)::int AS organizations,
       count(DISTINCT m.user_id)::int AS users,
       count(DISTINCT m.user_id) FILTER (
         WHERE m.role = 'OWNER' AND m.status = 'ACTIVE'
       )::int AS owners,
       count(DISTINCT pa.id) FILTER (WHERE pa.provider = 'BAILEYS')::int
         AS "baileysProviderAccounts"
       FROM organizations o
       LEFT JOIN memberships m ON m.organization_id = o.id
       LEFT JOIN provider_accounts pa ON pa.organization_id = o.id
      WHERE o.slug = $1`,
    [slug],
  );
}

describe('tenant:create administrativo com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
  });

  beforeEach(async () => {
    await resetTask7Tables(database.pool);
    await createRealBootstrap(database.pool)({
      organizationName: 'Bootstrap',
      organizationSlug: 'bootstrap',
      email: 'bootstrap@example.test',
      password: 'bootstrap-password-canary',
      requestId: '09746913-173d-4a4d-8131-90098e04d934',
    });
  });

  afterAll(async () => {
    await database.dispose();
  });

  it('exige credencial administrativa válida sem deixar efeitos', async () => {
    const createTenant = createRealTenantCreator(database.pool);
    const before = await totals(database.pool);

    const rejection = await createTenant(createNewInput({
      administrativeCredential: 'invalid-admin-credential-canary',
    })).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'ADMINISTRATIVE_CREDENTIAL_INVALID' });
    expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain(
      'invalid-admin-credential-canary',
    );
    expect(await totals(database.pool)).toEqual(before);
  });

  it('CREATE_NEW cria um OWNER e exatamente um BAILEYS com saída e auditoria sanitizadas', async () => {
    const createTenant = createRealTenantCreator(database.pool);

    const result = await createTenant(createNewInput({
      evolutionAdministrativeCredential: 'evolution-administrative-key-canary',
    }));

    expect(await tenantCounts(database.pool, 'cliente')).toEqual({
      organizations: 1,
      users: 1,
      owners: 1,
      baileysProviderAccounts: 1,
    });
    const persisted = await oneRow<{
      passwordHash: string;
      externalReference: string | null;
      credentialReference: string | null;
      actorId: string | null;
      eventType: string;
      resourceId: string;
      resourceType: string;
      requestId: string;
      metadata: unknown;
    }>(
      database.pool,
      `SELECT u.password_hash AS "passwordHash",
              pa.external_reference AS "externalReference",
              pa.credential_reference AS "credentialReference",
              al.actor_id AS "actorId", al.event_type AS "eventType",
              al.resource_id AS "resourceId", al.resource_type AS "resourceType",
              al.request_id AS "requestId", al.metadata
         FROM organizations o
         JOIN memberships m ON m.organization_id = o.id
         JOIN users u ON u.id = m.user_id
         JOIN provider_accounts pa ON pa.organization_id = o.id
         JOIN audit_logs al ON al.organization_id = o.id
        WHERE o.slug = 'cliente'`,
    );
    expect(persisted.passwordHash).toMatch(/^\$argon2id\$/);
    expect(persisted).toMatchObject({
      externalReference: null,
      credentialReference: null,
      actorId: null,
      eventType: 'TENANT_CREATED',
      resourceId: result.organizationId,
      resourceType: 'organization',
      requestId: REQUEST_ID,
      metadata: { actorKind: 'LOCAL_ADMIN_COMMAND' },
    });
    const serializedPublicData = JSON.stringify({ result, audit: persisted.metadata });
    for (const canary of [
      ADMIN_CREDENTIAL,
      'owner-password-canary',
      'evolution-administrative-key-canary',
      persisted.passwordHash,
    ]) {
      expect(serializedPublicData).not.toContain(canary);
    }
  });

  it('CREATE_NEW recusa e-mail existente sem alterar o password_hash nem criar tenant', async () => {
    const existing = await seedExistingUser(database.pool);
    const createTenant = createRealTenantCreator(database.pool);
    const before = await totals(database.pool);

    await expect(createTenant(createNewInput({
      ownerEmail: ' Existing.Owner@Example.test ',
      ownerPassword: 'replacement-password-canary',
    }))).rejects.toMatchObject({ code: 'OWNER_EMAIL_ALREADY_EXISTS' });

    const stored = await oneRow<{ passwordHash: string }>(
      database.pool,
      `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1`,
      [existing.id],
    );
    expect(stored.passwordHash).toBe(existing.passwordHash);
    expect(await totals(database.pool)).toEqual(before);
  });

  it('LINK_EXISTING exige confirmação, usuário ativo e ausência de senha', async () => {
    const existing = await seedExistingUser(database.pool);
    const createTenant = createRealTenantCreator(database.pool);
    const before = await totals(database.pool);

    await expect(createTenant(linkExistingInput({
      confirmLinkExisting: false,
    }))).rejects.toMatchObject({ code: 'LINK_EXISTING_CONFIRMATION_REQUIRED' });
    await expect(createTenant({
      ...linkExistingInput(),
      ownerPassword: 'forbidden-password-canary',
    } as never)).rejects.toMatchObject({ code: 'LINK_EXISTING_PASSWORD_NOT_ALLOWED' });
    await runInAdminTransaction(database.pool, (transaction) =>
      setUserStatus(transaction, existing.id, 'DISABLED'));
    await expect(createTenant(linkExistingInput())).rejects.toMatchObject({
      code: 'OWNER_USER_NOT_ACTIVE',
    });
    expect(await totals(database.pool)).toEqual(before);
  });

  it('LINK_EXISTING bloqueia a linha e revalida ACTIVE após desativação concorrente', async () => {
    const existing = await seedExistingUser(database.pool);
    let releaseDeactivation!: () => void;
    let signalDeactivationWritten!: () => void;
    const deactivationMayCommit = new Promise<void>((resolve) => {
      releaseDeactivation = resolve;
    });
    const deactivationWritten = new Promise<void>((resolve) => {
      signalDeactivationWritten = resolve;
    });
    const deactivation = runInAdminTransaction(database.pool, async (transaction) => {
      await setUserStatus(transaction, existing.id, 'DISABLED');
      signalDeactivationWritten();
      await deactivationMayCommit;
    });
    await deactivationWritten;

    let signalLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    const real = tenantDependencies(database.pool);
    const createTenant = createTenantCreator({
      ...real,
      findUserByEmailForUpdate: async (transaction: AdminTransaction, email: string) => {
        signalLookupStarted();
        return real.findUserByEmailForUpdate(transaction, email);
      },
    });
    const linking = createTenant(linkExistingInput());
    await lookupStarted;
    releaseDeactivation();
    await deactivation;

    await expect(linking).rejects.toMatchObject({ code: 'OWNER_USER_NOT_ACTIVE' });
    expect(await tenantCounts(database.pool, 'cliente-link')).toEqual({
      organizations: 0,
      users: 0,
      owners: 0,
      baileysProviderAccounts: 0,
    });
  });

  it('LINK_EXISTING reutiliza o usuário ativo sem alterar hash e cria só a membership OWNER', async () => {
    const existing = await seedExistingUser(database.pool);
    const createTenant = createRealTenantCreator(database.pool);
    const before = await totals(database.pool);

    const result = await createTenant(linkExistingInput());

    const after = await totals(database.pool);
    expect(after).toEqual({
      organizations: before.organizations + 1,
      users: before.users,
      memberships: before.memberships + 1,
      providerAccounts: before.providerAccounts + 1,
      audits: before.audits + 1,
    });
    const stored = await oneRow<{ passwordHash: string }>(
      database.pool,
      `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1`,
      [existing.id],
    );
    expect(stored.passwordHash).toBe(existing.passwordHash);
    expect(JSON.stringify(result)).not.toContain(existing.passwordHash);
  });

  it.each<FailurePoint>([
    'hashPassword',
    'createOrganization',
    'createUser',
    'createOwnerMembership',
    'ensureLogicalBaileysAccount',
    'writeTenantAudit',
  ])('desfaz efeitos dos repositórios reais quando falha após %s', async (failurePoint) => {
    const dependencies = injectFailureAfterRealCall(
      tenantDependencies(database.pool),
      failurePoint,
    );
    const createTenant = createTenantCreator(dependencies);
    const before = await totals(database.pool);

    await expect(createTenant(createNewInput())).rejects.toMatchObject({ code: 'INJECTED_FAILURE' });
    expect(await totals(database.pool)).toEqual(before);
  });

  it('resolve corrida de mesmo slug/e-mail usando constraints e repositories reais', async () => {
    const createTenant = createRealTenantCreator(database.pool);

    const settled = await Promise.allSettled([
      createTenant(createNewInput()),
      createTenant(createNewInput()),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: {
        code: expect.stringMatching(/^(OWNER_EMAIL_ALREADY_EXISTS|ORGANIZATION_SLUG_ALREADY_EXISTS)$/),
      },
    });
    expect(await tenantCounts(database.pool, 'cliente')).toEqual({
      organizations: 1,
      users: 1,
      owners: 1,
      baileysProviderAccounts: 1,
    });
  });
});
