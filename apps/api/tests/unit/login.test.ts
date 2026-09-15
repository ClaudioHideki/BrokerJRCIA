import { describe, expect, it } from 'vitest';

import { createLoginService } from '../../src/modules/auth/login.js';
import { createSelectOrganizationService } from '../../src/modules/auth/select-organization.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import type { AuthRepository, LoginIdentity } from '../../src/modules/auth/repository.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';
const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const IP_SECRET = 'ip-rate-limit-secret-with-at-least-32-bytes';
const IDENTITY_SECRET = 'identity-rate-secret-with-at-least-32-bytes';
const REFRESH_HASH_SECRET = 'refresh-hash-secret-with-at-least-32-bytes';

function activeIdentity(): LoginIdentity {
  return {
    id: USER_ID,
    passwordHash: 'argon2id-known-hash',
    status: 'ACTIVE',
    organizations: [{
      id: ORGANIZATION_ID,
      name: 'JRC',
      slug: 'jrc',
      role: 'OWNER',
    }],
  };
}

function authHarness(identity: LoginIdentity | null = activeIdentity()) {
  const events: string[] = [];
  const sessions: Array<{ tokenHash: string; expiresAt: Date; userId: string }> = [];
  const audits: unknown[] = [];
  const repository: AuthRepository = {
    async findLoginIdentity(email) {
      events.push(`lookup:${email}`);
      return identity;
    },
    async createSelectionSession(input) {
      events.push('persist-selection');
      sessions.push(input);
    },
    async consumeSelection() {
      throw new Error('not used by login');
    },
  };
  const verifier = {
    async verifyPasswordOrDummy(candidate: string, passwordHash: string | null) {
      events.push(`verify:${passwordHash ?? 'dummy'}`);
      return candidate === 'correct-password' && passwordHash === 'argon2id-known-hash';
    },
  };
  const writeSecurityAudit = async (event: unknown) => {
    audits.push(event);
  };
  const store = new MemoryRateLimitStore({ now: () => NOW.getTime() });
  const login = createLoginService({
    repository,
    passwordVerifier: verifier,
    rateLimitStore: store,
    writeSecurityAudit,
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 7),
    sleeper: async (delayMs) => {
      events.push(`sleep:${delayMs}`);
    },
    ipRateLimitHmacSecret: IP_SECRET,
    identityRateLimitHmacSecret: IDENTITY_SECRET,
    rateLimit: { limit: 10, ttlMs: 60_000 },
    progressiveDelay: { baseDelayMs: 25, maximumDelayMs: 100 },
  });
  return { audits, events, login, repository, sessions, store, verifier };
}

