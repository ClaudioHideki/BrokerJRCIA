import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPostgresInstanceRepository } from '../../src/modules/instances/repository.js';
import { createChallengeStore } from '../../src/modules/instances/challenges.js';
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

const SECRET = 'challenge-secret-dedicated-to-aes-gcm-testing';
let now = new Date('2030-01-01T00:00:00.000Z');

describe('armazenamento de desafios de conexão', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let organizationId: string;
  let otherOrganizationId: string;
  let instanceId: string;
  let operationId: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    const seeded = await runInAdminTransaction(database.pool, async (transaction) => {
      async function tenant(slug: string) {
        const organization = await createOrganization(transaction, { name: slug, slug });
        const user = await createUser(transaction, {
          email: `${slug}@example.test`, passwordHash: 'argon2id-test-hash',
        });
        await createOwnerMembership(transaction, { organizationId: organization.id, userId: user.id });
        const account = await ensureLogicalBaileysAccount(transaction, organization.id);
        return { organization, account };
      }
      return { first: await tenant('challenge-a'), second: await tenant('challenge-b') };
    });
    organizationId = seeded.first.organization.id;
    otherOrganizationId = seeded.second.organization.id;
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    const repository = createPostgresInstanceRepository();
    const created = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      repository.insertProvisioning(transaction, {
        id: '1f8cfcb9-51ef-4ddd-9da5-7b523d825934',
        organizationId,
        providerAccountId: seeded.first.account.id,
        provider: 'BAILEYS',
        name: 'challenge-fixture',
        upstreamInstanceKey: 'jrc_1f8cfcb951ef4ddd9da57b523d825934',
      })
    ));
    instanceId = created.instance.id;
    operationId = created.operation.id;
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('persiste AES-256-GCM com nonce aleatório, TTL curto e sem plaintext', async () => {
    const store = createChallengeStore({ encryptionSecret: SECRET, now: () => now, ttlMs: 30_000 });
    const action = {
      type: 'QR_CODE' as const,
      encoding: 'BASE64' as const,
      value: 'plaintext-qr-canary',
      expiresAt: '2030-01-01T00:01:00.000Z',
    };
    const ids = await withOrganizationTransaction(appPool, organizationId, async (transaction) => [
      await store.store(transaction, { organizationId, instanceId, operationId, action }),
      await store.store(transaction, { organizationId, instanceId, operationId, action }),
    ]);
    const raw = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      transaction.query<{
        algorithm: string; ciphertext: string; nonce: string; authTag: string; expiresAt: Date;
      }>(`SELECT algorithm, ciphertext, nonce, auth_tag AS "authTag", expires_at AS "expiresAt"
             FROM connection_challenges WHERE organization_id = $1 AND id = ANY($2::uuid[])
             ORDER BY id`, [organizationId, ids])
    ));

    expect(raw.rows).toHaveLength(2);
    expect(raw.rows.every((row) => row.algorithm === 'AES-256-GCM')).toBe(true);
    expect(raw.rows[0]?.nonce).not.toBe(raw.rows[1]?.nonce);
    expect(JSON.stringify(raw.rows)).not.toContain(action.value);
    expect(raw.rows.every((row) => row.expiresAt.toISOString() === '2030-01-01T00:00:30.000Z')).toBe(true);
  });

  it('consome uma única vez de forma atômica sob concorrência', async () => {
    const store = createChallengeStore({ encryptionSecret: SECRET, now: () => now, ttlMs: 30_000 });
    const action = {
      type: 'PAIRING_CODE' as const,
      code: '1234-5678',
      expiresAt: '2030-01-01T00:01:00.000Z',
    };
    const challengeId = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      store.store(transaction, { organizationId, instanceId, operationId, action })
    ));
    const consume = () => withOrganizationTransaction(appPool, organizationId, (transaction) => (
      store.consume(transaction, { organizationId, instanceId, operationId, challengeId })
    ));
    const consumed = await Promise.all([consume(), consume()]);

    expect(consumed.filter((value) => value !== null)).toEqual([action]);
    expect(consumed.filter((value) => value === null)).toHaveLength(1);
  });

  it('vincula organização, instância e operação e remove desafios expirados', async () => {
    const store = createChallengeStore({ encryptionSecret: SECRET, now: () => now, ttlMs: 1_000 });
    const action = {
      type: 'QR_CODE' as const,
      encoding: 'BASE64' as const,
      value: 'binding-canary',
      expiresAt: '2030-01-01T00:01:00.000Z',
    };
    const challengeId = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      store.store(transaction, { organizationId, instanceId, operationId, action })
    ));

    const foreign = await withOrganizationTransaction(appPool, otherOrganizationId, (transaction) => (
      store.consume(transaction, {
        organizationId: otherOrganizationId, instanceId, operationId, challengeId,
      })
    ));
    expect(foreign).toBeNull();

    now = new Date('2030-01-01T00:00:02.000Z');
    const expired = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      store.consume(transaction, { organizationId, instanceId, operationId, challengeId })
    ));
    expect(expired).toBeNull();
    const remaining = await withOrganizationTransaction(appPool, organizationId, (transaction) => (
      transaction.query(`SELECT id FROM connection_challenges WHERE organization_id = $1 AND id = $2`, [
        organizationId, challengeId,
      ])
    ));
    expect(remaining.rows).toHaveLength(0);
  });
});
