import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { verifyAccessToken } from '@jrc/security';

import { createLogoutService } from '../../src/modules/auth/logout.js';
import { createRefreshSessionService } from '../../src/modules/auth/refresh.js';
import type {
  AuthSessionRepository,
  LogoutResult,
  RefreshRotation,
} from '../../src/modules/auth/repository.js';
import { createPostgresAuthRepository } from '../../src/modules/auth/repository.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';
const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const REFRESH_HASH_SECRET = 'refresh-hash-secret-with-at-least-32-bytes';
const ORIGINAL_TOKEN = 'original-refresh-token-with-43-characters-0000';

function expectedTokenHmac(rawToken: string): string {
  return createHmac('sha256', REFRESH_HASH_SECRET).update(rawToken, 'utf8').digest('hex');
}

function sessionHarness(
  rotation: RefreshRotation = {
    outcome: 'ROTATED',
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    role: 'OWNER',
  },
  logoutResult: LogoutResult = { outcome: 'REVOKED' },
) {
  const rotations: unknown[] = [];
  const logouts: unknown[] = [];
  const audits: unknown[] = [];
  const repository: AuthSessionRepository = {
    async rotateRefreshToken(input) {
      rotations.push(input);
      return rotation;
    },
    async revokeRefreshFamily(input) {
      logouts.push(input);
      return logoutResult;
    },
  };
  const common = {
    repository,
    jwtSecret: JWT_SECRET,
    refreshTokenHashSecret: REFRESH_HASH_SECRET,
    now: () => NOW,
    randomBytes: (size: number) => Buffer.alloc(size, 9),
    randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
    writeSecurityAudit: async (event: unknown) => { audits.push(event); },
  };
  return {
    audits,
    logouts,
    logout: createLogoutService(common),
    refreshSession: createRefreshSessionService(common),
    rotations,
  };
}

describe('rotação de refresh token', () => {
  it('persiste somente HMAC, mantém a família e emite um novo JWT estrito', async () => {
    const harness = sessionHarness();

    const result = await harness.refreshSession(ORIGINAL_TOKEN, REQUEST_ID);

    expect(result.refreshToken).toHaveLength(43);
    expect(result.refreshToken).not.toBe(ORIGINAL_TOKEN);
    expect(harness.rotations).toEqual([{
      currentTokenHash: expectedTokenHmac(ORIGINAL_TOKEN),
      nextTokenId: '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      nextTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    }]);
    expect(JSON.stringify(harness.rotations)).not.toContain(ORIGINAL_TOKEN);
    expect(JSON.stringify(harness.rotations)).not.toContain(result.refreshToken);
    await expect(verifyAccessToken(result.accessToken, JWT_SECRET, NOW)).resolves.toMatchObject({
      sub: USER_ID,
      organization_id: ORGANIZATION_ID,
      role: 'OWNER',
      iss: 'jrc-whatsapp-broker',
      aud: 'jrc-api',
      exp: 1_893_499_800,
    });
    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
    expect(harness.audits).toEqual([expect.objectContaining({
      type: 'AUTH_REFRESH_ROTATED',
      requestId: REQUEST_ID,
      identityDigest: expectedTokenHmac(ORIGINAL_TOKEN),
    })]);
  });

  it.each([
    ['token ausente, expirado ou sessão inválida', { outcome: 'INVALID' } as const, 'AUTH_REFRESH_INVALID'],
    ['reutilização de token substituído', { outcome: 'REUSED' } as const, 'AUTH_REFRESH_REUSED'],
  ])('responde INVALID_SESSION sem expor dados para %s', async (_label, outcome, eventType) => {
    const harness = sessionHarness(outcome);

    await expect(harness.refreshSession(ORIGINAL_TOKEN, REQUEST_ID)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
      statusCode: 401,
    });

    expect(harness.audits).toEqual([expect.objectContaining({
      type: eventType,
      identityDigest: expectedTokenHmac(ORIGINAL_TOKEN),
      requestId: REQUEST_ID,
    })]);
    expect(JSON.stringify(harness.audits)).not.toContain(ORIGINAL_TOKEN);
  });

  it('não emite token nem auditoria de sucesso quando a rotação transacional falha', async () => {
    const repository: AuthSessionRepository = {
      async rotateRefreshToken() { throw new Error('database-failure-canary'); },
      async revokeRefreshFamily() { return { outcome: 'INVALID' }; },
    };
    const audits: unknown[] = [];
    const refreshSession = createRefreshSessionService({
      repository,
      jwtSecret: JWT_SECRET,
      refreshTokenHashSecret: REFRESH_HASH_SECRET,
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 9),
      randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      writeSecurityAudit: async (event) => { audits.push(event); },
    });

    await expect(refreshSession(ORIGINAL_TOKEN, REQUEST_ID)).rejects.toThrow('database-failure-canary');
    expect(audits).toEqual([]);
  });
});

describe('logout por refresh token', () => {
  it.each([
    ['revoga uma família ativa', { outcome: 'REVOKED' } as const],
    ['permanece idempotente para família já revogada', { outcome: 'ALREADY_REVOKED' } as const],
    ['permanece idempotente para token desconhecido', { outcome: 'INVALID' } as const],
  ])('%s sem persistir ou auditar o token bruto', async (_label, outcome) => {
    const harness = sessionHarness(undefined, outcome);

    await expect(harness.logout(ORIGINAL_TOKEN, REQUEST_ID)).resolves.toBeUndefined();

    expect(harness.logouts).toEqual([{
      tokenHash: expectedTokenHmac(ORIGINAL_TOKEN),
      now: NOW,
    }]);
    expect(harness.audits).toEqual([expect.objectContaining({
      type: outcome.outcome === 'INVALID' ? 'AUTH_LOGOUT_INVALID' : 'AUTH_LOGOUT_COMPLETED',
      identityDigest: expectedTokenHmac(ORIGINAL_TOKEN),
      requestId: REQUEST_ID,
    })]);
    expect(JSON.stringify({ audits: harness.audits, logouts: harness.logouts })).not.toContain(ORIGINAL_TOKEN);
  });
});

describe('segurança da conexão da repository', () => {
  it('descarta a conexão e preserva o erro original quando o rollback falha', async () => {
    const releases: unknown[] = [];
    const originalError = new Error('rotation-query-failure');
    const client = {
      async query(text: string) {
        if (text.includes('current_user')) {
          return { rows: [{ currentUser: 'jrc_auth', sessionUser: 'jrc_auth' }] };
        }
        if (text === 'BEGIN') return { rows: [] };
        if (text === 'ROLLBACK') throw new Error('rollback-failure');
        throw originalError;
      },
      release(discard: unknown) { releases.push(discard); },
    };
    const repository = createPostgresAuthRepository({
      async connect() { return client; },
    } as unknown as Pool);

    await expect(repository.rotateRefreshToken({
      currentTokenHash: 'a'.repeat(64),
      nextTokenId: '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      nextTokenHash: 'b'.repeat(64),
      nextExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
      now: NOW,
    })).rejects.toBe(originalError);
    expect(releases).toEqual([true]);
  });
});
