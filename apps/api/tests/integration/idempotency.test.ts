import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createInstanceService, type InstanceService } from '../../src/modules/instances/service.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');

describe('idempotência real de instâncias', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let provider: FakeProviderAdapter;
  let service: InstanceService;
  let tenant: { organizationId: string; ownerId: string; accountId: string };

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    tenant = await runInAdminTransaction(database.pool, async (transaction) => {
      const organization = await createOrganization(transaction, { name: 'Idempotency', slug: 'idempotency' });
      const owner = await createUser(transaction, {
        email: 'idempotency@example.test', passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(transaction, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
    // This shared fixture accumulates instances across idempotency cases.
    await database.pool.query('UPDATE organization_limits SET max_instances=20 WHERE organization_id=$1', [tenant.organizationId]);
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        beginConnection: {
          type: 'QR_CODE', encoding: 'BASE64', value: 'integration-secret-qr',
          expiresAt: '2030-01-01T00:01:00.000Z',
        },
      },
    });
    service = createInstanceService({
      repository: createPostgresInstanceRepository(),
      providers: new ProviderRegistry([provider], [['BAILEYS', provider]]),
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

  function context() {
    return {
      credentialKind: 'JWT' as const,
      organizationId: tenant.organizationId,
      actorId: tenant.ownerId,
      requestId: '8ecfc8d2-3a67-42db-a3de-24fc99aef758',
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    };
  }

  it('corrida com a mesma chave provisiona apenas uma vez e retorna o mesmo recurso', async () => {
    const command = {
      name: 'Concurrent', provider: 'BAILEYS' as const, providerAccountId: tenant.accountId,
      idempotencyKey: 'same-create-key',
    };
    const results = await Promise.all([
      service.createInstance(context(), command),
      service.createInstance(context(), command),
    ]);

    expect(new Set(results.map(({ instance }) => instance.id)).size).toBe(1);
    expect(provider.calls.provisionInstance).toHaveLength(1);
    expect(results.some(({ replayed }) => replayed)).toBe(true);
  });

  it('mesma chave com outro payload retorna conflito 409', async () => {
    await service.createInstance(context(), {
      name: 'Original', provider: 'BAILEYS', providerAccountId: tenant.accountId, idempotencyKey: 'payload-conflict',
    });
    await expect(service.createInstance(context(), {
      name: 'Changed', provider: 'BAILEYS', providerAccountId: tenant.accountId, idempotencyKey: 'payload-conflict',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('replay de connect não repete provider nem persiste QR, pairing ou token', async () => {
    const created = await service.createInstance(context(), {
      name: 'Connect', provider: 'BAILEYS', providerAccountId: tenant.accountId, idempotencyKey: 'create-connect',
    });
    const command = { instanceId: created.instance.id, idempotencyKey: 'connect-once' };
    const first = await service.connectInstance(context(), command);
    expect(first.action).toMatchObject({ type: 'QR_CODE' });
    const replay = await service.connectInstance(context(), command);
    expect(replay).toMatchObject({
      replayed: true,
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    expect(provider.calls.beginConnection).toHaveLength(1);

    const persisted = await oneRow<{ payload: string }>(database.pool,
      `SELECT coalesce(string_agg(response_metadata::text, ''), '') AS payload
         FROM idempotency_records
        WHERE organization_id = $1`, [tenant.organizationId]);
    expect(persisted.payload).not.toContain('integration-secret-qr');
    expect(persisted.payload).not.toMatch(/pairing|token/i);
  });

  it('impede duas chaves diferentes de iniciarem conexão concorrente na mesma instância', async () => {
    const created = await service.createInstance(context(), {
      name: 'Connection race', provider: 'BAILEYS', providerAccountId: tenant.accountId,
      idempotencyKey: 'create-connection-race',
    });
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const baseline = provider.calls.beginConnection.length;
    const original = provider.beginConnection.bind(provider);
    provider.beginConnection = async (...arguments_) => {
      markEntered();
      await gate;
      return original(...arguments_);
    };

    const first = service.connectInstance(context(), {
      instanceId: created.instance.id, idempotencyKey: 'connect-race-a',
    });
    await entered;
    await expect(service.connectInstance(context(), {
      instanceId: created.instance.id, idempotencyKey: 'connect-race-b',
    })).resolves.toMatchObject({
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    release();
    await first;
    expect(provider.calls.beginConnection).toHaveLength(baseline + 1);
  });

  it('claim de reconciliação é atômico e permite recuperar lease expirado', async () => {
    const timeout = Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' });
    const timeoutProvider = new FakeProviderAdapter({
      now: () => NOW,
      errors: { provisionInstance: timeout },
    });
    const repository = createPostgresInstanceRepository();
    const timeoutService = createInstanceService({
      repository,
      providers: new ProviderRegistry([timeoutProvider], [['BAILEYS', timeoutProvider]]),
      now: () => NOW,
      randomUuid: randomUUID,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
    });
    const created = await timeoutService.createInstance(context(), {
      name: 'Reconcile lease', provider: 'BAILEYS', providerAccountId: tenant.accountId,
      idempotencyKey: 'create-reconcile-lease',
    });
    const claim = () => withOrganizationTransaction(appPool, tenant.organizationId, (transaction) => (
      repository.claimProvisioningOperation(
        transaction,
        tenant.organizationId,
        created.operationId!,
        NOW,
        30_000,
      )
    ));
    const claims = await Promise.all([claim(), claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    await database.pool.query(
      `UPDATE provider_operations
          SET updated_at = $2
        WHERE organization_id = $1 AND id = $3`,
      [tenant.organizationId, new Date(NOW.getTime() - 30_001), created.operationId],
    );
    await expect(claim()).resolves.toMatchObject({ operation: { status: 'PENDING' } });
  });

  it('marca a operação de provisionamento como recuperável antes da chamada upstream', async () => {
    const repository = createPostgresInstanceRepository();
    const inserted = await withOrganizationTransaction(appPool, tenant.organizationId, (transaction) => (
      repository.insertProvisioning(transaction, {
        id: randomUUID(),
        organizationId: tenant.organizationId,
        providerAccountId: tenant.accountId,
        provider: 'BAILEYS',
        name: 'Crash window',
        upstreamInstanceKey: `jrc_${randomUUID().replaceAll('-', '')}`,
      })
    ));
    const operation = await oneRow<{ status: string; reconciliationRequired: boolean }>(
      database.pool,
      `SELECT status, reconciliation_required AS "reconciliationRequired"
         FROM provider_operations WHERE organization_id = $1 AND id = $2`,
      [tenant.organizationId, inserted.operation.id],
    );

    expect(operation).toEqual({ status: 'PENDING', reconciliationRequired: true });
  });
});
