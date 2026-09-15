import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry, type ConnectionAction } from '@jrc/providers';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import {
  createPostgresInstanceRepository,
  type InstanceRepository,
} from '../../src/modules/instances/repository.js';
import { createInstanceService, type InstanceService } from '../../src/modules/instances/service.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { ensureLogicalBaileysAccount } from '../../src/modules/provider-accounts/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

const REQUEST_ID = '8ecfc8d2-3a67-42db-a3de-24fc99aef758';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

describe('lease e fencing de conexão com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let provider: FakeProviderAdapter;
  let service: InstanceService;
  let organizationId: string;
  let ownerId: string;
  let accountId: string;
  let instanceId: string;

  function context() {
    return {
      credentialKind: 'JWT' as const,
      organizationId,
      actorId: ownerId,
      requestId: REQUEST_ID,
      deadline: new Date(Date.now() + 30_000),
      signal: new AbortController().signal,
    };
  }

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    const seeded = await runInAdminTransaction(database.pool, async (transaction) => {
      const organization = await createOrganization(transaction, {
        name: 'Connect lease',
        slug: `connect-lease-${randomUUID().slice(0, 8)}`,
      });
      const owner = await createUser(transaction, {
        email: `connect-${randomUUID()}@example.test`,
        passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organization.id, userId: owner.id });
      const account = await ensureLogicalBaileysAccount(transaction, organization.id);
      return { organizationId: organization.id, ownerId: owner.id, accountId: account.id };
    });
    ({ organizationId, ownerId, accountId } = seeded);
    appPool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
      max: 1,
    });
    provider = new FakeProviderAdapter();
    service = createInstanceService({
      repository: createPostgresInstanceRepository(),
      providers: new ProviderRegistry([provider], [['BAILEYS', provider]]),
      runInOrganizationTransaction: (tenantId, operation) => (
        withOrganizationTransaction(appPool, tenantId, operation)
      ),
      writeAudit: writeTenantAudit,
      connectLeaseMs: 60_000,
    });
    const created = await service.createInstance(context(), {
      name: 'Lease instance',
      provider: 'BAILEYS',
      providerAccountId: accountId,
      idempotencyKey: `create-${randomUUID()}`,
    });
    instanceId = created.instance.id;
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('libera pool max=1 durante HTTP e une concorrente à lease fresca', async () => {
    const original = provider.beginConnection.bind(provider);
    let release: ((action: ConnectionAction) => void) | undefined;
    provider.beginConnection = async (providerContext, input) => {
      await original(providerContext, input);
      return new Promise<ConnectionAction>((resolve) => { release = resolve; });
    };
    const first = service.connectInstance(context(), {
      instanceId,
      idempotencyKey: `first-${randomUUID()}`,
    });
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));

    const joined = await Promise.race([
      service.connectInstance(context(), {
        instanceId,
        idempotencyKey: `joined-${randomUUID()}`,
      }),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('connection remained checked out during provider HTTP')),
        2_000,
      )),
    ]);
    expect(joined).toMatchObject({
      pending: true,
      action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
    });
    expect(provider.calls.beginConnection).toHaveLength(1);

    release({
      type: 'PAIRING_CODE',
      code: '87654321',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(first).resolves.toMatchObject({ action: { type: 'PAIRING_CODE' } });
    provider.beginConnection = original;
  });

  it('preserva no PostgreSQL a lease de resultado incerto e não duplica beginConnection', async () => {
    const created = await service.createInstance(context(), {
      name: 'Uncertain connection instance',
      provider: 'BAILEYS',
      providerAccountId: accountId,
      idempotencyKey: `create-uncertain-${randomUUID()}`,
    });
    const original = provider.beginConnection.bind(provider);
    let firstCall = true;
    provider.beginConnection = async (...args) => {
      const response = await original(...args);
      if (firstCall) {
        firstCall = false;
        throw Object.assign(new Error('uncertain-provider-result'), { code: 'PROVIDER_TIMEOUT' });
      }
      return response;
    };
    const before = provider.calls.beginConnection.length;
    const command = {
      instanceId: created.instance.id,
      idempotencyKey: `timeout-first-${randomUUID()}`,
    };

    try {
      await expect(service.connectInstance(context(), command))
        .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });

      const persisted = await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
        const instanceResult = await transaction.query<{ status: string }>(
          `SELECT status FROM instances WHERE organization_id = $1 AND id = $2`,
          [organizationId, created.instance.id],
        );
        const operationResult = await transaction.query<{ status: string; canonicalErrorCode: string | null }>(
          `SELECT status, canonical_error_code AS "canonicalErrorCode"
             FROM provider_operations
            WHERE organization_id = $1 AND instance_id = $2 AND operation_type = 'CONNECT'
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [organizationId, created.instance.id],
        );
        return {
          instance: instanceResult.rows[0],
          operation: operationResult.rows[0],
        };
      });
      expect(persisted).toEqual({
        instance: { status: 'CONNECTING' },
        operation: { status: 'PENDING', canonicalErrorCode: 'PROVIDER_TIMEOUT' },
      });

      await expect(service.connectInstance(context(), command)).resolves.toMatchObject({
        replayed: true,
        pending: true,
        action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      });
      await expect(service.connectInstance(context(), {
        instanceId: created.instance.id,
        idempotencyKey: `timeout-second-${randomUUID()}`,
      })).resolves.toMatchObject({
        pending: true,
        action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      });
      expect(provider.calls.beginConnection).toHaveLength(before + 1);
    } finally {
      provider.beginConnection = original;
    }
  });

  it('preserva no PostgreSQL a lease de disconnect incerto e reproduz a mesma chave com segurança', async () => {
    const created = await service.createInstance(context(), {
      name: 'Uncertain disconnect instance',
      provider: 'BAILEYS',
      providerAccountId: accountId,
      idempotencyKey: `create-uncertain-disconnect-${randomUUID()}`,
    });
    await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
      await transaction.query(
        `UPDATE instances SET status = 'CONNECTED' WHERE organization_id = $1 AND id = $2`,
        [organizationId, created.instance.id],
      );
    });
    const originalDisconnect = provider.disconnect.bind(provider);
    let firstCall = true;
    provider.disconnect = async (...args) => {
      await originalDisconnect(...args);
      if (firstCall) {
        firstCall = false;
        throw Object.assign(new Error('uncertain-provider-result'), { code: 'PROVIDER_ABORTED' });
      }
    };
    const before = provider.calls.disconnect.length;
    const command = {
      instanceId: created.instance.id,
      idempotencyKey: `abort-disconnect-${randomUUID()}`,
    };

    try {
      await expect(service.disconnectInstance(context(), command))
        .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_FAILED', status: 502 });

      const persisted = await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
        const instanceResult = await transaction.query<{ status: string }>(
          `SELECT status FROM instances WHERE organization_id = $1 AND id = $2`,
          [organizationId, created.instance.id],
        );
        const operationResult = await transaction.query<{ status: string; canonicalErrorCode: string | null }>(
          `SELECT status, canonical_error_code AS "canonicalErrorCode"
             FROM provider_operations
            WHERE organization_id = $1 AND instance_id = $2 AND operation_type = 'DISCONNECT'
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [organizationId, created.instance.id],
        );
        const idempotencyResult = await transaction.query<{ status: string }>(
          `SELECT status FROM idempotency_records
            WHERE organization_id = $1 AND route = $2 AND idempotency_key = $3`,
          [
            organizationId,
            `/v1/instances/${created.instance.id}/disconnect`,
            command.idempotencyKey,
          ],
        );
        return {
          instance: instanceResult.rows[0],
          operation: operationResult.rows[0],
          idempotency: idempotencyResult.rows[0],
        };
      });
      expect(persisted).toEqual({
        instance: { status: 'DISCONNECTING' },
        operation: { status: 'PENDING', canonicalErrorCode: 'PROVIDER_ABORTED' },
        idempotency: { status: 'COMPLETED' },
      });

      await expect(service.getInstanceStatus(context(), created.instance.id))
        .resolves.toMatchObject({ status: 'DISCONNECTING' });
      await expect(service.disconnectInstance(context(), command)).resolves.toMatchObject({
        replayed: true,
        pending: true,
        instance: { status: 'DISCONNECTING' },
      });
      await expect(service.disconnectInstance(context(), {
        instanceId: created.instance.id,
        idempotencyKey: `joined-disconnect-${randomUUID()}`,
      })).resolves.toMatchObject({
        pending: true,
        instance: { status: 'DISCONNECTING' },
      });
      expect(provider.calls.disconnect).toHaveLength(before + 1);
    } finally {
      provider.disconnect = originalDisconnect;
    }
  });

  it('mantém ordem instance -> operation sob finalização e nova intenção concorrentes', async () => {
    const created = await service.createInstance(context(), {
      name: 'Lock order instance',
      provider: 'BAILEYS',
      providerAccountId: accountId,
      idempotencyKey: `create-lock-order-${randomUUID()}`,
    });
    const concurrentPool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
      max: 2,
    });
    const postgresRepository = createPostgresInstanceRepository();
    const operationLocked = deferred();
    const releaseCompletion = deferred();
    const secondInstanceAttempted = deferred();
    const secondInstanceAcquired = deferred();
    const releaseSecondAfterInstance = deferred();
    const secondOperationAttempted = deferred();
    const transactionsWithInstanceLock = new WeakSet<object>();
    let holdsOperationLock = false;
    let blockedCompletion = false;
    let lockOrderViolation = false;
    const repository: InstanceRepository = {
      ...postgresRepository,
      async findByIdForUpdate(transaction, tenantId, candidateId) {
        const belongsToSecond = holdsOperationLock;
        if (belongsToSecond) secondInstanceAttempted.resolve();
        const row = await postgresRepository.findByIdForUpdate(transaction, tenantId, candidateId);
        if (row) transactionsWithInstanceLock.add(transaction);
        if (belongsToSecond) {
          secondInstanceAcquired.resolve();
          await releaseSecondAfterInstance.promise;
        }
        return row;
      },
      async findPendingConnectOperationForUpdate(transaction, tenantId, candidateId) {
        if (holdsOperationLock) secondOperationAttempted.resolve();
        return postgresRepository.findPendingConnectOperationForUpdate(
          transaction,
          tenantId,
          candidateId,
        );
      },
      async updatePendingConnectOperation(transaction, input) {
        if (!transactionsWithInstanceLock.has(transaction)) lockOrderViolation = true;
        const updated = await postgresRepository.updatePendingConnectOperation(transaction, input);
        if (updated && !blockedCompletion) {
          blockedCompletion = true;
          holdsOperationLock = true;
          operationLocked.resolve();
          await releaseCompletion.promise;
        }
        return updated;
      },
    };
    const concurrentProvider = new FakeProviderAdapter({
      responses: {
        beginConnection: {
          type: 'PAIRING_CODE',
          code: '87654321',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const originalBeginConnection = concurrentProvider.beginConnection.bind(concurrentProvider);
    const releaseProvider = deferred<ConnectionAction>();
    let firstProviderCall = true;
    concurrentProvider.beginConnection = async (...args) => {
      const action = await originalBeginConnection(...args);
      if (!firstProviderCall) return action;
      firstProviderCall = false;
      return releaseProvider.promise;
    };
    const concurrentService = createInstanceService({
      repository,
      providers: new ProviderRegistry([concurrentProvider], [['BAILEYS', concurrentProvider]]),
      runInOrganizationTransaction: (tenantId, operation) => (
        withOrganizationTransaction(concurrentPool, tenantId, operation)
      ),
      writeAudit: writeTenantAudit,
      connectLeaseMs: 60_000,
    });

    try {
      const first = concurrentService.connectInstance(context(), {
        instanceId: created.instance.id,
        idempotencyKey: `lock-order-first-${randomUUID()}`,
      });
      while (concurrentProvider.calls.beginConnection.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      releaseProvider.resolve({
        type: 'PAIRING_CODE',
        code: '87654321',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await operationLocked.promise;

      const second = concurrentService.connectInstance(context(), {
        instanceId: created.instance.id,
        idempotencyKey: `lock-order-second-${randomUUID()}`,
      });
      await secondInstanceAttempted.promise;
      const acquiredBeforeRelease = await Promise.race([
        secondInstanceAcquired.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (acquiredBeforeRelease) {
        releaseSecondAfterInstance.resolve();
        await secondOperationAttempted.promise;
      } else {
        releaseSecondAfterInstance.resolve();
      }
      releaseCompletion.resolve();

      const settled = await Promise.race([
        Promise.allSettled([first, second]),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error('concurrent lock-order check timed out')),
          5_000,
        )),
      ]);
      expect(settled).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'fulfilled' }),
      ]);
      expect(lockOrderViolation).toBe(false);
    } finally {
      releaseProvider.resolve({ type: 'NONE', reason: 'CONNECTION_PENDING' });
      releaseSecondAfterInstance.resolve();
      releaseCompletion.resolve();
      await concurrentPool.end();
    }
  }, 15_000);

  it('preserva a lease fresca durante polling e bloqueia segunda chamada upstream', async () => {
    await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
      await transaction.query(
        `UPDATE instances SET status = 'CREATED' WHERE organization_id = $1 AND id = $2`,
        [organizationId, instanceId],
      );
    });
    provider.responses.getStatus = 'CREATED';
    const before = provider.calls.beginConnection.length;
    const original = provider.beginConnection.bind(provider);
    let releaseFirst: ((action: ConnectionAction) => void) | undefined;
    let firstCall = true;
    provider.beginConnection = async (providerContext, input) => {
      const action = await original(providerContext, input);
      if (!firstCall) return action;
      firstCall = false;
      return new Promise<ConnectionAction>((resolve) => { releaseFirst = resolve; });
    };
    const first = service.connectInstance(context(), {
      instanceId,
      idempotencyKey: `polling-owner-${randomUUID()}`,
    });
    while (!releaseFirst) await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      await expect(service.getInstanceStatus(context(), instanceId))
        .resolves.toMatchObject({ status: 'CONNECTING' });
      await expect(service.connectInstance(context(), {
        instanceId,
        idempotencyKey: `polling-joined-${randomUUID()}`,
      })).resolves.toMatchObject({
        pending: true,
        action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
      });
      expect(provider.calls.beginConnection).toHaveLength(before + 1);
    } finally {
      releaseFirst({
        type: 'PAIRING_CODE',
        code: '87654321',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await first;
      provider.beginConnection = original;
    }
  });

  it('uma lease expirada produz um único vencedor sob duas novas chaves', async () => {
    await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
      await transaction.query(
        `UPDATE instances SET status = 'CONNECTING' WHERE organization_id = $1 AND id = $2`,
        [organizationId, instanceId],
      );
      await transaction.query(
        `INSERT INTO provider_operations
           (organization_id, instance_id, operation_type, status, updated_at)
         VALUES ($1, $2, 'CONNECT', 'PENDING', now() - interval '2 minutes')`,
        [organizationId, instanceId],
      );
    });
    const before = provider.calls.beginConnection.length;
    const original = provider.beginConnection.bind(provider);
    let release: ((action: ConnectionAction) => void) | undefined;
    provider.beginConnection = async (providerContext, input) => {
      await original(providerContext, input);
      return new Promise<ConnectionAction>((resolve) => { release = resolve; });
    };
    const first = service.connectInstance(context(), {
      instanceId,
      idempotencyKey: `expired-a-${randomUUID()}`,
    });
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await service.connectInstance(context(), {
      instanceId,
      idempotencyKey: `expired-b-${randomUUID()}`,
    });
    expect(second.action).toEqual({ type: 'NONE', reason: 'CONNECTION_PENDING' });
    expect(provider.calls.beginConnection).toHaveLength(before + 1);
    release({ type: 'NONE', reason: 'CONNECTION_PENDING' });
    await first;
    provider.beginConnection = original;
  });

  it('descarta resposta tardia quando a operação perde o fencing', async () => {
    await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
      await transaction.query(
        `UPDATE instances SET status = 'AWAITING_ACTION' WHERE organization_id = $1 AND id = $2`,
        [organizationId, instanceId],
      );
    });
    const original = provider.beginConnection.bind(provider);
    let release: ((action: ConnectionAction) => void) | undefined;
    provider.beginConnection = async (providerContext, input) => {
      await original(providerContext, input);
      return new Promise<ConnectionAction>((resolve) => { release = resolve; });
    };
    const late = service.connectInstance(context(), {
      instanceId,
      idempotencyKey: `late-${randomUUID()}`,
    });
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
    await withOrganizationTransaction(appPool, organizationId, async (transaction) => {
      await transaction.query(
        `UPDATE provider_operations SET status = 'UNKNOWN'
          WHERE organization_id = $1 AND instance_id = $2
            AND operation_type = 'CONNECT' AND status = 'PENDING'`,
        [organizationId, instanceId],
      );
      await transaction.query(
        `INSERT INTO provider_operations
           (organization_id, instance_id, operation_type, status)
         VALUES ($1, $2, 'CONNECT', 'PENDING')`,
        [organizationId, instanceId],
      );
    });
    release({
      type: 'QR_CODE',
      encoding: 'BASE64',
      value: 'late-secret-must-be-discarded',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await late;
    expect(result.action).toEqual({ type: 'NONE', reason: 'CONNECTION_PENDING' });
    expect(JSON.stringify(result)).not.toContain('late-secret-must-be-discarded');
    provider.beginConnection = original;
  });
});
