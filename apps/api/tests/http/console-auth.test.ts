import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { MemoryRateLimitStore } from '../../src/modules/auth/rate-limit/memory-store.js';
import type {
  AuthRepository,
  AuthSessionRepository,
  BrowserSessionRepository,
} from '../../src/modules/auth/repository.js';
import {
  createBrowserCsrfToken,
  issueAccessToken,
} from '@jrc/security';

const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const SOURCE_ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const TARGET_ORGANIZATION_ID = '2db58223-99c7-4f16-8b59-0fe73aa395a8';
const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';
const ALLOWED_ORIGIN = 'https://console.example.test';
const JWT_SECRET = 'jwt-secret-with-at-least-thirty-two-bytes';
const REFRESH_HASH_SECRET = 'refresh-hash-secret-with-at-least-32-bytes';
const CSRF_SECRET = 'browser-csrf-secret-with-at-least-32-bytes';
const SELECTION_TOKEN = 's'.repeat(43);
const REFRESH_TOKEN = 'r'.repeat(43);

const organizations = [
  {
    id: SOURCE_ORGANIZATION_ID,
    name: 'Source Tenant',
    slug: 'source-tenant',
    role: 'OWNER' as const,
  },
  {
    id: TARGET_ORGANIZATION_ID,
    name: 'Target Tenant',
    slug: 'target-tenant',
    role: 'VIEWER' as const,
  },
];

function cookiesFor(csrfToken: string, refreshToken = REFRESH_TOKEN): string {
  return `jrc_refresh=${refreshToken}; jrc_csrf=${csrfToken}`;
}

function createConsoleApp(options: {
  loggerDestination?: Writable;
  selectionOutcomes?: Array<'SELECTED' | 'INVALID' | 'REUSED'>;
  rotationOutcomes?: Array<'ROTATED' | 'INVALID' | 'REUSED'>;
  switchOutcomes?: Array<'SWITCHED' | 'INVALID' | 'REUSED' | 'PRESERVE_SOURCE' | 'SOURCE_MISMATCH'>;
} = {}) {
  const calls = {
    selections: [] as unknown[],
    rotations: [] as unknown[],
    switches: [] as unknown[],
    logouts: [] as unknown[],
  };
  const repository: AuthRepository & AuthSessionRepository & BrowserSessionRepository = {
    async findLoginIdentity() { return null; },
    async createSelectionSession() { return undefined; },
    async consumeSelection(input) {
      calls.selections.push(input);
      const outcome = options.selectionOutcomes?.[calls.selections.length - 1] ?? 'SELECTED';
      if (outcome !== 'SELECTED') return { outcome };
      return {
        outcome: 'SELECTED',
        userId: USER_ID,
        organizationId: SOURCE_ORGANIZATION_ID,
        role: 'OWNER',
      };
    },
    async rotateRefreshToken(input) {
      calls.rotations.push(input);
      const outcome = options.rotationOutcomes?.[calls.rotations.length - 1] ?? 'ROTATED';
      if (outcome !== 'ROTATED') return { outcome };
      return {
        outcome: 'ROTATED',
        userId: USER_ID,
        organizationId: SOURCE_ORGANIZATION_ID,
        role: 'OWNER',
      };
    },
    async revokeRefreshFamily(input) {
      calls.logouts.push(input);
      return { outcome: 'REVOKED' };
    },
    async findBrowserSessionIdentity() {
      return {
        user: { id: USER_ID, email: 'owner@example.test' },
        organizations,
      };
    },
    async switchOrganization(input) {
      calls.switches.push(input);
      const outcome = options.switchOutcomes?.[calls.switches.length - 1] ?? 'SWITCHED';
      if (outcome !== 'SWITCHED') return { outcome };
      return {
        outcome: 'SWITCHED',
        userId: USER_ID,
        organizationId: TARGET_ORGANIZATION_ID,
        role: 'VIEWER',
      };
    },
  };
  const shared = {
    repository,
    rateLimitStore: new MemoryRateLimitStore(),
    ipRateLimitHmacSecret: 'ip-rate-limit-secret-with-at-least-32-bytes',
    identityRateLimitHmacSecret: 'identity-rate-secret-with-at-least-32-bytes',
    refreshTokenHashSecret: REFRESH_HASH_SECRET,
    jwtSecret: JWT_SECRET,
    trustedProxyCidrs: [],
    now: () => new Date('2030-01-01T12:00:00.000Z'),
    randomBytes: (size: number) => Buffer.alloc(size, 8),
    randomUuid: () => '6dd68540-3c9a-420a-9b13-d61f927f5bb0',
    sleeper: async () => undefined,
    writeSecurityAudit: async () => undefined,
    writeOrganizationSelectedAudit: async () => undefined,
  };
  const app = buildApp({
    nodeEnv: 'test',
    ...(options.loggerDestination ? { loggerDestination: options.loggerDestination } : {}),
    passwordVerifierInitializer: async () => ({
      async verifyPasswordOrDummy() { return false; },
    }),
    auth: shared,
    consoleAuth: {
      ...shared,
      browserCsrfSecret: CSRF_SECRET,
      consoleAllowedOrigins: [ALLOWED_ORIGIN],
      browserCookieSecure: false,
    },
  });
  return { app, calls };
}

