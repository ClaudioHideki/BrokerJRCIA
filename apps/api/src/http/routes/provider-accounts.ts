import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  ListProviderAccountsQuerySchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  ProviderAccountPageSchema,
} from '@jrc/contracts';

import {
  ProviderAccountServiceError,
  type ProviderAccountService,
} from '../../modules/provider-accounts/service.js';
import { authenticateRequest, type AuthenticatedApiKey } from '../plugins/authentication.js';
import { requirePermission } from '../plugins/authorization.js';

export interface ProviderAccountRouteOptions {
  jwtSecret: string;
  authenticateApiKey(rawApiKey: string): Promise<AuthenticatedApiKey | null>;
  service: ProviderAccountService;
}

function organizationId(request: FastifyRequest): string {
  if (!request.authentication) throw new Error('Authentication context is unavailable');
  return request.authentication.organizationId;
}

function problem(status: number, code: string, title: string, requestId: string) {
  return { type: 'about:blank', title, status, code, requestId };
}

export async function registerProviderAccountRoutes(
  app: FastifyInstance,
  options: ProviderAccountRouteOptions,
): Promise<void> {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const tenantProblem = tenantOperationalProblem(error, request.id);
    if (tenantProblem) return reply.code(tenantProblem.status).type(PROBLEM_CONTENT_TYPE).send(tenantProblem);
    if (error instanceof ProviderAccountServiceError) {
      const notFound = error.status === 404;
      return reply.code(error.status).type(PROBLEM_CONTENT_TYPE).send(problem(
        error.status,
        notFound ? 'NOT_FOUND' : error.code,
        notFound ? 'Resource not found' : 'Invalid request',
        request.id,
      ));
    }
    const candidate = error as { validation?: unknown; statusCode?: unknown };
    const status = candidate.validation !== undefined
      ? 400
      : typeof candidate.statusCode === 'number'
        && candidate.statusCode >= 400
        && candidate.statusCode < 500
        ? candidate.statusCode
        : null;
    if (status !== null) {
      return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(
        problem(status, 'INVALID_REQUEST', 'Invalid request', request.id),
      );
    }
    request.log.error({ err: error }, 'Provider account request failed');
    return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(
      problem(500, 'INTERNAL_ERROR', 'Request failed', request.id),
    );
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/v1/provider-accounts', {
    preHandler: [
      authenticateRequest({
        jwtSecret: options.jwtSecret,
        authenticateApiKey: options.authenticateApiKey,
      }),
      requirePermission('instances:read'),
    ],
    schema: {
      querystring: ListProviderAccountsQuerySchema,
      response: {
        200: ProviderAccountPageSchema,
        400: ProblemDetailsSchema,
        401: ProblemDetailsSchema,
        403: ProblemDetailsSchema,
        404: ProblemDetailsSchema,
      },
    },
  }, async (request) => options.service.listProviderAccounts(
    organizationId(request),
    {
      limit: request.query.limit,
      ...(request.query.provider === undefined ? {} : { provider: request.query.provider }),
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
    },
  ));
}
