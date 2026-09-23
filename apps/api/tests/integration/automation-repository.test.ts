import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('Automation repository claims', () => {
  let database: IsolatedPostgresDatabase;
  let pool: Pool;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    pool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.dispose();
  });

  it('returns no execution instead of PostgreSQL 42702 when the queue is empty', async () => {
    const organizationId = randomUUID();
    const repository = createPostgresAutomationRepository();

    await expect(
      withOrganizationTransaction(pool, organizationId, (transaction) =>
        repository.claimExecution(transaction, organizationId, randomUUID(), 30_000)),
    ).resolves.toBeNull();
  });
});
