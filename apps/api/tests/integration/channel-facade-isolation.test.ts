import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createChannelFacade } from '../../src/modules/channels/facade.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, type IsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');

describe('isolamento PostgreSQL da fachada canônica de canais', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let facade: ReturnType<typeof createChannelFacade>;
  let instances: ReturnType<typeof createInstanceService>;
  let tenantA: { organizationId: string; ownerId: string; accountId: string };
  let tenantB: typeof tenantA;

  async function seedTenant(slug: string) {
    return runInAdminTransaction(database.pool, async tx => {
      const organization = await createOrganization(tx, { name: slug, slug });
      const owner = await createUser(tx, { email: `${slug}@example.test`, passwordHash: 'argon2id-test-hash' });
      await createOwnerMembership(tx, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(tx, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
  }

  const context = (tenant: typeof tenantA) => ({ credentialKind: 'JWT' as const, organizationId: tenant.organizationId,
    actorId: tenant.ownerId, requestId: randomUUID(), deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal });

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    tenantA = await seedTenant('channel-facade-a');
    tenantB = await seedTenant('channel-facade-b');
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    const provider = new FakeProviderAdapter({ now: () => NOW, responses: { getStatus: 'CONNECTED' } });
    instances = createInstanceService({ repository: createPostgresInstanceRepository(),
      providers: new ProviderRegistry([provider], [['BAILEYS', provider]]), now: () => NOW, randomUuid: randomUUID,
      runInOrganizationTransaction: (org, work) => withOrganizationTransaction(appPool, org, work),
      writeAudit: writeTenantAudit });
    facade = createChannelFacade({ instances, meta: { start: async () => { throw new Error('unused'); } },
      transact: (org, work) => withOrganizationTransaction(appPool, org, work) });
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('separa listagem, consulta e vínculo de automação entre duas empresas', async () => {
    const a = await instances.createInstance(context(tenantA), { name: 'Canal A', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'channel-a' });
    const b = await instances.createInstance(context(tenantB), { name: 'Canal B', provider: 'BAILEYS',
      providerAccountId: tenantB.accountId, idempotencyKey: 'channel-b' });
    await expect(facade.list(tenantA.organizationId)).resolves.toMatchObject({ data: [{ id: a.instance.id }] });
    await expect(facade.list(tenantB.organizationId)).resolves.toMatchObject({ data: [{ id: b.instance.id }] });
    await expect(facade.get(tenantB.organizationId, a.instance.id)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });

    const channelId = randomUUID(), automationId = randomUUID();
    await withOrganizationTransaction(appPool, tenantA.organizationId, async tx => {
      await tx.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference)
        VALUES($1,$2,$3,'BAILEYS',$4,'qr-engine')`, [channelId, tenantA.organizationId, tenantA.accountId, a.instance.id]);
      await tx.query(`INSERT INTO automation_definitions(organization_id,id,name,draft_graph)
        VALUES($1,$2,'Triagem','{"nodes":[],"edges":[]}')`, [tenantA.organizationId, automationId]);
      await tx.query(`INSERT INTO automation_versions(organization_id,automation_id,version,graph,checksum)
        VALUES($1,$2,1,'{"nodes":[],"edges":[]}',$3)`, [tenantA.organizationId, automationId, 'a'.repeat(64)]);
      await tx.query('UPDATE automation_definitions SET active_version=1,lifecycle_status=\'PUBLISHED\' WHERE organization_id=$1 AND id=$2',
        [tenantA.organizationId, automationId]);
    });
    await expect(facade.bindAutomation(tenantA.organizationId, a.instance.id, { automationId }))
      .resolves.toMatchObject({ binding: { automationId, channelId, version: 1, status: 'ACTIVE' } });
    await expect(facade.bindAutomation(tenantB.organizationId, a.instance.id, { automationId }))
      .rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(facade.getAutomation(tenantA.organizationId, a.instance.id))
      .resolves.toMatchObject({ binding: { automationId, channelId } });
  });
});
