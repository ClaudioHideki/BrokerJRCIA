import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  ConsoleSelectOrganizationRequestSchema,
  ConsoleSessionResponseSchema,
  ConsoleOrganizationSwitchRejectedProblemSchema,
  ConsoleSwitchOrganizationRequestSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@jrc/contracts';
import {
  createBrowserCsrfToken,
  isConsoleOriginAllowed,
  parseBrowserCookieHeader,
  resolveBrowserCookiePolicy,
  verifyAccessToken,
  verifyBrowserCsrfToken,
  type AccessTokenPayload,
  type RandomBytesSource,
} from '@jrc/security';

import {
  BrowserSessionPreservedError,
  BrowserSessionSourceMismatchError,
  createBrowserSessionService,
} from '../../modules/auth/browser-session.js';
import type {
  AuthRepository,
  AuthSessionRepository,
  BrowserSessionRepository,
} from '../../modules/auth/repository.js';
import { resolveClientIp } from '../../modules/auth/rate-limit/keys.js';
import { assertRuntimeRateLimitStore } from '../../modules/auth/rate-limit/memory-store.js';
import type { RateLimitStore } from '../../modules/auth/rate-limit/store.js';
import {
  createSelectOrganizationService,
  type OrganizationSelectedAuditEvent,
} from '../../modules/auth/select-organization.js';
import type { ProgressiveDelayOptions } from '../../modules/auth/delay.js';
import { createLogoutService } from '../../modules/auth/logout.js';
import { createRefreshSessionService } from '../../modules/auth/refresh.js';
import { AuthServiceError, type WriteSecurityAudit } from '../../modules/auth/login.js';

const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ConsoleAuthRouteOptions {
  nodeEnv: 'development' | 'test' | 'production';
  repository: AuthRepository & AuthSessionRepository & BrowserSessionRepository;
  rateLimitStore: RateLimitStore;
  writeSecurityAudit: WriteSecurityAudit;
  writeOrganizationSelectedAudit(event: OrganizationSelectedAuditEvent): Promise<void>;
  ipRateLimitHmacSecret: string;
  identityRateLimitHmacSecret: string;
  jwtSecret: string;
  refreshTokenHashSecret: string;
  browserCsrfSecret: string;
  consoleAllowedOrigins: readonly string[];
  browserCookieSecure: boolean;
  trustedProxyCidrs: readonly string[];
  rateLimit?: { limit: number; ttlMs: number };
  progressiveDelay?: ProgressiveDelayOptions;
  now?: () => Date;
  randomBytes?: RandomBytesSource;
  randomUuid?: () => string;
  sleeper?: (delayMs: number) => Promise<void>;
}

