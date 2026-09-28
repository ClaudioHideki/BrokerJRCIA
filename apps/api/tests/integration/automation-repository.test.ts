import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
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

  it('lists every automation with stable tenant-scoped cursor pages, including equal timestamps', async () => {
    const organizationId = randomUUID();
    const anotherOrganizationId = randomUUID();
    const repository = createPostgresAutomationRepository();
    const service=createAutomationService({repository,transact:(org,work)=>withOrganizationTransaction(pool,org,work)});
    const graph = { nodes: [], edges: [] } as never;
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const seed=await database.pool.connect();
    try {
      await seed.query('begin');
      await seed.query("insert into organizations(id,name,slug) values($1::uuid,'Paging A',$1::text),($2::uuid,'Paging B',$2::text)", [organizationId, anotherOrganizationId]);
      const user=(await seed.query("insert into users(email,password_hash) values($1,'no-login') returning id",[`${organizationId}@example.test`])).rows[0];
      await seed.query("insert into memberships(organization_id,user_id,role) values($1,$3,'OWNER'),($2,$3,'OWNER')",[organizationId,anotherOrganizationId,user.id]);
      await seed.query('commit');
    } catch(error) { await seed.query('rollback'); throw error; }
    finally { seed.release(); }
    await withOrganizationTransaction(pool, organizationId, async (transaction) => {
      for (const id of ids) await repository.insertDefinition(transaction, { org: organizationId, id, name: id, graph });
      await transaction.query(`update automation_definitions set updated_at='2030-01-01T00:00:00.123456Z' where organization_id=$1`, [organizationId]);
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.list(organizationId, { pageSize: 2, ...(cursor ? { cursor } : {}) });
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
    expect(new Set(seen).size).toBe(ids.length);
    await expect(Promise.resolve().then(()=>service.list(organizationId,{pageSize:2,cursor:'invalid-cursor'}))).rejects.toMatchObject({code:'AUTOMATION_CURSOR_INVALID',statusCode:400});
    const other = await service.list(anotherOrganizationId, { pageSize: 2 });
    expect(other.data).toEqual([]);
  });
});
