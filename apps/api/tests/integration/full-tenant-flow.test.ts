import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeProviderAdapter, ProviderRegistry } from '@jrc/providers';
import { initializePasswordVerifier } from '@jrc/security';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { createApiKeyService } from '../../src/modules/api-keys/service.js';
import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createSecurityAuditWriter } from '../../src/modules/audit/security-audit.js';
import { createLoginService } from '../../src/modules/auth/login.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';
import { createRefreshSessionService } from '../../src/modules/auth/refresh.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import { createSelectOrganizationService } from '../../src/modules/auth/select-organization.js';
import { createChallengeStore } from '../../src/modules/instances/challenges.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createInstanceService } from '../../src/modules/instances/service.js';
import { removeMembership, setMembershipRole } from '../../src/modules/memberships/repository.js';
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
} from './helpers/task7.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const REQUEST_ID = '68144bd7-686b-442c-9f91-940a079a1a2a';
const COMMIT_REQUEST_ID = '2ff58bac-b86d-4581-b3f1-4760e24df234';
const JWT_SECRET = 'full-flow-jwt-secret-with-at-least-32-bytes';
const REFRESH_SECRET = 'full-flow-refresh-secret-with-at-least-32-bytes';
const API_KEY_SECRET = 'full-flow-api-key-secret-with-at-least-32-bytes';
const RATE_IP_SECRET = 'full-flow-ip-rate-secret-with-at-least-32-bytes';
const RATE_IDENTITY_SECRET = 'full-flow-identity-secret-with-at-least-32-bytes';
const CHALLENGE_SECRET = 'full-flow-challenge-secret-with-at-least-32-bytes';
const OWNER_A_PASSWORD = 'FullFlowOwnerA!234';

