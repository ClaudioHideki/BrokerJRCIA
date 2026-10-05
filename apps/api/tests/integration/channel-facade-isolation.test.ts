import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import {createChatwootService} from '../../src/modules/integrations/chatwoot-service.js';
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
    const tenant = await runInAdminTransaction(database.pool, async tx => {
      const organization = await createOrganization(tx, { name: slug, slug });
      const owner = await createUser(tx, { email: `${slug}@example.test`, passwordHash: 'argon2id-test-hash' });
      await createOwnerMembership(tx, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(tx, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
    // Fixture provisioning is administrative. Never grant the tenant role permission
    // to enable its own module, and never infer this flag from a plan label.
    await database.pool.query(`INSERT INTO flow_features(organization_id,enabled) VALUES($1,true)
      ON CONFLICT(organization_id) DO UPDATE SET enabled=true`, [tenant.organizationId]);
    return tenant;
  }

  const context = (tenant: typeof tenantA) => ({ credentialKind: 'JWT' as const, organizationId: tenant.organizationId,
    actorId: tenant.ownerId, requestId: randomUUID(), deadline: new Date(Date.now() + 60_000),
    signal: new AbortController().signal });

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    const provider = new FakeProviderAdapter({ now: () => NOW, responses: { getStatus: 'CONNECTED' } });
    instances = createInstanceService({ repository: createPostgresInstanceRepository(),
      providers: new ProviderRegistry([provider], [['BAILEYS', provider]]), now: () => NOW, randomUuid: randomUUID,
      runInOrganizationTransaction: (org, work) => withOrganizationTransaction(appPool, org, work),
      writeAudit: writeTenantAudit });
    facade = createChannelFacade({ instances, meta: { start: async () => { throw new Error('unused'); } },
      transact: (org, work) => withOrganizationTransaction(appPool, org, work) });
  }, 60_000);

  beforeEach(async () => {
    // Each scenario owns its fixtures. A failed/filtered test must not affect another.
    const suffix = randomUUID();
    tenantA = await seedTenant(`channel-facade-a-${suffix}`);
    tenantB = await seedTenant(`channel-facade-b-${suffix}`);
  });

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  async function seedPublishedAutomation(tenant: typeof tenantA, instanceId: string) {
    const channelId = randomUUID(), automationId = randomUUID();
    const graph = JSON.stringify({
      nodes: [
        { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
        { id: 'end', type: 'end', label: 'Fim', position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: 'next', source: 'start', target: 'end', port: 'next' }],
    });
    await withOrganizationTransaction(appPool, tenant.organizationId, async tx => {
      await tx.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,provider,instance_id,credential_reference)
        VALUES($1,$2,$3,'BAILEYS',$4,'qr-engine')`, [channelId, tenant.organizationId, tenant.accountId, instanceId]);
      await tx.query(`INSERT INTO automation_definitions(organization_id,id,name,draft_graph)
        VALUES($1,$2,'Triagem',$3)`, [tenant.organizationId, automationId, graph]);
      await tx.query(`INSERT INTO automation_versions(organization_id,automation_id,version,graph,checksum)
        VALUES($1,$2,1,$3,$4)`, [tenant.organizationId, automationId, graph, 'a'.repeat(64)]);
      await tx.query('UPDATE automation_definitions SET active_version=1,lifecycle_status=\'PUBLISHED\' WHERE organization_id=$1 AND id=$2',
        [tenant.organizationId, automationId]);
    });
    return { channelId, automationId };
  }

  it('rejects an invalid stored published graph without changing the channel owner', async () => {
    const created = await instances.createInstance(context(tenantA), {
      name: 'Invalid graph', provider: 'BAILEYS', providerAccountId: tenantA.accountId,
      idempotencyKey: 'invalid-published-graph',
    });
    const { automationId } = await seedPublishedAutomation(tenantA, created.instance.id);
    await database.pool.query(
      'UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',
      [tenantA.organizationId, automationId, JSON.stringify({ nodes: [], edges: [] })],
    );
    await expect(facade.bindAutomation(tenantA.organizationId, created.instance.id, {
      automationId, expectedOwnerRevision: 0,
    })).rejects.toMatchObject({ code: 'AUTOMATION_PUBLISHED_GRAPH_INVALID' });
    await expect(facade.getAutomation(tenantA.organizationId, created.instance.id))
      .resolves.toEqual({ binding: null, ownerRevision: 0 });
  });

  it('separa listagem, consulta e vínculo de automação entre duas empresas', async () => {
    const a = await instances.createInstance(context(tenantA), { name: 'Canal A', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'channel-a' });
    const b = await instances.createInstance(context(tenantB), { name: 'Canal B', provider: 'BAILEYS',
      providerAccountId: tenantB.accountId, idempotencyKey: 'channel-b' });
    await expect(facade.getAutomation(tenantA.organizationId,a.instance.id)).resolves.toEqual({binding:null,ownerRevision:0});
    await expect(facade.list(tenantA.organizationId)).resolves.toMatchObject({ data: [{ id: a.instance.id }] });
    await expect(facade.list(tenantB.organizationId)).resolves.toMatchObject({ data: [{ id: b.instance.id }] });
    await expect(facade.get(tenantB.organizationId, a.instance.id)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });

    const { channelId, automationId } = await seedPublishedAutomation(tenantA, a.instance.id);
    await expect(facade.bindAutomation(tenantA.organizationId, a.instance.id, { automationId, expectedOwnerRevision: 0 }))
      .resolves.toMatchObject({ binding: { automationId, channelId, version: 1, status: 'ACTIVE' } });
    await expect(facade.bindAutomation(tenantB.organizationId, a.instance.id, { automationId, expectedOwnerRevision: 0 }))
      .rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(facade.getAutomation(tenantA.organizationId, a.instance.id))
      .resolves.toMatchObject({ binding: { automationId, channelId } });
  });

  it('denies binding when the module is disabled and leaves ownership unchanged', async () => {
    const created = await instances.createInstance(context(tenantA), {
      name: 'Disabled module fixture', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'disabled-module-fixture',
    });
    const { channelId, automationId } = await seedPublishedAutomation(tenantA, created.instance.id);
    await database.pool.query('UPDATE flow_features SET enabled=false,revision=revision+1 WHERE organization_id=$1',
      [tenantA.organizationId]);
    const previous = await facade.getAutomation(tenantA.organizationId, created.instance.id);
    await expect(facade.bindAutomation(tenantA.organizationId, created.instance.id,
      { automationId, expectedOwnerRevision: previous.ownerRevision }))
      .rejects.toMatchObject({ code: 'AUTOMATION_MODULE_DISABLED', status: 403 });
    expect(await facade.getAutomation(tenantA.organizationId, created.instance.id)).toEqual(previous);
    expect((await database.pool.query('SELECT id FROM automation_bindings WHERE organization_id=$1 AND channel_id=$2',
      [tenantA.organizationId, channelId])).rows).toEqual([]);
    expect((await database.pool.query('SELECT bot_public_id FROM messaging_channels WHERE organization_id=$1 AND id=$2',
      [tenantA.organizationId, channelId])).rows[0]).toEqual({ bot_public_id: null });
  });

  it('pagina as caixas no PostgreSQL sem repetir registros ou misturar empresas', async () => {
    await instances.createInstance(context(tenantA), { name: 'Canal paginado 1', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'channel-page-1' });
    await instances.createInstance(context(tenantA), { name: 'Canal paginado 2', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'channel-page-2' });
    const expected = (await facade.list(tenantA.organizationId)).data.map(channel => channel.id);
    expect(expected.length).toBeGreaterThan(1);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await facade.list(tenantA.organizationId, false, { pageSize: 1, ...(cursor ? { cursor } : {}) });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.organizationId).toBe(tenantA.organizationId);
      seen.push(page.data[0]!.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen)).toEqual(new Set(expected));
    expect((await facade.list(tenantB.organizationId, false, { pageSize: 1 })).data.every(
      channel => channel.organizationId === tenantB.organizationId)).toBe(true);
  });

  it('archives a disconnected instance, preserves its record and prevents tenant/provider operations',async()=>{
    const result=await instances.createInstance(context(tenantA),{name:'Cadastro a arquivar',provider:'BAILEYS',providerAccountId:tenantA.accountId,idempotencyKey:'archive-fixture'});
    await expect(facade.setArchived(tenantB.organizationId,result.instance.id,true,tenantB.ownerId)).rejects.toMatchObject({code:'CHANNEL_NOT_FOUND'});
    await database.pool.query("update instances set status='CONNECTED' where id=$1",[result.instance.id]);
    await expect(facade.setArchived(tenantA.organizationId,result.instance.id,true,tenantA.ownerId)).rejects.toMatchObject({code:'CHANNEL_DISCONNECT_REQUIRED'});
    await database.pool.query("update instances set status='DISCONNECTED' where id=$1",[result.instance.id]);
    await expect(facade.setArchived(tenantA.organizationId,result.instance.id,true,tenantA.ownerId)).rejects.toMatchObject({code:'CHANNEL_HAS_PENDING_WORK'});
    await database.pool.query("update provider_operations set status='SUCCEEDED',reconciliation_required=false where instance_id=$1",[result.instance.id]);
    await facade.setArchived(tenantA.organizationId,result.instance.id,true,tenantA.ownerId);
    expect((await facade.list(tenantA.organizationId)).data.some(item=>item.id===result.instance.id)).toBe(false);
    expect((await facade.list(tenantA.organizationId,true)).data.some(item=>item.id===result.instance.id&&item.archivedAt)).toBe(true);
    await expect(instances.connectInstance(context(tenantA),{instanceId:result.instance.id,idempotencyKey:'after-archive'})).rejects.toThrow();
    await expect(withOrganizationTransaction(appPool,tenantA.organizationId,t=>t.query("insert into provider_operations(organization_id,instance_id,operation_type) values($1,$2,'CONNECT')",[tenantA.organizationId,result.instance.id]))).rejects.toMatchObject({constraint:'instance_archived'});
    await facade.setArchived(tenantA.organizationId,result.instance.id,false,tenantA.ownerId);
    expect((await facade.get(tenantA.organizationId,result.instance.id)).archivedAt).toBeNull();
  });

  it('removes an unused disabled inbox binding only within its organization, without calling the remote system',async()=>{
    const created = await instances.createInstance(context(tenantA), {
      name: 'Unused inbox fixture', provider: 'BAILEYS',
      providerAccountId: tenantA.accountId, idempotencyKey: 'unused-inbox-fixture',
    });
    const { channelId: channel, automationId } = await seedPublishedAutomation(tenantA, created.instance.id);
    const { binding } = await facade.bindAutomation(tenantA.organizationId, created.instance.id,
      { automationId, expectedOwnerRevision: 0 });
    expect(binding).toMatchObject({ automationId, channelId: channel, status: 'ACTIVE' });
    const connection=randomUUID();await database.pool.query("insert into chatwoot_accounts(organization_id,base_url,status) values($1,'https://qa.example.test','READY')",[tenantA.organizationId]);
    await database.pool.query("insert into chatwoot_connections(id,organization_id,channel_id,name,status) values($1,$2,$3,'Cadastro errado','DISABLED')",[connection,tenantA.organizationId,channel]);
    const service=createChatwootService({publicOrigin:'https://broker.example.test',baseUrl:'https://qa.example.test',encryptionKey:Buffer.alloc(32,1).toString('base64'),transact:(org,work)=>withOrganizationTransaction(appPool,org,work),resolveIntegration:async()=>undefined,fetch:async()=>{throw new Error('Must not call remote');}});
    await expect(service.removeUnusedConnection(tenantB.organizationId,connection,tenantB.ownerId)).rejects.toMatchObject({code:'INTEGRATION_NOT_FOUND'});
    await database.pool.query('update automation_bindings set human_destination_id=$3 where organization_id=$1 and id=$2',[tenantA.organizationId,binding.id,connection]);
    await expect(service.removeUnusedConnection(tenantA.organizationId,connection,tenantA.ownerId)).rejects.toMatchObject({code:'INTEGRATION_HAS_HISTORY'});
    await database.pool.query('update automation_bindings set human_destination_id=null where organization_id=$1 and id=$2',[tenantA.organizationId,binding.id]);
    await service.removeUnusedConnection(tenantA.organizationId,connection,tenantA.ownerId);
    expect((await database.pool.query('select id from chatwoot_connections where id=$1',[connection])).rows).toHaveLength(0);
  });

});
