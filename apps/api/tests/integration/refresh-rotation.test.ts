import { createHmac } from 'node:crypto';

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

describe('rotação de refresh com PostgreSQL real', () => {
  let database: IsolatedPostgresDatabase;
  let authPool: Pool;
  let repository: ReturnType<typeof createPostgresAuthRepository>;
  let userId: string;
  let organizationId: string;

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    authPool = new Pool({ connectionString: connectionStringForAuthRole(database.connectionString), max: 4 });
    repository = createPostgresAuthRepository(authPool);

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const organization = await oneRow<{ id: string }>(
        client,
        "INSERT INTO organizations (name, slug) VALUES ('Refresh Tenant', 'refresh-tenant') RETURNING id",
      );
      const user = await oneRow<{ id: string }>(
        client,
        "INSERT INTO users (email, password_hash) VALUES ('refresh-owner@example.test', 'known-hash') RETURNING id",
      );
      await client.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
        [organization.id, user.id],
      );
      await client.query('COMMIT');
      organizationId = organization.id;
      userId = user.id;
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

  async function seedRefresh(options: {
    id: string;
    familyId: string;
    rawToken: string;
    expiresAt?: Date;
    revokedAt?: Date;
  }): Promise<void> {
    await database.pool.query(
      `INSERT INTO refresh_tokens
         (id, organization_id, user_id, family_id, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        options.id,
        organizationId,
        userId,
        options.familyId,
        digest(options.rawToken),
        options.expiresAt ?? new Date('2030-02-01T12:00:00.000Z'),
        options.revokedAt ?? null,
      ],
    );
  }

  it('bloqueia o original, confirma substituição e persiste somente hashes na mesma família', async () => {
    const raw = 'integration-original-refresh-token-000000000';
    const nextRaw = 'integration-successor-refresh-token-00000000';
    const familyId = 'b5f81821-8a75-4838-93ed-fb07069fdf07';
    const originalId = 'bd7ab0cf-4a97-4051-9359-95ffba52d61d';
    const nextId = '3a6f89bd-bc48-41ca-a0d4-1a2b30443bd6';
    await seedRefresh({ id: originalId, familyId, rawToken: raw });

    await expect(repository.rotateRefreshToken({
      currentTokenHash: digest(raw),
      nextTokenId: nextId,
      nextTokenHash: digest(nextRaw),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    })).resolves.toMatchObject({
      outcome: 'ROTATED',
      userId,
      organizationId,
      role: 'OWNER',
    });

    const rows = await database.pool.query<{
      id: string;
      familyId: string;
      tokenHash: string;
      revokedAt: Date | null;
      replacedById: string | null;
    }>(
      `SELECT id, family_id AS "familyId", token_hash AS "tokenHash",
              revoked_at AS "revokedAt", replaced_by_id AS "replacedById"
         FROM refresh_tokens WHERE family_id = $1 ORDER BY created_at, id`,
      [familyId],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalId, familyId, tokenHash: digest(raw), revokedAt: NOW, replacedById: nextId }),
      expect.objectContaining({ id: nextId, familyId, tokenHash: digest(nextRaw), revokedAt: null, replacedById: null }),
    ]));
    expect(JSON.stringify(rows.rows)).not.toContain(raw);
    expect(JSON.stringify(rows.rows)).not.toContain(nextRaw);
  });

  it('reverte uma atualização bem-sucedida do original se a criação posterior do sucessor falhar', async () => {
    const raw = 'integration-rollback-refresh-token-000000000';
    const familyId = 'de522f95-ff30-4384-9d95-5102be9187fd';
    const originalId = '9a12f4d8-760b-4ce8-92fb-0af84e9b98b1';
    const duplicateRaw = 'integration-duplicate-refresh-token-0000000';
    await seedRefresh({ id: originalId, familyId, rawToken: raw });
    await seedRefresh({
      id: 'd6af1464-4937-49f6-8cf4-aeb318ea0dba',
      familyId: 'f2ba3310-2684-45b4-8606-afcc57085419',
      rawToken: duplicateRaw,
    });

    await expect(repository.rotateRefreshToken({
      currentTokenHash: digest(raw),
      nextTokenId: '1eaa615b-6015-4f30-820c-24b8146212e0',
      nextTokenHash: digest(duplicateRaw),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    })).rejects.toThrow();

    const original = await oneRow<{ revokedAt: Date | null; replacedById: string | null }>(
      database.pool,
      'SELECT revoked_at AS "revokedAt", replaced_by_id AS "replacedById" FROM refresh_tokens WHERE id = $1',
      [originalId],
    );
    expect(original).toEqual({ revokedAt: null, replacedById: null });
  });

  it('permite somente um refresh concorrente e a reutilização revoga toda a família', async () => {
    const raw = 'integration-concurrent-refresh-token-000000';
    const familyId = 'b8fe8f2f-f917-47ae-953b-4079e1e02651';
    await seedRefresh({
      id: 'e0cbb0b4-804d-487f-9985-9372732514ed',
      familyId,
      rawToken: raw,
    });

    const results = await Promise.all([
      repository.rotateRefreshToken({
        currentTokenHash: digest(raw),
        nextTokenId: '2cf3e5d4-e35a-4313-b5e2-a6d075b990d9',
        nextTokenHash: digest('concurrent-next-token-first-0000000000000'),
        nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
        now: NOW,
      }),
      repository.rotateRefreshToken({
        currentTokenHash: digest(raw),
        nextTokenId: 'ce2aeb6f-ef03-4078-9350-c11155b74df0',
        nextTokenHash: digest('concurrent-next-token-second-000000000000'),
        nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
        now: NOW,
      }),
    ]);

    expect(results.filter(({ outcome }) => outcome === 'ROTATED')).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === 'REUSED')).toHaveLength(1);
    const family = await database.pool.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    expect(family.rows).toHaveLength(2);
    expect(family.rows.every(({ revoked }) => revoked)).toBe(true);
  });

  it('trata token expirado como inválido sem criar sucessor', async () => {
    const raw = 'integration-expired-refresh-token-000000000';
    const familyId = '45f423ab-519c-4fa9-a788-67a2d914637c';
    await seedRefresh({
      id: '9fa053c8-4c12-4b5c-8362-5a6a74684d3f',
      familyId,
      rawToken: raw,
      expiresAt: new Date('2029-12-31T12:00:00.000Z'),
    });

    await expect(repository.rotateRefreshToken({
      currentTokenHash: digest(raw),
      nextTokenId: 'c2c042df-f0e5-436d-b0ab-f663a4a66372',
      nextTokenHash: digest('must-not-be-created-after-expiry-000000000'),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    })).resolves.toEqual({ outcome: 'INVALID' });

    const count = await oneRow<{ count: number }>(
      database.pool,
      'SELECT count(*)::int AS count FROM refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    expect(count.count).toBe(1);
  });

  it('logout revoga a família inteira e permanece idempotente', async () => {
    const raw = 'integration-logout-refresh-token-0000000000';
    const familyId = '8c0b0b04-fe67-4e37-8d95-6ff0c5c883d9';
    await seedRefresh({
      id: '394d3c38-7fa6-42c3-9678-e01cd0d1f439',
      familyId,
      rawToken: raw,
    });

    await expect(repository.revokeRefreshFamily({
      tokenHash: digest(raw),
      now: NOW,
    })).resolves.toEqual({ outcome: 'REVOKED' });
    await expect(repository.revokeRefreshFamily({
      tokenHash: digest(raw),
      now: new Date('2030-01-01T12:00:01.000Z'),
    })).resolves.toEqual({ outcome: 'ALREADY_REVOKED' });
    await expect(repository.revokeRefreshFamily({
      tokenHash: digest('unknown-refresh-token-value-0000000000000'),
      now: NOW,
    })).resolves.toEqual({ outcome: 'INVALID' });

    const revoked = await oneRow<{ revokedAt: Date | null }>(
      database.pool,
      'SELECT revoked_at AS "revokedAt" FROM refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    expect(revoked.revokedAt).toEqual(NOW);
  });

  it.each(['REUSE_PREDECESSOR', 'LOGOUT_PREDECESSOR'] as const)(
    'serializa %s com refresh do sucessor sem deixar geração ativa',
    async (raceKind) => {
      const suffix = raceKind === 'REUSE_PREDECESSOR' ? '1' : '2';
      const familyId = raceKind === 'REUSE_PREDECESSOR'
        ? '958c64ee-4307-41fd-870a-e043ee0e42f3'
        : '10508269-d671-40b9-b558-e73e6edce6c2';
      const predecessorId = raceKind === 'REUSE_PREDECESSOR'
        ? '45a72d9d-40df-41bb-84c0-0b892c5ed4fd'
        : 'f8a985ee-9f72-44f1-a9ef-03279d96b64a';
      const successorId = raceKind === 'REUSE_PREDECESSOR'
        ? '727a82ea-f687-4dc2-9019-04598fa189b8'
        : 'eacfd70d-74de-41c7-bafe-b31d0b134abe';
      const nextId = raceKind === 'REUSE_PREDECESSOR'
        ? 'f1679ae7-f7b1-405b-9189-eb6ea8a7264b'
        : 'e900f651-87fe-45ea-af6b-f5da926bc6e0';
      const predecessorRaw = `race-predecessor-refresh-token-${suffix.padEnd(10, '0')}`;
      const successorRaw = `race-successor-refresh-token-${suffix.padEnd(12, '0')}`;
      const lineageClient = await database.pool.connect();
      try {
        await lineageClient.query('BEGIN');
        await lineageClient.query(
          `INSERT INTO refresh_tokens
             (id, organization_id, user_id, family_id, token_hash, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            predecessorId,
            organizationId,
            userId,
            familyId,
            digest(predecessorRaw),
            new Date('2030-02-01T12:00:00.000Z'),
            new Date('2029-12-31T12:00:00.000Z'),
          ],
        );
        await lineageClient.query(
          `INSERT INTO refresh_tokens
             (id, organization_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            successorId,
            organizationId,
            userId,
            familyId,
            digest(successorRaw),
            new Date('2030-02-01T12:00:00.000Z'),
          ],
        );
        await lineageClient.query(
          'UPDATE refresh_tokens SET replaced_by_id = $1 WHERE id = $2',
          [successorId, predecessorId],
        );
        await lineageClient.query('COMMIT');
      } catch (error) {
        await lineageClient.query('ROLLBACK');
        throw error;
      } finally {
        lineageClient.release();
      }

      const predecessorOperation = raceKind === 'REUSE_PREDECESSOR'
        ? repository.rotateRefreshToken({
            currentTokenHash: digest(predecessorRaw),
            nextTokenId: '72d4d04c-b934-4e98-a55f-0c1c791a15bd',
            nextTokenHash: digest(`unused-race-refresh-token-${suffix.padEnd(16, '0')}`),
            nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
            now: NOW,
          })
        : repository.revokeRefreshFamily({ tokenHash: digest(predecessorRaw), now: NOW });
      const successorRefresh = repository.rotateRefreshToken({
        currentTokenHash: digest(successorRaw),
        nextTokenId: nextId,
        nextTokenHash: digest(`race-next-refresh-token-${suffix.padEnd(20, '0')}`),
        nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
        now: NOW,
      });

      await Promise.all([predecessorOperation, successorRefresh]);

      const family = await oneRow<{ active: number; count: number }>(
        database.pool,
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE revoked_at IS NULL)::int AS active
           FROM refresh_tokens WHERE family_id = $1`,
        [familyId],
      );
      expect(family.active).toBe(0);
      expect(family.count).toBeGreaterThanOrEqual(2);
    },
  );
});
