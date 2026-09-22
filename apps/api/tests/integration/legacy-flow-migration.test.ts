import { randomUUID } from 'node:crypto';

import { welcomeFlow } from '@jrc/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createLegacyFlowMigrationService } from '../../src/modules/automations/legacy-migration.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('legacy flow reconciliation', () => {
  let database: IsolatedPostgresDatabase;
  let runtimePool: Pool;
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const transact = <T>(organizationId: string, work: Parameters<typeof withOrganizationTransaction<T>>[2]) =>
    withOrganizationTransaction(runtimePool, organizationId, work);
  const flows = createFlowService({ transact });
  const migration = createLegacyFlowMigrationService({ transact });

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    const seed = await database.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(
        `insert into organizations(id, name, slug)
         values ($1, 'Legacy A', $3), ($2, 'Legacy B', $4)`,
        [organizationA, organizationB, `legacy-${organizationA}`, `legacy-${organizationB}`],
      );
      const owner = await seed.query<{ id: string }>(
        `insert into users(email, password_hash)
         values ($1, 'test-only-no-login') returning id`,
        [`legacy-${organizationA}@example.test`],
      );
      await seed.query(
        `insert into memberships(organization_id, user_id, role)
         values ($1, $3, 'OWNER'), ($2, $3, 'OWNER')`,
        [organizationA, organizationB, owner.rows[0]!.id],
      );
      await seed.query(
        `insert into flow_features(organization_id, enabled)
         values ($1, true), ($2, true)`,
        [organizationA, organizationB],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
    runtimePool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
    });
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await database?.dispose();
  });

  it('preserves identity, draft, immutable versions and active version idempotently', async () => {
    const created = await flows.create(organizationA, {
      name: 'Recepção legada',
      graph: welcomeFlow(),
    });
    await flows.publish(organizationA, created.id, created.revision);
    const draft = welcomeFlow();
    draft.nodes[1]!.data.text = 'Rascunho posterior à publicação';
    const saved = await flows.save(organizationA, created.id, {
      name: 'Recepção preservada',
      graph: draft,
      revision: created.revision,
    });

    const first = await migration.migrateBatch(organizationA);
    expect(first.items).toContainEqual(expect.objectContaining({
      flowId: created.id,
      status: 'CONVERTED',
      bindings: 0,
      live: 0,
    }));
    expect(first.items[0]).toEqual(expect.objectContaining({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    const definition = await database.pool.query(
      `select id, name, draft_graph, draft_revision, active_version, origin, external_id
         from automation_definitions where organization_id=$1 and id=$2`,
      [organizationA, created.id],
    );
    const versions = await database.pool.query(
      `select version, graph from automation_versions
        where organization_id=$1 and automation_id=$2 order by version`,
      [organizationA, created.id],
    );
    expect(definition.rows[0]).toMatchObject({
      id: created.id,
      name: 'Recepção preservada',
      draft_revision: saved.revision,
      active_version: 1,
      origin: 'BROKER_FLOW_V1',
      external_id: `legacy-flow:${created.id}`,
    });
    expect(definition.rows[0].draft_graph.nodes[1].data.text).toBe('Rascunho posterior à publicação');
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0].graph.nodes[1].data.text).not.toBe('Rascunho posterior à publicação');

    const second = await migration.migrateBatch(organizationA);
    expect(second.items).toContainEqual(expect.objectContaining({
      flowId: created.id,
      status: 'CONVERTED',
      skipped: true,
    }));
    expect((await database.pool.query(
      `select count(*)::int as count from automation_definitions
        where organization_id=$1 and id=$2`,
      [organizationA, created.id],
    )).rows[0].count).toBe(1);
  });

  it('reports a conflict instead of overwriting a source that changed after conversion', async () => {
    const definition = await database.pool.query<{ id: string; draft_revision: number }>(
      `select id, draft_revision from automation_definitions
        where organization_id=$1 and origin='BROKER_FLOW_V1' limit 1`,
      [organizationA],
    );
    const graph = welcomeFlow();
    graph.nodes[1]!.data.text = 'Alteração depois da reconciliação';
    await flows.save(organizationA, definition.rows[0]!.id, {
      name: 'Fonte alterada',
      graph,
      revision: definition.rows[0]!.draft_revision,
    });

    const result = await migration.migrateBatch(organizationA);
    expect(result.items).toContainEqual(expect.objectContaining({
      flowId: definition.rows[0]!.id,
      status: 'CONFLICT',
    }));
    const target = await database.pool.query<{ name: string }>(
      `select name from automation_definitions where organization_id=$1 and id=$2`,
      [organizationA, definition.rows[0]!.id],
    );
    expect(target.rows[0]!.name).toBe('Recepção preservada');
  });

  it('keeps unsupported graphs as LEGACY with an actionable report', async () => {
    const flowId = randomUUID();
    await database.pool.query(
      `insert into flows(organization_id, id, name, graph)
       values ($1, $2, 'Unsupported legacy node', '{"nodes":[{"id":"x","type":"unknown","data":{}}],"edges":[]}'::jsonb)`,
      [organizationA, flowId],
    );

    const result = await migration.migrateBatch(organizationA, { limit: 200 });
    expect(result.items).toContainEqual(expect.objectContaining({
      flowId,
      status: 'LEGACY',
      errors: expect.arrayContaining(['AUTOMATION_GRAPH_UNSUPPORTED']),
    }));
    const ledger = await database.pool.query<{ report: { errors: string[] } }>(
      `select report from automation_legacy_migrations
        where organization_id=$1 and source_id=$2`,
      [organizationA, flowId],
    );
    expect(ledger.rows[0]!.report.errors).toContain('AUTOMATION_GRAPH_UNSUPPORTED');
  });

  it('caps a batch at 200 and never writes migration state for another organization', async () => {
    await database.pool.query(
      `insert into flows(organization_id, name, graph)
       select $1, 'Batch flow ' || item, '{"nodes":[],"edges":[]}'::jsonb
         from generate_series(1, 201) item`,
      [organizationA],
    );
    await database.pool.query(
      `insert into flows(organization_id, name, graph)
       values ($1, 'Other tenant flow', '{"nodes":[],"edges":[]}'::jsonb)`,
      [organizationB],
    );

    const result = await migration.migrateBatch(organizationA, { limit: 500 });
    expect(result.count).toBe(200);
    expect(result.organizationId).toBe(organizationA);
    expect((await database.pool.query(
      `select count(*)::int as count from automation_legacy_migrations where organization_id=$1`,
      [organizationB],
    )).rows[0].count).toBe(0);
  });
});
