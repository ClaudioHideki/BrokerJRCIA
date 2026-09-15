import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { runMigrations } from '../../src/db/migrate.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const HASH_SECRET = 'refresh-hash-secret-with-at-least-32-bytes';

function digest(token: string): string {
  return createHmac('sha256', HASH_SECRET).update(token, 'utf8').digest('hex');
}

function connectionStringForAuthRole(connectionString: string): string {
  const url = new URL(connectionString);
  url.username = 'jrc_auth';
  url.password = '';
  return url.toString();
}

describe('troca atômica de organização com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;
  let authPool: Pool;
  let repository: ReturnType<typeof createPostgresAuthRepository>;
  let userId: string;
  let sourceOrganizationId: string;
  let viewerOrganizationId: string;
  let operatorOrganizationId: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    authPool = new Pool({ connectionString: connectionStringForAuthRole(database.connectionString), max: 6 });
    repository = createPostgresAuthRepository(authPool);

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Source', 'browser-source') RETURNING id",
      );
      const viewer = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Viewer', 'browser-viewer') RETURNING id",
      );
      const operator = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Operator', 'browser-operator') RETURNING id",
      );
      const user = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('browser-owner@example.test', 'known-hash') RETURNING id",
      );
      const keeper = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('browser-keeper@example.test', 'known-hash') RETURNING id",
      );
      await client.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES
           ($1, $4, 'OWNER'), ($2, $4, 'VIEWER'), ($3, $4, 'OPERATOR'),
           ($2, $5, 'OWNER'), ($3, $5, 'OWNER')`,
        [source.id, viewer.id, operator.id, user.id, keeper.id],
      );
      await client.query('COMMIT');
      userId = user.id;
      sourceOrganizationId = source.id;
      viewerOrganizationId = viewer.id;
      operatorOrganizationId = operator.id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await authPool?.end();
    await database?.dispose();
  });

  async function seedSource(rawToken: string): Promise<{ familyId: string; tokenId: string }> {
    const familyId = randomUUID();
    const tokenId = randomUUID();
    await database.pool.query(
      `INSERT INTO refresh_tokens
         (id, organization_id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tokenId,
        sourceOrganizationId,
        userId,
        familyId,
        digest(rawToken),
        new Date('2030-02-01T12:00:00.000Z'),
      ],
    );
    return { familyId, tokenId };
  }

  function switchInput(rawToken: string, targetOrganizationId: string) {
    return {
      currentTokenHash: digest(rawToken),
      expectedUserId: userId,
      expectedOrganizationId: sourceOrganizationId,
      targetOrganizationId,
      nextTokenId: randomUUID(),
      nextFamilyId: randomUUID(),
      nextTokenHash: digest(`next-${randomUUID()}`),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    };
  }

  async function expectSourceCanRestore(rawToken: string) {
    await expect(repository.rotateRefreshToken({
      currentTokenHash: digest(rawToken),
      nextTokenId: randomUUID(),
      nextTokenHash: digest(`restored-${randomUUID()}`),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    })).resolves.toMatchObject({
      outcome: 'ROTATED',
      userId,
      organizationId: sourceOrganizationId,
      role: 'OWNER',
    });
  }

  it('projeta identidade ativa com roles por tenant e sem privilégio OWNER global', async () => {
    await expect(repository.findBrowserSessionIdentity(userId)).resolves.toEqual({
      user: { id: userId, email: 'browser-owner@example.test' },
      organizations: expect.arrayContaining([
        expect.objectContaining({ id: sourceOrganizationId, role: 'OWNER' }),
        expect.objectContaining({ id: viewerOrganizationId, role: 'VIEWER' }),
        expect.objectContaining({ id: operatorOrganizationId, role: 'OPERATOR' }),
      ]),
    });
  });

  it('revoga a família fonte e cria exatamente um refresh em família nova com role VIEWER', async () => {
    const rawToken = `browser-switch-${randomUUID()}`;
    const source = await seedSource(rawToken);
    const input = switchInput(rawToken, viewerOrganizationId);

    await expect(repository.switchOrganization(input)).resolves.toEqual({
      outcome: 'SWITCHED',
      userId,
      organizationId: viewerOrganizationId,
      role: 'VIEWER',
    });

    const sourceFamily = await oneRow<{ active: number; count: number }>(
      database.pool,
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
              count(*)::int AS count
         FROM refresh_tokens WHERE family_id = $1`,
      [source.familyId],
    );
    const nextFamily = await oneRow<{ active: number; count: number; organizationId: string }>(
      database.pool,
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
              count(*)::int AS count, max(organization_id::text) AS "organizationId"
         FROM refresh_tokens WHERE family_id = $1`,
      [input.nextFamilyId],
    );
    expect(sourceFamily).toEqual({ active: 0, count: 1 });
    expect(nextFamily).toEqual({ active: 1, count: 1, organizationId: viewerOrganizationId });
  });

  it.each([
    ['membership alvo desativada', 'membership'],
    ['organização alvo suspensa', 'organization'],
  ] as const)('%s preserva a sessão fonte válida', async (_label, mutation) => {
    const rawToken = `invalid-target-${mutation}-${randomUUID()}`;
    const source = await seedSource(rawToken);
    if (mutation === 'membership') {
      await database.pool.query(
        "UPDATE memberships SET status = 'DISABLED' WHERE organization_id = $1 AND user_id = $2",
        [viewerOrganizationId, userId],
      );
    } else {
      await database.pool.query(
        "UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1",
        [viewerOrganizationId],
      );
    }

    await expect(repository.switchOrganization(switchInput(rawToken, viewerOrganizationId)))
      .resolves.toEqual({ outcome: 'PRESERVE_SOURCE' });
    const sourceState = await oneRow<{ revokedAt: Date | null }>(
      database.pool,
      'SELECT revoked_at AS "revokedAt" FROM refresh_tokens WHERE family_id = $1',
      [source.familyId],
    );
    expect(sourceState.revokedAt).toBeNull();
    await expectSourceCanRestore(rawToken);

    if (mutation === 'membership') {
      await database.pool.query(
        "UPDATE memberships SET status = 'ACTIVE' WHERE organization_id = $1 AND user_id = $2",
        [viewerOrganizationId, userId],
      );
    } else {
      await database.pool.query(
        "UPDATE organizations SET status = 'ACTIVE' WHERE id = $1",
        [viewerOrganizationId],
      );
    }
  });

  it('mismatch JWT/cookie não revoga a família da vítima', async () => {
    const rawToken = `mismatch-${randomUUID()}`;
    const source = await seedSource(rawToken);
    const input = switchInput(rawToken, viewerOrganizationId);

    await expect(repository.switchOrganization({
      ...input,
      expectedUserId: randomUUID(),
      expectedOrganizationId: operatorOrganizationId,
    })).resolves.toEqual({ outcome: 'SOURCE_MISMATCH' });

    const state = await oneRow<{ revokedAt: Date | null }>(
      database.pool,
      'SELECT revoked_at AS "revokedAt" FROM refresh_tokens WHERE family_id = $1',
      [source.familyId],
    );
    expect(state.revokedAt).toBeNull();
    await expectSourceCanRestore(rawToken);
  });

  it.each([
    ['mesmo alvo', (viewer: string) => [viewer, viewer]],
    ['alvos diferentes', (viewer: string, operator: string) => [viewer, operator]],
  ] as const)('permite um único sucessor sob chamadas concorrentes para %s', async (_label, targets) => {
    const rawToken = `race-${randomUUID()}`;
    const source = await seedSource(rawToken);
    const [firstTarget, secondTarget] = targets(viewerOrganizationId, operatorOrganizationId);
    const first = switchInput(rawToken, firstTarget!);
    const second = switchInput(rawToken, secondTarget!);

    const results = await Promise.all([
      repository.switchOrganization(first),
      repository.switchOrganization(second),
    ]);

    expect(results.filter(({ outcome }) => outcome === 'SWITCHED')).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === 'REUSED')).toHaveLength(1);
    const all = await database.pool.query<{ familyId: string; active: boolean }>(
      `SELECT family_id AS "familyId", revoked_at IS NULL AS active
         FROM refresh_tokens
        WHERE family_id = ANY($1::uuid[])`,
      [[source.familyId, first.nextFamilyId, second.nextFamilyId]],
    );
    expect(all.rows.filter(({ active }) => active)).toHaveLength(1);
    expect(all.rows).toHaveLength(2);

    await expect(repository.switchOrganization(switchInput(rawToken, viewerOrganizationId)))
      .resolves.toEqual({ outcome: 'REUSED' });
    const successor = await oneRow<{ active: number }>(
      database.pool,
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active
         FROM refresh_tokens
        WHERE family_id <> $1 AND family_id = ANY($2::uuid[])`,
      [source.familyId, [first.nextFamilyId, second.nextFamilyId]],
    );
    expect(successor.active).toBe(1);
  });

  it('usuário desativado invalida e revoga somente a família fonte', async () => {
    const rawToken = `disabled-user-${randomUUID()}`;
    const source = await seedSource(rawToken);
    await database.pool.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [userId]);

    await expect(repository.switchOrganization(switchInput(rawToken, viewerOrganizationId)))
      .resolves.toEqual({ outcome: 'INVALID' });
    const state = await oneRow<{ active: number }>(
      database.pool,
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active
         FROM refresh_tokens WHERE family_id = $1`,
      [source.familyId],
    );
    expect(state.active).toBe(0);
    await database.pool.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
  });
});