describe('sessão HTTP da console', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it('seleciona organização sem CSRF pré-cookie, omite refresh do JSON e cria os dois cookies', async () => {
    const harness = createConsoleApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/select-organization',
      headers: { origin: ALLOWED_ORIGIN, 'x-request-id': REQUEST_ID },
      payload: { selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ORGANIZATION_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe(REQUEST_ID);
    expect(response.json()).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 600,
      user: { id: USER_ID, email: 'owner@example.test' },
      activeOrganization: organizations[0],
      organizations,
    });
    expect(response.json()).not.toHaveProperty('refreshToken');
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=[^;]+;.*HttpOnly.*SameSite=Strict/i),
      expect.stringMatching(/^jrc_csrf=[^;]+;.*SameSite=Strict/i),
    ]));
    expect(response.headers['set-cookie']?.join('')).not.toContain('Domain=');
    expect(harness.calls.selections).toHaveLength(1);
  });

  it('consome selection token uma vez e responde replay sem cookie novo', async () => {
    const harness = createConsoleApp({ selectionOutcomes: ['SELECTED', 'REUSED'] });
    apps.push(harness.app);
    const request = {
      method: 'POST' as const,
      url: '/v1/console/auth/select-organization',
      headers: { origin: ALLOWED_ORIGIN },
      payload: { selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ORGANIZATION_ID },
    };

    const first = await harness.app.inject(request);
    const replay = await harness.app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['content-type']).toContain('application/problem+json');
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(harness.calls.selections).toHaveLength(2);
  });

  it.each([
    ['ausente', undefined],
    ['subdomínio', 'https://sub.console.example.test'],
    ['prefixo', 'https://console.example.test.attacker.invalid'],
    ['null', 'null'],
  ])('rejeita Origin %s antes de cookies ou persistência', async (_label, origin) => {
    const harness = createConsoleApp();
    apps.push(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/select-organization',
      headers: origin === undefined ? {} : { origin },
      payload: { selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ORGANIZATION_ID },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(harness.calls.selections).toEqual([]);
  });

  it('restaura a sessão rotacionando refresh e CSRF sem expor refresh no JSON', async () => {
    const harness = createConsoleApp();
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('refreshToken');
    expect(response.json().activeOrganization).toEqual(organizations[0]);
    expect(harness.calls.rotations).toHaveLength(1);
    const setCookies = response.headers['set-cookie'] as string[];
    expect(setCookies).toHaveLength(2);
    expect(setCookies.join(';')).not.toContain(REFRESH_TOKEN);
    expect(setCookies.join(';')).not.toContain(csrf);
  });

  it('rejeita reuse do refresh anterior e limpa o par de cookies sem emitir sessão', async () => {
    const harness = createConsoleApp({ rotationOutcomes: ['ROTATED', 'REUSED'] });
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const request = {
      method: 'POST' as const,
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    };

    const first = await harness.app.inject(request);
    const replay = await harness.app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
    ]));
    expect(replay.json()).not.toHaveProperty('refreshToken');
  });

  it.each(['INVALID', 'REUSED'] as const)(
    'limpa o par de cookies quando restore recebe refresh %s',
    async (outcome) => {
      const harness = createConsoleApp({ rotationOutcomes: [outcome] });
      apps.push(harness.app);
      const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/console/auth/restore',
        headers: {
          origin: ALLOWED_ORIGIN,
          cookie: cookiesFor(csrf),
          'x-csrf-token': csrf,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
        expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
      ]));
    },
  );

  it.each([
    ['header ausente', undefined, undefined],
    ['header malformado', 'malformed', undefined],
    ['header divergente', createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 4)), undefined],
    ['cookie CSRF divergente', undefined, createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 5))],
  ])('não rotaciona refresh quando o CSRF está inválido: %s', async (_label, headerOverride, cookieOverride) => {
    const harness = createConsoleApp();
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const header = headerOverride === undefined && _label !== 'header ausente' ? csrf : headerOverride;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(cookieOverride ?? csrf),
        ...(header === undefined ? {} : { 'x-csrf-token': header }),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
    ]));
    expect(harness.calls.rotations).toEqual([]);
  });

  it.each([
    ['JWT ausente', undefined],
    ['JWT expirado', 'expired'],
  ] as const)('%s no switch preserva cookies fonte e permite restore', async (_label, tokenKind) => {
    const harness = createConsoleApp();
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const expiredToken = tokenKind === 'expired'
      ? await issueAccessToken({
          userId: USER_ID,
          organizationId: SOURCE_ORGANIZATION_ID,
          role: 'OWNER',
        }, JWT_SECRET, new Date('2029-12-01T12:00:00.000Z'))
      : undefined;

    const failedSwitch = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/switch-organization',
      headers: {
        ...(expiredToken ? { authorization: `Bearer ${expiredToken}` } : {}),
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
      payload: { organizationId: TARGET_ORGANIZATION_ID },
    });

    expect(failedSwitch.statusCode).toBe(401);
    expect(failedSwitch.headers['set-cookie']).toBeUndefined();
    expect(harness.calls.switches).toEqual([]);

    const restored = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(harness.calls.rotations).toHaveLength(1);
  });

  it('tenant alvo inválido preserva cookies fonte e permite restore', async () => {
    const outcome = 'PRESERVE_SOURCE' as const;
    const harness = createConsoleApp({ switchOutcomes: [outcome] });
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const accessToken = await issueAccessToken({
      userId: USER_ID,
      organizationId: SOURCE_ORGANIZATION_ID,
      role: 'OWNER',
    }, JWT_SECRET, new Date('2030-01-01T12:00:00.000Z'));

    const failedSwitch = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/switch-organization',
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
      payload: { organizationId: TARGET_ORGANIZATION_ID },
    });

    expect(failedSwitch.statusCode).toBe(409);
    expect(failedSwitch.headers['set-cookie']).toBeUndefined();
    expect(failedSwitch.headers['cache-control']).toBe('no-store');
    expect(failedSwitch.headers['content-type']).toContain('application/problem+json');
    expect(failedSwitch.json()).toMatchObject({
      type: 'about:blank',
      title: 'Organization switch failed',
      status: 409,
      code: 'ORGANIZATION_SWITCH_REJECTED',
      requestId: expect.any(String),
    });
    expect(failedSwitch.json()).not.toHaveProperty('detail');
    expect(JSON.stringify(failedSwitch.json())).not.toContain(TARGET_ORGANIZATION_ID);

    const restored = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(harness.calls.rotations).toHaveLength(1);
  });

  it('mismatch JWT-cookie mantém resposta 401 genérica sem destruir o cookie fonte', async () => {
    const harness = createConsoleApp({ switchOutcomes: ['SOURCE_MISMATCH'] });
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const accessToken = await issueAccessToken({
      userId: USER_ID,
      organizationId: SOURCE_ORGANIZATION_ID,
      role: 'OWNER',
    }, JWT_SECRET, new Date('2030-01-01T12:00:00.000Z'));

    const failedSwitch = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/switch-organization',
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
      payload: { organizationId: TARGET_ORGANIZATION_ID },
    });

    expect(failedSwitch.statusCode).toBe(401);
    expect(failedSwitch.headers['set-cookie']).toBeUndefined();
    expect(failedSwitch.json()).toMatchObject({
      title: 'Authentication failed',
      status: 401,
      code: 'INVALID_SESSION',
    });
    expect(failedSwitch.json()).not.toHaveProperty('detail');

    const restored = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(harness.calls.rotations).toHaveLength(1);
  });

  it.each(['INVALID', 'REUSED'] as const)(
    'refresh %s no switch limpa os cookies da sessão',
    async (outcome) => {
      const harness = createConsoleApp({ switchOutcomes: [outcome] });
      apps.push(harness.app);
      const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
      const accessToken = await issueAccessToken({
        userId: USER_ID,
        organizationId: SOURCE_ORGANIZATION_ID,
        role: 'OWNER',
      }, JWT_SECRET, new Date('2030-01-01T12:00:00.000Z'));

      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/console/auth/switch-organization',
        headers: {
          authorization: `Bearer ${accessToken}`,
          origin: ALLOWED_ORIGIN,
          cookie: cookiesFor(csrf),
          'x-csrf-token': csrf,
        },
        payload: { organizationId: TARGET_ORGANIZATION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
        expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
      ]));
    },
  );

  it('troca para o papel do tenant alvo e aceita somente JWT, nunca API key', async () => {
    const harness = createConsoleApp();
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const accessToken = await issueAccessToken({
      userId: USER_ID,
      organizationId: SOURCE_ORGANIZATION_ID,
      role: 'OWNER',
    }, JWT_SECRET, new Date('2030-01-01T12:00:00.000Z'));

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/switch-organization',
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
      payload: { organizationId: TARGET_ORGANIZATION_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().activeOrganization).toEqual(organizations[1]);
    expect(response.json().activeOrganization.role).toBe('VIEWER');
    expect(response.json()).not.toHaveProperty('refreshToken');
    expect(harness.calls.switches).toHaveLength(1);

    const apiKeyResponse = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/switch-organization',
      headers: {
        'x-jrc-api-key': 'jrc_live_forbidden',
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
      payload: { organizationId: TARGET_ORGANIZATION_ID },
    });
    expect(apiKeyResponse.statusCode).toBe(401);
    expect(harness.calls.switches).toHaveLength(1);
  });

  it('faz logout idempotente com barreira CSRF local e nunca limpa cookies para Origin estrangeira', async () => {
    const harness = createConsoleApp();
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 3));
    const headers = {
      origin: ALLOWED_ORIGIN,
      cookie: cookiesFor(csrf),
      'x-csrf-token': csrf,
    };

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/logout',
      headers,
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
    ]));
    expect(harness.calls.logouts).toHaveLength(1);

    const replayWithoutCookies = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/logout',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(replayWithoutCookies.statusCode).toBe(204);
    expect(replayWithoutCookies.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
    ]));
    expect(harness.calls.logouts).toHaveLength(1);

    const afterClientClearedCsrfCookie = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/logout',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: `jrc_refresh=${REFRESH_TOKEN}`,
        'x-csrf-token': csrf,
      },
    });
    expect(afterClientClearedCsrfCookie.statusCode).toBe(204);
    expect(afterClientClearedCsrfCookie.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
    ]));
    expect(harness.calls.logouts).toHaveLength(2);

    const invalidHeaderAfterClientClearedCsrfCookie = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/logout',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: `jrc_refresh=${REFRESH_TOKEN}`,
        'x-csrf-token': 'malformed',
      },
    });
    expect(invalidHeaderAfterClientClearedCsrfCookie.statusCode).toBe(401);
    expect(invalidHeaderAfterClientClearedCsrfCookie.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^jrc_refresh=;.*Max-Age=0/i),
        expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
      ]),
    );
    expect(harness.calls.logouts).toHaveLength(2);

    const foreign = await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/logout',
      headers: { ...headers, origin: 'https://attacker.invalid' },
    });
    expect(foreign.statusCode).toBe(401);
    expect(foreign.headers['set-cookie']).toBeUndefined();
    expect(harness.calls.logouts).toHaveLength(2);
  });

  it('não grava canários de cookie, CSRF, selection ou corpo sensível nos logs', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const harness = createConsoleApp({ loggerDestination: sink });
    apps.push(harness.app);
    const csrf = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 7));

    await harness.app.inject({
      method: 'POST',
      url: '/v1/console/auth/restore',
      headers: {
        origin: ALLOWED_ORIGIN,
        cookie: cookiesFor(csrf),
        'x-csrf-token': csrf,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const logs = chunks.join('');
    expect(logs).not.toContain(REFRESH_TOKEN);
    expect(logs).not.toContain(csrf);
    expect(logs).not.toContain(SELECTION_TOKEN);
  });
});