describe('login resistente a enumeração', () => {
  it('normaliza a identidade, autentica e persiste somente o hash do token por cinco minutos', async () => {
    const harness = authHarness();

    const result = await harness.login({
      email: ' Owner@Example.TEST ',
      password: 'correct-password',
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({
      organizations: [{ id: ORGANIZATION_ID, name: 'JRC', slug: 'jrc', role: 'OWNER' }],
      expiresAt: '2030-01-01T12:05:00.000Z',
    });
    expect(result.selectionToken).toHaveLength(43);
    expect(harness.sessions).toEqual([{
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: new Date('2030-01-01T12:05:00.000Z'),
      userId: USER_ID,
    }]);
    expect(harness.sessions[0]?.tokenHash).not.toContain(result.selectionToken);
    expect(harness.events).toEqual([
      'lookup:owner@example.test',
      'verify:argon2id-known-hash',
      'persist-selection',
    ]);
  });

  it.each([
    ['usuário desconhecido', null, 'wrong-password', 'verify:dummy'],
    ['senha incorreta', activeIdentity(), 'wrong-password', 'verify:argon2id-known-hash'],
    ['usuário desativado', { ...activeIdentity(), status: 'DISABLED' as const }, 'correct-password', 'verify:argon2id-known-hash'],
    ['sem organização ativa', { ...activeIdentity(), organizations: [] }, 'correct-password', 'verify:argon2id-known-hash'],
  ])('usa a mesma falha externa para %s', async (_label, identity, password, verificationEvent) => {
    const harness = authHarness(identity);

    await expect(harness.login({
      email: 'owner@example.test',
      password,
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

    expect(harness.events).toContain(verificationEvent);
    expect(JSON.stringify(harness.audits)).not.toContain('owner@example.test');
    expect(JSON.stringify(harness.audits)).not.toContain(password);
  });

  it('falha fechado antes de consultar banco ou senha quando o rate limit está indisponível', async () => {
    const harness = authHarness();
    const unavailableStore = {
      kind: 'redis' as const,
      async consume() {
        throw new Error('redis unavailable canary');
      },
    };
    const login = createLoginService({
      repository: harness.repository,
      passwordVerifier: harness.verifier,
      rateLimitStore: unavailableStore,
      writeSecurityAudit: async (event) => {
        harness.audits.push(event);
      },
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 1),
      sleeper: async () => undefined,
      ipRateLimitHmacSecret: IP_SECRET,
      identityRateLimitHmacSecret: IDENTITY_SECRET,
      rateLimit: { limit: 10, ttlMs: 60_000 },
      progressiveDelay: { baseDelayMs: 25, maximumDelayMs: 100 },
    });

    await expect(login({
      email: 'owner@example.test',
      password: 'correct-password',
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE',
      statusCode: 503,
      retryAfterSeconds: 1,
    });
    expect(harness.events).toEqual([]);
    expect(JSON.stringify(harness.audits)).not.toContain('redis unavailable canary');
  });

  it('aplica atraso assíncrono antes do lookup sem conexão de banco retida', async () => {
    const harness = authHarness();
    const command = {
      email: 'owner@example.test',
      password: 'wrong-password',
      ipAddress: '192.0.2.10',
      requestId: REQUEST_ID,
    };
    await expect(harness.login(command)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    harness.events.length = 0;

    await expect(harness.login(command)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(harness.events[0]).toBe('sleep:25');
    expect(harness.events[1]).toBe('lookup:owner@example.test');
  });
});

describe('seleção atômica de organização', () => {
  it('emite JWT estrito e refresh opaco somente após consumo único válido', async () => {
    const persisted: unknown[] = [];
    const repository: AuthRepository = {
      async findLoginIdentity() { return null; },
      async createSelectionSession() { return undefined; },
      async consumeSelection(input) {
        persisted.push(input);
        return { outcome: 'SELECTED', userId: USER_ID, organizationId: ORGANIZATION_ID, role: 'OWNER' };
      },
    };
    const selectOrganization = createSelectOrganizationService({
      repository,
      jwtSecret: JWT_SECRET,
      refreshTokenHashSecret: REFRESH_HASH_SECRET,
      rateLimitStore: new MemoryRateLimitStore({ now: () => NOW.getTime() }),
      ipRateLimitHmacSecret: IP_SECRET,
      identityRateLimitHmacSecret: IDENTITY_SECRET,
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 8),
      randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      writeSecurityAudit: async () => undefined,
      writeOrganizationSelectedAudit: async () => undefined,
    });

    const result = await selectOrganization({
      organizationId: ORGANIZATION_ID,
      selectionToken: 'selection-token-canary',
      requestId: REQUEST_ID,
      ipAddress: '192.0.2.10',
    });

    expect(result).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
    expect(result.refreshToken).toHaveLength(43);
    expect(persisted).toEqual([expect.objectContaining({
      selectionTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      refreshExpiresAt: new Date('2030-01-31T12:00:00.000Z'),
    })]);
    expect(JSON.stringify(persisted)).not.toContain('selection-token-canary');
    expect(JSON.stringify(persisted)).not.toContain(result.refreshToken);
  });

  it('mantém resposta genérica quando a sessão expirou, foi reutilizada ou não pertence à organização', async () => {
    const audits: unknown[] = [];
    const repository: AuthRepository = {
      async findLoginIdentity() { return null; },
      async createSelectionSession() { return undefined; },
      async consumeSelection() { return { outcome: 'INVALID' }; },
    };
    const selectOrganization = createSelectOrganizationService({
      repository,
      jwtSecret: JWT_SECRET,
      refreshTokenHashSecret: REFRESH_HASH_SECRET,
      rateLimitStore: new MemoryRateLimitStore({ now: () => NOW.getTime() }),
      ipRateLimitHmacSecret: IP_SECRET,
      identityRateLimitHmacSecret: IDENTITY_SECRET,
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 8),
      randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
      writeSecurityAudit: async (event) => { audits.push(event); },
      writeOrganizationSelectedAudit: async () => undefined,
    });

    await expect(selectOrganization({
      organizationId: ORGANIZATION_ID,
      selectionToken: 'expired-or-reused-secret',
      requestId: REQUEST_ID,
      ipAddress: '192.0.2.10',
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(JSON.stringify(audits)).not.toContain('expired-or-reused-secret');
  });
});
