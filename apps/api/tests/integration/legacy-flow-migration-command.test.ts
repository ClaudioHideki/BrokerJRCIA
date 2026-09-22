import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runLegacyFlowMigration } from '../../src/commands/legacy-flow-migrate.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('legacy flow migration command', () => {
  let database: IsolatedPostgresDatabase;
  const organizationId = randomUUID();

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    const seed = await database.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(
        `insert into organizations(id, name, slug) values ($1, 'CLI migration', $2)`,
        [organizationId, `cli-${organizationId}`],
      );
      const owner = await seed.query<{ id: string }>(
        `insert into users(email, password_hash)
         values ($1, 'test-only-no-login') returning id`,
        [`cli-${organizationId}@example.test`],
      );
      await seed.query(
        `insert into memberships(organization_id, user_id, role)
         values ($1, $2, 'OWNER')`,
        [organizationId, owner.rows[0]!.id],
      );
      await seed.query(
        `insert into flows(organization_id, name, graph)
         select $1, 'CLI flow ' || item,
                jsonb_build_object('nodes', jsonb_build_array(), 'edges', jsonb_build_array(),
                                   'privateMarker', 'must-not-appear')
           from generate_series(1, 205) item`,
        [organizationId],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it('processes more than 200 flows in cursor batches and logs no graph content', async () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await runLegacyFlowMigration({
        DATABASE_URL: connectionStringForRole(database.connectionString, 'jrc_app'),
      } as NodeJS.ProcessEnv);
    } finally {
      write.mockRestore();
    }

    expect((await database.pool.query(
      `select count(*)::int as count from automation_legacy_migrations
        where organization_id=$1`,
      [organizationId],
    )).rows[0].count).toBe(205);
    expect(output.length).toBe(2);
    expect(output.join('')).not.toContain('must-not-appear');
    expect(output.map((line) => JSON.parse(line).count)).toEqual([200, 5]);
  });
});
