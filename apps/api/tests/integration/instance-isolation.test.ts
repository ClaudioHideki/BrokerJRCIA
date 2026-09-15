import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createInstanceService, type InstanceService } from '../../src/modules/instances/service.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const REQUEST_ID = '8ecfc8d2-3a67-42db-a3de-24fc99aef758';

describe('isolamento real do ciclo de instâncias', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let provider: FakeProviderAdapter;
  let service: InstanceService;
  let tenantA: { organizationId: string; ownerId: string; accountId: string };
  let tenantB: { organizationId: string; ownerId: string; accountId: string };

  async function seedTenant(slug: string) {
    return runInAdminTransaction(database.pool, async (transaction) => {
      const organization = await createOrganization(transaction, { name: slug, slug });
      const owner = await createUser(transaction, {
        email: `${slug}@example.test`, passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(transaction, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
  }

  function context(tenant: typeof tenantA) {
    return {
      credentialKind: 'JWT' as const,
      organizationId: tenant.organizationId,
      actorId: tenant.ownerId,
      requestId: REQUEST_ID,
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    };
  }

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    tenantA = await seedTenant('instance-tenant-a');
    tenantB = await seedTenant('instance-tenant-b');
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: { getStatus: 'CONNECTED' },
    });
    const registry = new ProviderRegistry([provider], [['BAILEYS', provider]]);
    service = createInstanceService({
      repository: createPostgresInstanceRepository(),
      providers: registry,
      now: () => NOW,
      randomUuid: randomUUID,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('tenant A cria/lista/consulta enquanto tenant B recebe 404 sem chamada provider', async () => {
    const created = await service.createInstance(context(tenantA), {
      name: 'Primary', provider: 'BAILEYS', providerAccountId: tenantA.accountId, idempotencyKey: 'create-a',
    });
    expect(created.instance.status).toBe('CREATED');
    await expect(service.listInstances(context(tenantA), { limit: 20 })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: created.instance.id })],
    });
    await expect(service.listInstances(context(tenantB), { limit: 20 })).resolves.toMatchObject({ data: [] });

    const before = {
      status: provider.calls.getStatus.length,
      connect: provider.calls.beginConnection.length,
      disconnect: provider.calls.disconnect.length,
    };
    await expect(service.getInstanceStatus(context(tenantB), created.instance.id))
      .rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    await expect(service.connectInstance(context(tenantB), {
      instanceId: created.instance.id, idempotencyKey: 'foreign-connect',
    })).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    await expect(service.disconnectInstance(context(tenantB), {
      instanceId: created.instance.id, idempotencyKey: 'foreign-disconnect',
    })).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    expect(provider.calls.getStatus).toHaveLength(before.status);
    expect(provider.calls.beginConnection).toHaveLength(before.connect);
    expect(provider.calls.disconnect).toHaveLength(before.disconnect);
  });

  it('consulta status e desconecta o próprio registro sem transação envolvendo provider', async () => {
    const created = await service.createInstance(context(tenantA), {
      name: 'Secondary', provider: 'BAILEYS', providerAccountId: tenantA.accountId, idempotencyKey: 'create-secondary',
    });
    await expect(service.getInstanceStatus(context(tenantA), created.instance.id))
      .resolves.toMatchObject({ status: 'CONNECTED' });
    await expect(service.disconnectInstance(context(tenantA), {
      instanceId: created.instance.id, idempotencyKey: 'disconnect-secondary',
    })).resolves.toMatchObject({ instance: { status: 'DISCONNECTED' } });
  });

  it('mantém isolamento bidirecional quando o tenant B possui recurso próprio', async () => {
    const createdByB = await service.createInstance(context(tenantB), {
      name: 'Tenant B instance', provider: 'BAILEYS', providerAccountId: tenantB.accountId,
      idempotencyKey: 'create-b',
    });

    await expect(service.getInstance(context(tenantB), createdByB.instance.id))
      .resolves.toMatchObject({ id: createdByB.instance.id });
    await expect(service.getInstance(context(tenantA), createdByB.instance.id))
      .rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    const pageA = await service.listInstances(context(tenantA), { limit: 100 });
    expect(pageA.data.map(({ id }) => id)).not.toContain(createdByB.instance.id);
  });
});
