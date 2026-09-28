import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('idempotência PostgreSQL da criação de automações', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let organizationId: string;
  let otherOrganizationId: string;
  let service: ReturnType<typeof createAutomationService>;
  const input = { name: 'Atendimento', graph: welcomeFlow() };

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    [organizationId, otherOrganizationId] = await runInAdminTransaction(database.pool, async tx => {
      const first = await createOrganization(tx, { name: 'Automation One', slug: 'automation-one' });
      const second = await createOrganization(tx, { name: 'Automation Two', slug: 'automation-two' });
      const firstOwner = await createUser(tx, { email: 'automation-one@example.test', passwordHash: 'argon2id-test-hash' });
      const secondOwner = await createUser(tx, { email: 'automation-two@example.test', passwordHash: 'argon2id-test-hash' });
      await createOwnerMembership(tx, { organizationId: first.id, userId: firstOwner.id });
      await createOwnerMembership(tx, { organizationId: second.id, userId: secondOwner.id });
      return [first.id, second.id];
    });
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    service = createAutomationService({ transact: (org, operation) => withOrganizationTransaction(appPool, org, operation) });
  }, 60_000);

  afterAll(async () => { await appPool?.end(); await database?.dispose(); });

  it('cria uma única definição sob duas chamadas concorrentes com a mesma chave e corpo', async () => {
    const [first, replay] = await Promise.all([
      service.create(organizationId, input, 'retry-create'),
      service.create(organizationId, input, 'retry-create'),
    ]);
    expect(replay.id).toBe(first.id);
    expect(replay.draft.graph).toEqual(first.draft.graph);
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_definitions WHERE organization_id=$1', [organizationId],
    );
    expect(rows.rows[0]?.count).toBe('1');
    const records = await database.pool.query<{ response_metadata: Record<string, unknown> }>(
      "SELECT response_metadata FROM idempotency_records WHERE organization_id=$1 AND route='POST /v1/automations'",
      [organizationId],
    );
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]?.response_metadata).toEqual({ definitionId: first.id });
  });

  it('retorna conflito para a mesma chave com outro corpo sem criar definição', async () => {
    await expect(service.create(organizationId, { ...input, name: 'Outro atendimento' }, 'retry-create'))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_definitions WHERE organization_id=$1', [organizationId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('mantém a mesma chave isolada entre empresas', async () => {
    const other = await service.create(otherOrganizationId, input, 'retry-create');
    const first = await service.create(organizationId, input, 'retry-create');
    expect(other.id).not.toBe(first.id);
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_definitions WHERE organization_id=$1', [otherOrganizationId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });
});