function clientIpFrom(request: FastifyRequest, trustedProxyCidrs: readonly string[]): string {
  return resolveClientIp({
    remoteAddress: request.raw.socket.remoteAddress ?? request.ip,
    trustedProxyCidrs,
    ...(request.headers['x-forwarded-for'] === undefined
      ? {}
      : { forwardedFor: request.headers['x-forwarded-for'] }),
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function genericProblem(requestId: string, status = 401) {
  return {
    type: 'about:blank',
    title: status === 401 ? 'Authentication failed' : 'Invalid request',
    status,
    code: status === 401 ? 'INVALID_SESSION' : 'INVALID_REQUEST',
    requestId,
  };
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean },
  maxAge: number,
): string {
  return [
    `${name}=${value}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    ...(options.secure ? ['Secure'] : []),
    'SameSite=Strict',
  ].join('; ');
}

export async function registerConsoleAuthRoutes(
  app: FastifyInstance,
  options: ConsoleAuthRouteOptions,
): Promise<void> {
  assertRuntimeRateLimitStore(options.rateLimitStore, options.nodeEnv);
  const now = options.now ?? (() => new Date());
  const cookiePolicy = resolveBrowserCookiePolicy({
    nodeEnv: options.nodeEnv,
    secure: options.browserCookieSecure,
  });
  const cookieContext = new WeakMap<FastifyRequest, { refreshToken: string }>();
  const jwtContext = new WeakMap<FastifyRequest, AccessTokenPayload>();

  function setSessionCookies(reply: FastifyReply, refreshToken: string): void {
    const csrfToken = createBrowserCsrfToken(
      options.browserCsrfSecret,
      options.randomBytes === undefined
        ? undefined
        : (size) => Buffer.from(options.randomBytes!(size)),
    );
    reply.header('Set-Cookie', [
      serializeCookie(
        cookiePolicy.refresh.name,
        refreshToken,
        cookiePolicy.refresh.options,
        REFRESH_COOKIE_MAX_AGE_SECONDS,
      ),
      serializeCookie(
        cookiePolicy.csrf.name,
        csrfToken,
        cookiePolicy.csrf.options,
        REFRESH_COOKIE_MAX_AGE_SECONDS,
      ),
    ]);
  }

  function clearSessionCookies(reply: FastifyReply): void {
    reply.header('Set-Cookie', [
      serializeCookie(cookiePolicy.refresh.name, '', cookiePolicy.refresh.options, 0),
      serializeCookie(cookiePolicy.csrf.name, '', cookiePolicy.csrf.options, 0),
    ]);
  }

  async function reject(request: FastifyRequest, reply: FastifyReply, clear = false): Promise<void> {
    if (clear) clearSessionCookies(reply);
    await reply.code(401).type(PROBLEM_CONTENT_TYPE).send(genericProblem(request.id));
  }

  async function exactOriginGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isConsoleOriginAllowed(singleHeader(request.headers.origin), options.consoleAllowedOrigins)) {
      await reject(request, reply);
    }
  }

  async function cookieAndCsrfGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const cookies = parseBrowserCookieHeader(singleHeader(request.headers.cookie), cookiePolicy);
    const csrfHeader = singleHeader(request.headers['x-csrf-token']);
    if (
      cookies.refreshToken === null
      || cookies.csrfToken === null
      || !OPAQUE_TOKEN_PATTERN.test(cookies.refreshToken)
      || !verifyBrowserCsrfToken(csrfHeader, cookies.csrfToken, options.browserCsrfSecret)
    ) {
      await reject(request, reply, true);
      return;
    }
    cookieContext.set(request, { refreshToken: cookies.refreshToken });
  }

  async function optionalLogoutCookieGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const cookies = parseBrowserCookieHeader(singleHeader(request.headers.cookie), cookiePolicy);
    if (cookies.refreshToken === null || !OPAQUE_TOKEN_PATTERN.test(cookies.refreshToken)) return;
    const csrfHeader = singleHeader(request.headers['x-csrf-token']);
    // Logout may synchronously expire the readable CSRF cookie as a local
    // fail-closed barrier. The captured header remains HMAC-authenticated and
    // exact-Origin protected, so it can safely authorize refresh revocation.
    const csrfProof = cookies.csrfToken ?? csrfHeader;
    if (
      csrfProof === undefined
      || !verifyBrowserCsrfToken(csrfHeader, csrfProof, options.browserCsrfSecret)
    ) {
      await reject(request, reply, true);
      return;
    }
    cookieContext.set(request, { refreshToken: cookies.refreshToken });
  }

  async function jwtOnlyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.headers['x-jrc-api-key'] !== undefined) {
      await reject(request, reply);
      return;
    }
    const authorization = singleHeader(request.headers.authorization);
    const match = authorization === undefined ? null : /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) {
      await reject(request, reply);
      return;
    }
    try {
      jwtContext.set(request, await verifyAccessToken(match[1]!, options.jwtSecret, now()));
    } catch {
      await reject(request, reply);
    }
  }

  const selectOrganization = createSelectOrganizationService({
    repository: options.repository,
    jwtSecret: options.jwtSecret,
    refreshTokenHashSecret: options.refreshTokenHashSecret,
    rateLimitStore: options.rateLimitStore,
    ipRateLimitHmacSecret: options.ipRateLimitHmacSecret,
    identityRateLimitHmacSecret: options.identityRateLimitHmacSecret,
    writeSecurityAudit: options.writeSecurityAudit,
    writeOrganizationSelectedAudit: options.writeOrganizationSelectedAudit,
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    ...(options.randomUuid ? { randomUuid: options.randomUuid } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.progressiveDelay ? { progressiveDelay: options.progressiveDelay } : {}),
    ...(options.sleeper ? { sleeper: options.sleeper } : {}),
  });
  const refreshSession = createRefreshSessionService({
    repository: options.repository,
    jwtSecret: options.jwtSecret,
    refreshTokenHashSecret: options.refreshTokenHashSecret,
    writeSecurityAudit: options.writeSecurityAudit,
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    ...(options.randomUuid ? { randomUuid: options.randomUuid } : {}),
  });
  const logout = createLogoutService({
    repository: options.repository,
    refreshTokenHashSecret: options.refreshTokenHashSecret,
    writeSecurityAudit: options.writeSecurityAudit,
    ...(options.now ? { now: options.now } : {}),
  });
  const browserSession = createBrowserSessionService({
    repository: options.repository,
    jwtSecret: options.jwtSecret,
    refreshTokenHashSecret: options.refreshTokenHashSecret,
    selectOrganization,
    refreshSession,
    logout,
    writeSecurityAudit: options.writeSecurityAudit,
    writeOrganizationSelectedAudit: options.writeOrganizationSelectedAudit,
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
    ...(options.randomUuid ? { randomUuid: options.randomUuid } : {}),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BrowserSessionPreservedError) {
      return reply.code(error.statusCode).type(PROBLEM_CONTENT_TYPE).send({
        ...genericProblem(request.id, error.statusCode),
        code: error.code,
        title: 'Organization switch failed',
      });
    }
    if (error instanceof AuthServiceError) {
      if (request.url !== '/v1/console/auth/select-organization') {
        if (!(error instanceof BrowserSessionSourceMismatchError)) {
          clearSessionCookies(reply);
        }
      }
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply.code(error.statusCode).type(PROBLEM_CONTENT_TYPE).send({
        ...genericProblem(request.id, error.statusCode === 401 ? 401 : error.statusCode),
        code: error.code,
        title: error.statusCode === 401
          ? 'Authentication failed'
          : 'Authentication temporarily unavailable',
      });
    }
    const candidate = error as { statusCode?: unknown; validation?: unknown };
    const statusCode = candidate.validation !== undefined
      ? 400
      : typeof candidate.statusCode === 'number'
        && candidate.statusCode >= 400
        && candidate.statusCode < 500
        ? candidate.statusCode
        : null;
    if (statusCode !== null) {
      return reply.code(statusCode).type(PROBLEM_CONTENT_TYPE).send(
        genericProblem(request.id, statusCode),
      );
    }
    request.log.error({ err: error }, 'console authentication request failed');
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send({
      type: 'about:blank',
      title: 'Request failed',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: request.id,
    });
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/v1/console/auth/select-organization', {
    onRequest: [exactOriginGuard],
    schema: {
      security: [],
      body: ConsoleSelectOrganizationRequestSchema,
      response: {
        200: ConsoleSessionResponseSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        429: ProblemDetailsSchema,
        503: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const result = await browserSession.select({
      ...request.body,
      requestId: request.id,
      ipAddress: clientIpFrom(request, options.trustedProxyCidrs),
    });
    setSessionCookies(reply, result.refreshToken);
    return result.response;
  });

  typed.post('/v1/console/auth/restore', {
    onRequest: [exactOriginGuard, cookieAndCsrfGuard],
    schema: {
      security: [{ refreshCookieAuth: [], csrfHeaderAuth: [] }],
      response: {
        200: ConsoleSessionResponseSchema,
        401: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const context = cookieContext.get(request);
    if (!context) throw new AuthServiceError('INVALID_SESSION', 401);
    const result = await browserSession.restore(context.refreshToken, request.id);
    setSessionCookies(reply, result.refreshToken);
    return result.response;
  });

  typed.post('/v1/console/auth/switch-organization', {
    onRequest: [exactOriginGuard, cookieAndCsrfGuard, jwtOnlyGuard],
    schema: {
      security: [{ bearerAuth: [], refreshCookieAuth: [], csrfHeaderAuth: [] }],
      body: ConsoleSwitchOrganizationRequestSchema,
      response: {
        200: ConsoleSessionResponseSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        409: ConsoleOrganizationSwitchRejectedProblemSchema,
      },
    },
  }, async (request, reply) => {
    const cookie = cookieContext.get(request);
    const jwt = jwtContext.get(request);
    if (!cookie || !jwt) throw new AuthServiceError('INVALID_SESSION', 401);
    const result = await browserSession.switchOrganization({
      rawRefreshToken: cookie.refreshToken,
      authenticatedUserId: jwt.sub,
      authenticatedOrganizationId: jwt.organization_id,
      targetOrganizationId: request.body.organizationId,
      requestId: request.id,
    });
    setSessionCookies(reply, result.refreshToken);
    return result.response;
  });

  typed.post('/v1/console/auth/logout', {
    onRequest: [exactOriginGuard, optionalLogoutCookieGuard],
    schema: {
      security: [{ refreshCookieAuth: [], csrfHeaderAuth: [] }, {}],
      response: {
        204: z.undefined(),
        401: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const context = cookieContext.get(request);
    if (context) await browserSession.logout(context.refreshToken, request.id);
    clearSessionCookies(reply);
    return reply.code(204).send(undefined);
  });
}
