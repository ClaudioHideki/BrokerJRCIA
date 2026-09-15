import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import {
  createPostgresProviderAccountRepository,
  ensureLogicalBaileysAccount,
} from '../../src/modules/provider-accounts/repository.js';
import {
  createProviderAccountService,
  type ProviderAccountService,
} from '../../src/modules/provider-accounts/service.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('descoberta de provider accounts com RLS real', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let service: ProviderAccountService;
  let organizationA: string;
  let organizationB: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    await runInAdminTransaction(database.pool, async (transaction) => {
      const first = await createOrganization(transaction, { name: 'Provider A', slug: 'provider-a' });
      const second = await createOrganization(transaction, { name: 'Provider B', slug: 'provider-b' });
      organizationA = first.id;
      organizationB = second.id;
      const ownerA = await createUser(transaction, {
        email: 'provider-owner-a@example.test',
        passwordHash: 'argon2id-test-hash',
      });
      const ownerB = await createUser(transaction, {
        email: 'provider-owner-b@example.test',
        passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organizationA, userId: ownerA.id });
      await createOwnerMembership(transaction, { organizationId: organizationB, userId: ownerB.id });
      await ensureLogicalBaileysAccount(transaction, organizationA);
      await ensureLogicalBaileysAccount(transaction, organizationB);
    });
    await database.pool.query(
      `INSERT INTO provider_accounts (organization_id, provider, name)
       VALUES ($1, 'META', 'Meta futura')`,
      [organizationA],
    );
    appPool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
      max: 2,
    });
    service = createProviderAccountService({
      repository: createPostgresProviderAccountRepository(),
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
    });
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('isola bidirecionalmente e não retorna campos internos', async () => {
    const pageA = await service.listProviderAccounts(organizationA, { limit: 20 });
    const pageB = await service.listProviderAccounts(organizationB, { limit: 20 });

    expect(pageA.data).toHaveLength(2);
    expect(pageB.data).toHaveLength(1);
    expect(pageB.data[0]?.provider).toBe('BAILEYS');
    expect(JSON.stringify([...pageA.data, ...pageB.data])).not.toMatch(
      /organizationId|credentialReference|externalReference|secret/i,
    );
  });

  it('pagina com ordem estável e vincula cursor ao tenant e ao filtro', async () => {
    const first = await service.listProviderAccounts(organizationA, { limit: 1 });
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = await service.listProviderAccounts(organizationA, {
      limit: 1,
      cursor: first.pageInfo.nextCursor!,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);

    await expect(service.listProviderAccounts(organizationB, {
      limit: 1,
      cursor: first.pageInfo.nextCursor!,
    })).rejects.toMatchObject({ status: 404, code: 'CURSOR_NOT_FOUND' });
    await expect(service.listProviderAccounts(organizationA, {
      limit: 1,
      provider: 'BAILEYS',
      cursor: first.pageInfo.nextCursor!,
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });

  it('nega por padrão fora de uma transação com SET LOCAL', async () => {
    const direct = await appPool.query('SELECT id FROM provider_accounts');
    expect(direct.rows).toEqual([]);
  });
});
