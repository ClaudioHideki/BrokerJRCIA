import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  AuthTokensSchema,
  LoginOrganizationsSchema,
  LoginRequestSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  RefreshRequestSchema,
  SelectOrganizationRequestSchema,
} from '@jrc/contracts';
import type { PasswordVerifier, RandomBytesSource } from '@jrc/security';

import {
  AuthServiceError,
  createLoginService,
  type WriteSecurityAudit,
} from '../../modules/auth/login.js';
import type { AuthRepository } from '../../modules/auth/repository.js';
import type { AuthSessionRepository } from '../../modules/auth/repository.js';
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

export interface AuthRouteOptions {
  nodeEnv: 'development' | 'test' | 'production';
  repository: AuthRepository & AuthSessionRepository;
  rateLimitStore: RateLimitStore;
  getPasswordVerifier(): PasswordVerifier;
  writeSecurityAudit: WriteSecurityAudit;
  writeOrganizationSelectedAudit(event: OrganizationSelectedAuditEvent): Promise<void>;
  ipRateLimitHmacSecret: string;
  identityRateLimitHmacSecret: string;
  jwtSecret: string;
  refreshTokenHashSecret: string;
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

function problemFor(error: AuthServiceError, requestId: string) {
  const title = error.code === 'INVALID_CREDENTIALS' || error.code === 'INVALID_SESSION'
    ? 'Authentication failed'
    : 'Authentication temporarily unavailable';
  return {
    type: 'about:blank',
    title,
    status: error.statusCode,
    code: error.code,
    requestId,
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  assertRuntimeRateLimitStore(options.rateLimitStore, options.nodeEnv);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const candidate = error as { statusCode?: unknown; validation?: unknown };
    const statusCode = candidate.validation !== undefined
      ? 400
      : typeof candidate.statusCode === 'number'
        && candidate.statusCode >= 400
        && candidate.statusCode < 500
        ? candidate.statusCode
        : null;
    if (statusCode !== null) {
      return reply.code(statusCode).type(PROBLEM_CONTENT_TYPE).send({
        type: 'about:blank',
        title: 'Invalid request',
        status: statusCode,
        code: 'INVALID_REQUEST',
        requestId,
      });
    }
    request.log.error({ err: error }, 'authentication request failed');
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send({
      type: 'about:blank',
      title: 'Request failed',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId,
    });
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
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

  typed.post('/v1/auth/login', {
    schema: {
      body: LoginRequestSchema,
      response: {
        200: LoginOrganizationsSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        429: ProblemDetailsSchema,
        503: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const requestId = request.id;
    try {
      const login = createLoginService({
        repository: options.repository,
        passwordVerifier: options.getPasswordVerifier(),
        rateLimitStore: options.rateLimitStore,
        writeSecurityAudit: options.writeSecurityAudit,
        ipRateLimitHmacSecret: options.ipRateLimitHmacSecret,
        identityRateLimitHmacSecret: options.identityRateLimitHmacSecret,
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
        ...(options.progressiveDelay ? { progressiveDelay: options.progressiveDelay } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
        ...(options.sleeper ? { sleeper: options.sleeper } : {}),
      });
      return await login({
        ...request.body,
        requestId,
        ipAddress: clientIpFrom(request, options.trustedProxyCidrs),
      });
    } catch (error) {
      if (!(error instanceof AuthServiceError)) throw error;
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply
        .code(error.statusCode)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemFor(error, requestId));
    }
  });

  typed.post('/v1/auth/select-organization', {
    schema: {
      body: SelectOrganizationRequestSchema,
      response: {
        200: AuthTokensSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        429: ProblemDetailsSchema,
        503: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const requestId = request.id;
    try {
      return await selectOrganization({
        ...request.body,
        requestId,
        ipAddress: clientIpFrom(request, options.trustedProxyCidrs),
      });
    } catch (error) {
      if (!(error instanceof AuthServiceError)) throw error;
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return reply
        .code(error.statusCode)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemFor(error, requestId));
    }
  });

  typed.post('/v1/auth/refresh', {
    schema: {
      body: RefreshRequestSchema,
      response: {
        200: AuthTokensSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const requestId = request.id;
    try {
      return await refreshSession(request.body.refreshToken, requestId);
    } catch (error) {
      if (!(error instanceof AuthServiceError)) throw error;
      if (error.code !== 'INVALID_SESSION') throw error;
      return reply
        .code(401)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemFor(error, requestId));
    }
  });

  typed.post('/v1/auth/logout', {
    schema: {
      body: RefreshRequestSchema,
      response: {
        204: z.undefined(),
        400: ProblemDetailsSchema,
      },
    },
  }, async (request, reply) => {
    const requestId = request.id;
    await logout(request.body.refreshToken, requestId);
    return reply.code(204).send(undefined);
  });
}
