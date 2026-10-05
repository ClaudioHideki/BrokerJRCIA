import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import Fastify from 'fastify';
import { hashOpaqueToken, hashRefreshToken, verifyAccessToken } from '@jrc/security';
import { createSelectOrganizationService } from '../../src/modules/auth/select-organization.js';
import { createRefreshSessionService } from '../../src/modules/auth/refresh.js';
import { authenticateRequest } from '../../src/http/plugins/authentication.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';
import { createLoginService } from '../../src/modules/auth/login.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createIsolatedPostgresDatabase, type IsolatedPostgresDatabase, requireTestDatabaseAdminUrl } from './helpers/postgres.js';

const NOW = new Date('2030-01-01T00:00:00Z');
const expiry = new Date('2030-02-01T00:00:00Z');
function asRole(url: string, role: string) { const parsed = new URL(url); parsed.username = role; parsed.password = ''; return parsed.toString(); }

describe('global password-reset authentication revocation', () => {
  let database: IsolatedPostgresDatabase;
  let authPool: Pool;
  let platformPool: Pool;
  let repository: ReturnType<typeof createPostgresAuthRepository>;
  beforeAll(async () => {
    const admin = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(admin);
    await withGlobalRoleLock(admin, () => runMigrations(database.connectionString));
    authPool = new Pool({ connectionString: asRole(database.connectionString, 'jrc_auth'), max: 6 });
    platformPool = new Pool({ connectionString: asRole(database.connectionString, 'jrc_platform'), max: 4 });
    repository = createPostgresAuthRepository(authPool);
  });
  afterAll(async () => { await authPool?.end(); await platformPool?.end(); await database?.dispose(); });

  async function fixture() {
    const userId = randomUUID(); const otherId = randomUUID(); const orgs = [randomUUID(), randomUUID()];
    const email = `${userId}@example.test`;
    const connection = await database.pool.connect();
    try {
      await connection.query('BEGIN');
    await connection.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [userId,email,'old-synthetic-hash',otherId,`${otherId}@example.test`]);
    for (const id of orgs) {
      await connection.query("INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Synthetic',$1::text)", [id]);
      await connection.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'VIEWER')", [id,userId,otherId]);
    }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
    return { userId, otherId, orgs, email };
  }
  async function selection(userId: string, version = 0) {
    const tokenHash = randomUUID();
    expect(await repository.createSelectionSession({ userId, tokenHash, expiresAt: expiry, expectedAuthVersion: version })).toBe(true);
    return tokenHash;
  }
  function consume(tokenHash: string, organizationId: string) {
    return repository.consumeSelection({ selectionTokenHash: tokenHash, organizationId, now: NOW, refreshTokenId: randomUUID(), refreshFamilyId: randomUUID(), refreshTokenHash: randomUUID(), refreshExpiresAt: expiry });
  }
  async function refresh(userId: string, organizationId: string) {
    const tokenHash = await selection(userId); const nextHash = randomUUID();
    const result = await repository.consumeSelection({ selectionTokenHash: tokenHash, organizationId, now: NOW, refreshTokenId: randomUUID(), refreshFamilyId: randomUUID(), refreshTokenHash: nextHash, refreshExpiresAt: expiry });
    expect(result.outcome).toBe('SELECTED'); return nextHash;
  }
  async function reset(userId: string, client?: PoolClient) {
    const connection = client ?? await platformPool.connect();
    try {
      if (!client) await connection.query('BEGIN');
      await connection.query('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, 'new-synthetic-hash']);
      await connection.query('SELECT public.revoke_user_authentication($1,$2)', [userId,NOW]);
      if (!client) await connection.query('COMMIT');
    } catch (error) { if (!client) await connection.query('ROLLBACK'); throw error; }
    finally { if (!client) connection.release(); }
  }
  function rotate(currentTokenHash: string) { return repository.rotateRefreshToken({ currentTokenHash, nextTokenId: randomUUID(), nextTokenHash: randomUUID(), nextExpiresAt: expiry, now: NOW }); }

  it('invalidates selections, access generations and refresh families in every company without affecting another user', async () => {
    const { userId, otherId, orgs } = await fixture();
    const pending = await selection(userId); const otherPending = await selection(otherId);
    const tokens = await Promise.all(orgs.map((id) => refresh(userId,id)));
    expect(await repository.isUserAuthenticationCurrent(userId,0)).toBe(true);
    await reset(userId);
    expect(await repository.isUserAuthenticationCurrent(userId,0)).toBe(false);
    expect(await repository.isUserAuthenticationCurrent(userId,1)).toBe(true);
    expect((await consume(pending,orgs[0]!)).outcome).not.toBe('SELECTED');
    for (const token of tokens) expect((await rotate(token)).outcome).not.toBe('ROTATED');
    expect((await consume(otherPending,orgs[0]!)).outcome).toBe('SELECTED');
    const next = await selection(userId,1);
    expect(await consume(next,orgs[1]!)).toMatchObject({ outcome: 'SELECTED', authVersion: 1 });
  });

  it('rejects a login whose old password verification finishes after the reset', async () => {
    const { userId,email } = await fixture();
    const login = createLoginService({ repository, rateLimitStore: new MemoryRateLimitStore(),
      passwordVerifier: { async verifyPasswordOrDummy() { await reset(userId); return true; } },
      writeSecurityAudit: async () => undefined, sleeper: async () => undefined, now: () => NOW,
      ipRateLimitHmacSecret: 'synthetic-ip-secret-with-at-least-32-bytes', identityRateLimitHmacSecret: 'synthetic-identity-secret-with-at-least-32-bytes' });
    await expect(login({ email,password: 'old-synthetic-password',ipAddress:'192.0.2.1',requestId:randomUUID() })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((await database.pool.query('SELECT count(*)::integer AS count FROM login_sessions WHERE user_id=$1',[userId])).rows[0].count).toBe(0);
  });

  it('serializes issuance behind a reset and rejects stale selection, refresh and switch', async () => {
    const { userId,orgs } = await fixture();
    const pending = await selection(userId); const token = await refresh(userId,orgs[0]!);
    const connection = await platformPool.connect();
    try {
      await connection.query('BEGIN');
      await reset(userId,connection);
      const creating = repository.createSelectionSession({ userId, tokenHash: randomUUID(), expiresAt: expiry, expectedAuthVersion: 0 });
      const selecting = consume(pending,orgs[1]!); const rotating = rotate(token);
      const switching = repository.switchOrganization({ currentTokenHash: token, expectedUserId: userId, expectedOrganizationId: orgs[0]!, targetOrganizationId: orgs[1]!, nextTokenId: randomUUID(),nextFamilyId:randomUUID(),nextTokenHash:randomUUID(),nextExpiresAt:expiry,now:NOW });
      await connection.query('COMMIT');
      expect(await creating).toBe(false);
      expect((await selecting).outcome).not.toBe('SELECTED');
      expect((await rotating).outcome).not.toBe('ROTATED');
      expect((await switching).outcome).not.toBe('SWITCHED');
    } finally { await connection.query('ROLLBACK'); connection.release(); }
    expect((await database.pool.query('SELECT count(*)::integer AS count FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL',[userId])).rows[0].count).toBe(0);
  });


  it.each(['selection', 'refresh'] as const)('keeps an access token signed after a racing reset on its original generation: %s', async (flow) => {
    const { userId, orgs } = await fixture();
    const secret = 'synthetic-jwt-secret-with-at-least-32-bytes';
    const hashSecret = 'synthetic-refresh-secret-with-at-least-32-bytes';
    const rawSelection = randomUUID();
    const rawRefresh = randomUUID();
    const expiry = new Date(Date.now() + 86400000);
    await repository.createSelectionSession({ userId, tokenHash: hashOpaqueToken(rawSelection), expiresAt: expiry, expectedAuthVersion: 0 });
    let tokens;
    if (flow === 'selection') {
      const select = createSelectOrganizationService({ repository: {
        ...repository,
        async consumeSelection(input) {
          const selected = await repository.consumeSelection(input);
          await reset(userId);
          return selected;
        },
      }, jwtSecret: secret, refreshTokenHashSecret: hashSecret,
        rateLimitStore: new MemoryRateLimitStore(), ipRateLimitHmacSecret: secret, identityRateLimitHmacSecret: secret,
        writeSecurityAudit: async () => undefined, writeOrganizationSelectedAudit: async () => undefined,
      });
      tokens = await select({ organizationId: orgs[0]!, selectionToken: rawSelection, requestId: randomUUID(), ipAddress: '192.0.2.1' });
    } else {
      await repository.consumeSelection({ selectionTokenHash: hashOpaqueToken(rawSelection), organizationId: orgs[0]!, now: new Date(),
        refreshTokenId: randomUUID(), refreshFamilyId: randomUUID(), refreshTokenHash: hashRefreshToken(rawRefresh,hashSecret), refreshExpiresAt: expiry });
      const refresh = createRefreshSessionService({ repository: {
        ...repository,
        async rotateRefreshToken(input) {
          const rotated = await repository.rotateRefreshToken(input);
          await reset(userId);
          return rotated;
        },
      }, jwtSecret: secret, refreshTokenHashSecret: hashSecret, writeSecurityAudit: async () => undefined });
      tokens = await refresh(rawRefresh);
    }
    const claims = await verifyAccessToken(tokens.accessToken,secret);
    expect(claims.auth_version).toBe(0);
    const app = Fastify();
    app.decorate('isUserAuthenticationCurrent', repository.isUserAuthenticationCurrent);
    app.get('/protected', { preHandler: authenticateRequest({ jwtSecret: secret, authenticateApiKey: async () => null }) }, async () => ({ ok: true }));
    try {
      expect((await app.inject({ url: '/protected', headers: { authorization: `Bearer ${tokens.accessToken}` } })).statusCode).toBe(401);
    } finally { await app.close(); }
    expect((await rotate(hashRefreshToken(tokens.refreshToken,hashSecret))).outcome).not.toBe('ROTATED');
  });

  it('waits for in-flight issuance before revoking its committed token', async () => {
    const { userId } = await fixture();
    const issuer = await authPool.connect();
    const tokenHash = randomUUID();
    try {
      await issuer.query('BEGIN');
      await issuer.query('SELECT public.create_login_selection($1,$2,$3,$4)',[userId,tokenHash,expiry,0]);
      const resetting = reset(userId);
      expect(await Promise.race([resetting.then(() => 'completed'), new Promise((resolve) => setTimeout(() => resolve('blocked'),40))])).toBe('blocked');
      await issuer.query('COMMIT');
      await resetting;
      expect((await database.pool.query('SELECT consumed_at,auth_version FROM login_sessions WHERE token_hash=$1',[tokenHash])).rows[0]).toMatchObject({ consumed_at: NOW, auth_version: 0 });
      expect(await repository.isUserAuthenticationCurrent(userId,0)).toBe(false);
    } finally { await issuer.query('ROLLBACK'); issuer.release(); }
  });

  it('rolls password and invalidation back together, with least-privilege boundaries', async () => {
    const { userId } = await fixture();
    const connection = await platformPool.connect();
    try { await connection.query('BEGIN'); await reset(userId,connection); await connection.query('ROLLBACK'); }
    finally { connection.release(); }
    expect(await repository.isUserAuthenticationCurrent(userId,0)).toBe(true);
    expect((await database.pool.query('SELECT password_hash FROM users WHERE id=$1',[userId])).rows[0].password_hash).toBe('old-synthetic-hash');
    await expect(authPool.query('SELECT public.revoke_user_authentication($1,$2)',[userId,NOW])).rejects.toMatchObject({ code: '42501' });
    await expect(platformPool.query('SELECT password_hash FROM users')).rejects.toMatchObject({ code: '42501' });
  });
});
