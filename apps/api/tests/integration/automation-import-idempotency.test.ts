import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { createAutomationImporter } from '../../src/modules/automation-integrations/importer.js';
import { createIsolatedPostgresDatabase, requireTestDatabaseAdminUrl, type IsolatedPostgresDatabase } from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

describe('idempotência PostgreSQL da confirmação de importação', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let org: string;
  let otherOrg: string;
  let importer: ReturnType<typeof createAutomationImporter>;
  const content = JSON.stringify({ format: 'jrc-flows/1', flow: { name: 'Atendimento', graph: welcomeFlow() } });

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    [org, otherOrg] = await runInAdminTransaction(database.pool, async tx => {
      const first = await createOrganization(tx, { name: 'Import One', slug: 'import-one' });
      const second = await createOrganization(tx, { name: 'Import Two', slug: 'import-two' });
      const firstOwner = await createUser(tx, { email: 'import-one@example.test', passwordHash: 'argon2id-test-hash' });
      const secondOwner = await createUser(tx, { email: 'import-two@example.test', passwordHash: 'argon2id-test-hash' });
      await createOwnerMembership(tx, { organizationId: first.id, userId: firstOwner.id });
      await createOwnerMembership(tx, { organizationId: second.id, userId: secondOwner.id });
      await tx.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)',[first.id,second.id]);
      return [first.id, second.id];
    });
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app') });
    importer = createAutomationImporter({
      transact: (organizationId, operation) => withOrganizationTransaction(appPool, organizationId, operation),
      keyring: JSON.stringify({ 1: Buffer.alloc(32, 8).toString('base64') }), enabled: true,
    });
  }, 60_000);

  afterAll(async () => { await appPool?.end(); await database?.dispose(); });

  it('confirma uma vez sob duas requisições concorrentes e reapresenta o mesmo artefato', async () => {
    const input = { source: 'AUTO' as const, content };
    const [first, replay] = await Promise.all([
      importer.import(org, input, 'same-confirmation'), importer.import(org, input, 'same-confirmation'),
    ]);
    expect(replay.id).toBe(first.id);
    expect(replay.graph).toEqual(first.graph);
    expect(replay.report).toEqual(first.report);
    const artifacts = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_import_artifacts WHERE organization_id=$1', [org],
    );
    expect(artifacts.rows[0]?.count).toBe('1');
    const metadata = await database.pool.query<{ response_metadata: Record<string, unknown> }>(
      "SELECT response_metadata FROM idempotency_records WHERE organization_id=$1 AND route='POST /v1/automation-imports'",
      [org],
    );
    expect(metadata.rows).toHaveLength(1);
    expect(metadata.rows[0]?.response_metadata).toEqual({ artifactId: first.id });
    expect(JSON.stringify(metadata.rows)).not.toContain('Atendimento');
    expect(JSON.stringify(metadata.rows)).not.toContain('encrypted_original');
  });

  it('rejeita outra carga com a mesma chave sem criar novo artefato', async () => {
    await expect(importer.import(org, { source: 'AUTO', content: JSON.stringify({
      format: 'jrc-flows/1', flow: { name: 'Outro', graph: welcomeFlow() },
    }) }, 'same-confirmation')).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const result = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_import_artifacts WHERE organization_id=$1', [org],
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('isola a mesma chave de confirmação entre empresas', async () => {
    const result = await importer.import(otherOrg, { source: 'AUTO', content }, 'same-confirmation');
    expect(result.createdAsDraft).toBe(true);
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM automation_import_artifacts WHERE organization_id=$1', [otherOrg],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });
});
