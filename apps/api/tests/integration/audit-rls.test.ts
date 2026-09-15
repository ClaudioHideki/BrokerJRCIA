import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import { writeTenantAudit } from '../../src/modules/audit/audit.js';
import { createAuditDigest, createSecurityAuditWriter } from '../../src/modules/audit/security-audit.js';
import { createDatabasePools, type DatabasePools } from '../../src/db/pools.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';

interface TenantFixture {
  organizationId: string;
  actorId: string;
}

const IDENTITY_DIGEST = createAuditDigest('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
const IP_DIGEST = createAuditDigest('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');

function connectionStringForRole(connectionString: string, role: 'jrc_app' | 'jrc_auth'): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = '';
  return url.toString();
}

async function seedTenant(client: PoolClient, slug: string): Promise<TenantFixture> {
  await client.query('BEGIN');
  try {
    const organization = await oneRow<{ id: string }>(
      client,
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      [`Audit ${slug}`, slug],
    );
    const actor = await oneRow<{ id: string }>(
      client,
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [`audit-${slug}@example.test`, 'argon2id-test-hash'],
    );
    await client.query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
      [organization.id, actor.id],
    );
    await client.query('COMMIT');
    return { organizationId: organization.id, actorId: actor.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('auditoria pré-auth e tenant-aware no runtime', () => {
  let database: IsolatedPostgresDatabase;
  let pools: DatabasePools;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    pools = createDatabasePools({
      app: { connectionString: connectionStringForRole(database.connectionString, 'jrc_app'), max: 1 },
      auth: { connectionString: connectionStringForRole(database.connectionString, 'jrc_auth'), max: 1 },
    });

    const client = await database.pool.connect();
    try {
      tenantA = await seedTenant(client, 'tenant-a');
      tenantB = await seedTenant(client, 'tenant-b');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pools.close();
    await database.dispose();
  });

  it('grava eventos pré-auth e tenant-aware em tabelas separadas', async () => {
    const writeSecurityAudit = createSecurityAuditWriter(pools.authPool);
    const requestId = '1cc11c7f-93dd-4fcb-bb43-83f447a52973';
    const resourceId = '4e6310a3-2f86-4ff9-b018-7991ed763990';

    await writeSecurityAudit({
      type: 'AUTH_RATE_LIMITED',
      requestId,
      identityDigest: IDENTITY_DIGEST,
      ipDigest: IP_DIGEST,
    });
    await withOrganizationTransaction(pools.appPool, tenantA.organizationId, async (transaction) => {
      await writeTenantAudit(transaction, {
        type: 'INSTANCE_CREATED',
        organizationId: tenantA.organizationId,
        actorId: tenantA.actorId,
        resourceId,
        requestId,
      });
    });

    const securityAudit = await oneRow<{
      eventType: string;
      requestId: string;
      identityDigest: string;
      ipDigest: string;
      outcome: string;
    }>(
      database.pool,
      `SELECT event_type AS "eventType", request_id AS "requestId",
              identity_digest AS "identityDigest", ip_digest AS "ipDigest", outcome
         FROM security_audit_logs`,
    );
    const tenantAudit = await oneRow<{
      organizationId: string;
      actorId: string;
      eventType: string;
      resourceId: string;
      requestId: string;
      outcome: string;
    }>(
      database.pool,
      `SELECT organization_id AS "organizationId", actor_id AS "actorId",
              event_type AS "eventType", resource_id AS "resourceId",
              request_id AS "requestId", outcome
         FROM audit_logs`,
    );

    expect(securityAudit).toEqual({
      eventType: 'AUTH_RATE_LIMITED',
      requestId,
      identityDigest: IDENTITY_DIGEST,
      ipDigest: IP_DIGEST,
      outcome: 'DENIED',
    });
    expect(tenantAudit).toEqual({
      organizationId: tenantA.organizationId,
      actorId: tenantA.actorId,
      eventType: 'INSTANCE_CREATED',
      resourceId,
      requestId,
      outcome: 'SUCCESS',
    });
  });

  it('não permite que tenant B leia ou grave a auditoria do tenant A', async () => {
    await expect(withOrganizationTransaction(
      pools.appPool,
      tenantB.organizationId,
      async (transaction) => transaction.query('SELECT id FROM audit_logs'),
    )).rejects.toThrow(/permission denied/i);

    await expect(withOrganizationTransaction(
      pools.appPool,
      tenantB.organizationId,
      async (transaction) => writeTenantAudit(transaction, {
        type: 'INSTANCE_CREATED',
        organizationId: tenantA.organizationId,
        actorId: tenantA.actorId,
        resourceId: '5d3b93b2-4d8d-4ca6-b7a1-742a4070acc4',
        requestId: '9b797ba7-f4d1-4cb0-835a-1d1d5a2b7b78',
      }),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('nega o writer jrc_app sem contexto tenant e não cria linha', async () => {
    const before = await oneRow<{ count: number }>(
      database.pool,
      'SELECT count(*)::int AS count FROM audit_logs',
    );
    const client = await pools.appPool.connect();
    try {
      await client.query('BEGIN');
      await expect(writeTenantAudit(
        client as unknown as import('../../src/db/tenant-transaction.js').TenantTransaction,
        {
          type: 'INSTANCE_CREATED',
          organizationId: tenantA.organizationId,
          actorId: tenantA.actorId,
          resourceId: 'f9431422-006f-452a-b04b-5be82ee04163',
          requestId: 'd7cb72aa-9bbb-429a-afca-6b6e5730b995',
        },
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const after = await oneRow<{ count: number }>(
      database.pool,
      'SELECT count(*)::int AS count FROM audit_logs',
    );
    expect(after.count).toBe(before.count);
  });
});