function roleConnectionString(connectionString: string, role: 'jrc_app' | 'jrc_auth'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe('fluxo PostgreSQL multitenant consolidado', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let authPool: Pool;
  let ownerA: { organizationId: string; ownerUserId: string; providerAccountId: string };
  let ownerB: { organizationId: string; ownerUserId: string; providerAccountId: string };

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    ownerA = await createRealBootstrap(database.pool)({
      organizationName: 'Full Flow A',
      organizationSlug: 'full-flow-a',
      email: 'full-flow-a@example.test',
      password: OWNER_A_PASSWORD,
      requestId: REQUEST_ID,
    });
    ownerB = await createRealTenantCreator(database.pool)({
      ownerMode: 'CREATE_NEW',
      administrativeCredential: ADMIN_CREDENTIAL,
      organizationName: 'Full Flow B',
      organizationSlug: 'full-flow-b',
      ownerEmail: 'full-flow-b@example.test',
      ownerPassword: 'FullFlowOwnerB!234',
      requestId: REQUEST_ID,
    });
    appPool = new Pool({
      connectionString: roleConnectionString(database.connectionString, 'jrc_app'),
      max: 4,
    });
    authPool = new Pool({
      connectionString: roleConnectionString(database.connectionString, 'jrc_auth'),
      max: 4,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([appPool?.end(), authPool?.end()]);
    await database?.dispose();
  });

  it('autentica, seleciona tenant, emite API key e opera instância com FakeProvider isolado', async () => {
    const authRepository = createPostgresAuthRepository(authPool);
    const passwordVerifier = await initializePasswordVerifier();
    const securityAudit = createSecurityAuditWriter(authPool);
    const rateLimitStore = new MemoryRateLimitStore(() => NOW.getTime());
    const login = createLoginService({
      repository: authRepository,
      passwordVerifier,
      rateLimitStore,
      writeSecurityAudit: securityAudit,
      ipRateLimitHmacSecret: RATE_IP_SECRET,
      identityRateLimitHmacSecret: RATE_IDENTITY_SECRET,
      now: () => NOW,
      sleeper: async () => undefined,
    });
    const organizations = await login({
      email: ' FULL-FLOW-A@example.test ',
      password: OWNER_A_PASSWORD,
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    });
    expect(organizations.organizations).toEqual([
      expect.objectContaining({ id: ownerA.organizationId, slug: 'full-flow-a' }),
    ]);

    const selectOrganization = createSelectOrganizationService({
      repository: authRepository,
      jwtSecret: JWT_SECRET,
      refreshTokenHashSecret: REFRESH_SECRET,
      rateLimitStore,
      ipRateLimitHmacSecret: RATE_IP_SECRET,
      identityRateLimitHmacSecret: RATE_IDENTITY_SECRET,
      writeSecurityAudit: securityAudit,
      writeOrganizationSelectedAudit: async (event) => withOrganizationTransaction(
        appPool,
        event.organizationId,
        (transaction) => writeTenantAudit(transaction, { type: 'ORGANIZATION_SELECTED', ...event }),
      ),
      now: () => NOW,
      sleeper: async () => undefined,
    });
    const tokens = await selectOrganization({
      organizationId: ownerA.organizationId,
      selectionToken: organizations.selectionToken,
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    });
    expect(tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });

    const apiKeys = createApiKeyService({
      repository: createPostgresApiKeyRepository(),
      hmacSecret: API_KEY_SECRET,
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
      now: () => NOW,
    });
    const apiKey = await apiKeys.issueApiKey({
      credentialKind: 'JWT',
      organizationId: ownerA.organizationId,
      actorId: ownerA.ownerUserId,
      requestId: REQUEST_ID,
    }, { name: 'full-flow', scopes: ['instances:read', 'instances:write'], expiresAt: null });
    await expect(apiKeys.authenticateApiKey(apiKey.secret)).resolves.toMatchObject({
      apiKeyId: apiKey.id,
      organizationId: ownerA.organizationId,
    });

    const provider = new FakeProviderAdapter({
      now: () => NOW,
      responses: {
        beginConnection: {
          type: 'QR_CODE',
          encoding: 'BASE64',
          value: 'full-flow-qr-plaintext-canary',
          expiresAt: '2030-01-01T12:01:00.000Z',
        },
      },
    });
    const instances = createInstanceService({
      repository: createPostgresInstanceRepository(),
      providers: new ProviderRegistry([provider], [['BAILEYS', provider]]),
      runInOrganizationTransaction: (organizationId, operation) => (
        withOrganizationTransaction(appPool, organizationId, operation)
      ),
      writeAudit: writeTenantAudit,
      now: () => NOW,
    });
    const context = {
      credentialKind: 'API_KEY' as const,
      organizationId: ownerA.organizationId,
      actorId: null,
      apiKeyId: apiKey.id,
      requestId: REQUEST_ID,
      deadline: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    };
    const created = await instances.createInstance(context, {
      name: 'Full Flow Instance',
      provider: 'BAILEYS',
      providerAccountId: ownerA.providerAccountId,
      idempotencyKey: 'full-flow-create',
    });
    expect(created.instance.status).toBe('CREATED');

    const [firstConnect, replayConnect] = await Promise.all([
      instances.connectInstance(context, {
        instanceId: created.instance.id,
        idempotencyKey: 'full-flow-connect',
      }),
      instances.connectInstance(context, {
        instanceId: created.instance.id,
        idempotencyKey: 'full-flow-connect',
      }),
    ]);
    expect([firstConnect, replayConnect].filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect([firstConnect, replayConnect].find(({ replayed }) => replayed)?.action)
      .toEqual({ type: 'NONE', reason: 'CONNECTION_PENDING' });
    expect(provider.calls.beginConnection).toHaveLength(1);

    const ownPage = await instances.listInstances(context, { limit: 20 });
    expect(ownPage.data).toContainEqual(expect.objectContaining({ id: created.instance.id }));
    const tenantBContext = {
      ...context,
      organizationId: ownerB.organizationId,
      actorId: null,
      apiKeyId: '0e9a2cf1-a2aa-43cd-995b-6a29f92c737f',
    };
    await expect(instances.listInstances(tenantBContext, { limit: 20 })).resolves.toMatchObject({ data: [] });
    const beforeProviderCalls = provider.calls.getStatus.length;
    await expect(instances.getInstanceStatus(tenantBContext, created.instance.id))
      .rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
    expect(provider.calls.getStatus).toHaveLength(beforeProviderCalls);

    const challengeResult = [firstConnect, replayConnect].find(({ replayed }) => !replayed)!;
    expect(challengeResult.action.type).toBe('QR_CODE');
    if (challengeResult.action.type === 'NONE') throw new Error('Expected a connection challenge');
    const challenges = createChallengeStore({
      encryptionSecret: CHALLENGE_SECRET,
      now: () => NOW,
      ttlMs: 30_000,
    });
    const challengeId = await withOrganizationTransaction(appPool, ownerA.organizationId, (transaction) => (
      challenges.store(transaction, {
        organizationId: ownerA.organizationId,
        instanceId: created.instance.id,
        operationId: challengeResult.operationId!,
        action: challengeResult.action,
      })
    ));
    const raw = await oneRow<{ ciphertext: string }>(database.pool,
      'SELECT ciphertext FROM connection_challenges WHERE id = $1', [challengeId]);
    expect(raw.ciphertext).not.toContain('full-flow-qr-plaintext-canary');
    const consume = () => withOrganizationTransaction(appPool, ownerA.organizationId, (transaction) => (
      challenges.consume(transaction, {
        organizationId: ownerA.organizationId,
        instanceId: created.instance.id,
        operationId: challengeResult.operationId!,
        challengeId,
      })
    ));
    const consumption = await Promise.all([consume(), consume()]);
    expect(consumption.filter(Boolean)).toHaveLength(1);
    expect(consumption.filter((value) => value === null)).toHaveLength(1);

    const refresh = createRefreshSessionService({
      repository: authRepository,
      jwtSecret: JWT_SECRET,
      refreshTokenHashSecret: REFRESH_SECRET,
      writeSecurityAudit: securityAudit,
      now: () => NOW,
    });
    const rotations = await Promise.allSettled([
      refresh(tokens.refreshToken, REQUEST_ID),
      refresh(tokens.refreshToken, REQUEST_ID),
    ]);
    expect(rotations.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(rotations.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  }, 60_000);

  it('mantém RLS deny-by-default, rollback e constraints compostas no mesmo banco', async () => {
    const withoutContext = await appPool.query<{ count: number; organizationId: string | null }>(
      `SELECT count(*)::int AS count,
              nullif(current_setting('app.organization_id', true), '') AS "organizationId"
         FROM instances`,
    );
    expect(withoutContext.rows[0]).toEqual({ count: 0, organizationId: null });

    await expect(withOrganizationTransaction(appPool, ownerA.organizationId, async (transaction) => {
      await transaction.query(
        `INSERT INTO audit_logs
           (organization_id, actor_id, event_type, resource_type, request_id, outcome, metadata)
         VALUES ($1, $2, 'INSTANCE_CREATED', 'INSTANCE', $3, 'SUCCESS', '{}')`,
        [ownerA.organizationId, ownerA.ownerUserId, REQUEST_ID],
      );
      throw new Error('rollback-canary');
    })).rejects.toThrow('rollback-canary');
    const rolledBack = await oneRow<{ count: number }>(database.pool,
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE organization_id = $1 AND request_id = $2 AND resource_id IS NULL`,
      [ownerA.organizationId, REQUEST_ID]);
    expect(rolledBack.count).toBe(0);

    await expect(database.pool.query(
      `INSERT INTO instances
         (organization_id, provider_account_id, name, upstream_instance_key, status)
       VALUES ($1, $2, 'cross-tenant-invalid', 'jrc_cross_tenant_invalid', 'CREATED')`,
      [ownerA.organizationId, ownerB.providerAccountId],
    )).rejects.toMatchObject({ code: '23503', constraint: 'instances_provider_account_fk' });
  });

  it('consolida commit, RLS CRUD cruzado e limpeza de contexto na mesma conexão do pool', async () => {
    const singleConnectionPool = new Pool({
      connectionString: roleConnectionString(database.connectionString, 'jrc_app'),
      max: 1,
    });
    let tenantAPid = 0;
    let tenantAInstanceId = '';
    let tenantBInstanceId = '';

    try {
      await withOrganizationTransaction(singleConnectionPool, ownerA.organizationId, async (transaction) => {
        tenantAPid = await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          .then(({ rows }) => rows[0]!.pid);
        tenantAInstanceId = await transaction.query<{ id: string }>(
          `INSERT INTO instances
             (organization_id, provider_account_id, name, upstream_instance_key, status)
           VALUES ($1, $2, 'tenant-a-own', 'jrc_full_flow_tenant_a', 'CREATED')
           RETURNING id`,
          [ownerA.organizationId, ownerA.providerAccountId],
        ).then(({ rows }) => rows[0]!.id);
        const update = await transaction.query(
          `UPDATE instances SET name = 'tenant-a-updated'
            WHERE organization_id = $1 AND id = $2`,
          [ownerA.organizationId, tenantAInstanceId],
        );
        expect(update.rowCount).toBe(1);
        await transaction.query(
          `INSERT INTO audit_logs
             (organization_id, actor_id, event_type, resource_type, resource_id,
              request_id, outcome, metadata)
           VALUES ($1, $2, 'INSTANCE_CREATED', 'INSTANCE', $3, $4, 'SUCCESS', '{}')`,
          [ownerA.organizationId, ownerA.ownerUserId, tenantAInstanceId, COMMIT_REQUEST_ID],
        );
      });

      expect(await oneRow<{ count: number }>(database.pool,
        `SELECT count(*)::int AS count FROM audit_logs
          WHERE organization_id = $1 AND request_id = $2`,
        [ownerA.organizationId, COMMIT_REQUEST_ID])).toEqual({ count: 1 });

      await withOrganizationTransaction(singleConnectionPool, ownerB.organizationId, async (transaction) => {
        tenantBInstanceId = await transaction.query<{ id: string }>(
          `INSERT INTO instances
             (organization_id, provider_account_id, name, upstream_instance_key, status)
           VALUES ($1, $2, 'tenant-b-own', 'jrc_full_flow_tenant_b', 'CREATED')
           RETURNING id`,
          [ownerB.organizationId, ownerB.providerAccountId],
        ).then(({ rows }) => rows[0]!.id);
      });

      await withOrganizationTransaction(singleConnectionPool, ownerA.organizationId, async (transaction) => {
        expect((await transaction.query(
          'UPDATE instances SET name = $1 WHERE id = $2',
          ['cross-tenant-update', tenantBInstanceId],
        )).rowCount).toBe(0);
        expect((await transaction.query(
          'DELETE FROM instances WHERE id = $1',
          [tenantBInstanceId],
        )).rowCount).toBe(0);
      });
      await expect(withOrganizationTransaction(
        singleConnectionPool,
        ownerA.organizationId,
        (transaction) => transaction.query(
          `INSERT INTO instances
             (organization_id, provider_account_id, name, upstream_instance_key, status)
           VALUES ($1, $2, 'cross-tenant-insert', 'jrc_full_flow_cross_insert', 'CREATED')`,
          [ownerB.organizationId, ownerB.providerAccountId],
        ),
      )).rejects.toMatchObject({ code: '42501' });

      await withOrganizationTransaction(singleConnectionPool, ownerB.organizationId, async (transaction) => {
        expect(await transaction.query<{ name: string }>(
          'SELECT name FROM instances WHERE id = $1',
          [tenantBInstanceId],
        ).then(({ rows }) => rows)).toEqual([{ name: 'tenant-b-own' }]);
      });

      await withOrganizationTransaction(singleConnectionPool, ownerA.organizationId, async (transaction) => {
        expect((await transaction.query(
          'DELETE FROM instances WHERE id = $1',
          [tenantAInstanceId],
        )).rowCount).toBe(1);
      });

      const withoutContext = await singleConnectionPool.query<{
        count: number;
        organizationId: string | null;
        pid: number;
      }>(
        `SELECT count(*)::int AS count,
                nullif(current_setting('app.organization_id', true), '') AS "organizationId",
                pg_backend_pid() AS pid
           FROM instances`,
      );
      expect(withoutContext.rows[0]).toEqual({
        count: 0,
        organizationId: null,
        pid: tenantAPid,
      });
    } finally {
      await singleConnectionPool.end();
    }
  }, 60_000);

  it('serializa remoção/rebaixamento concorrente e nunca deixa a organização sem OWNER', async () => {
    const secondOwnerId = await database.pool.query<{ id: string }>(
      `WITH created AS (
         INSERT INTO users (email, password_hash)
         VALUES ('full-flow-second-owner@example.test', 'argon2id-test-hash') RETURNING id
       )
       INSERT INTO memberships (organization_id, user_id, role)
       SELECT $1, id, 'OWNER' FROM created RETURNING user_id AS id`,
      [ownerA.organizationId],
    ).then(({ rows }) => rows[0]!.id);
    let ready = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    const synchronize = async () => {
      ready += 1;
      if (ready === 2) release();
      await bothReady;
    };
    const settled = await Promise.allSettled([
      withOrganizationTransaction(appPool, ownerA.organizationId, async (transaction) => {
        await removeMembership(transaction, {
          organizationId: ownerA.organizationId,
          userId: ownerA.ownerUserId,
        });
        await synchronize();
      }),
      withOrganizationTransaction(appPool, ownerA.organizationId, async (transaction) => {
        await setMembershipRole(transaction, {
          organizationId: ownerA.organizationId,
          userId: secondOwnerId,
          role: 'ADMIN',
        });
        await synchronize();
      }),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const owners = await oneRow<{ count: number }>(database.pool,
      `SELECT count(*)::int AS count FROM memberships
        WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
      [ownerA.organizationId]);
    expect(owners.count).toBe(1);
  });
});
